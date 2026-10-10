'use strict';
// mpv controller.
//
// Two transports, chosen automatically at first playback:
//   * 'ipc'   – one long-lived mpv.exe driven over its Windows named-pipe IPC
//               (playlist, pause/seek/volume, live position). Preferred.
//   * 'spawn' – one mpv.exe per item with --sub-files-append, used when named
//               pipes are unavailable (some sandboxes block them).
//
// Both transports receive either the direct WebDAV URL or the local /stream
// proxy URL, plus every discovered subtitle as a `sub-files-append` entry.

const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const media = require('./media');
const watchlater = require('./watchlater');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Split a settings line like: --hwdec=auto --vo="gpu next"  ->  ['--hwdec=auto', '--vo=gpu next']
function splitArgs(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(line || '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

class IpcConnection extends EventEmitter {
  constructor(pipePath) {
    super();
    this.pipePath = pipePath;
    this.socket = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.connected = false;
  }

  connect(timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.pipePath);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch {}
        reject(err);
      };
      socket.setTimeout(timeoutMs, () => fail(new Error('IPC connect timeout')));
      socket.on('connect', () => {
        if (settled) return;
        settled = true;
        socket.setTimeout(0);
        this.socket = socket;
        this.connected = true;
        this.emit('connect');
        resolve(true);
      });
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('error', (err) => {
        if (!settled) fail(err);
        else this.emit('error', err);
      });
      socket.on('close', () => {
        this.connected = false;
        this.socket = null;
        for (const [, p] of this.pending) p.reject(new Error('IPC 连接已关闭'));
        this.pending.clear();
        this.emit('close');
      });
    });
  }

  _onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.request_id !== undefined && this.pending.has(msg.request_id)) {
        const p = this.pending.get(msg.request_id);
        this.pending.delete(msg.request_id);
        if (msg.error && msg.error !== 'success') p.reject(new Error(msg.error));
        else p.resolve(msg.data);
      } else if (msg.event) {
        this.emit('event', msg);
      }
    }
  }

  send(command) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) return reject(new Error('mpv IPC 未连接'));
      const request_id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.has(request_id)) {
          this.pending.delete(request_id);
          reject(new Error('mpv IPC 命令超时'));
        }
      }, 8000);
      const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.pending.set(request_id, {
        resolve: done(resolve),
        reject: done(reject),
      });
      this.socket.write(JSON.stringify(Object.assign({ command }, { request_id })) + '\n');
    });
  }

  close() {
    try { this.socket && this.socket.destroy(); } catch {}
    this.socket = null;
    this.connected = false;
  }
}

class MpvController extends EventEmitter {
  constructor({ store }) {
    super();
    this.store = store;
    this.mode = null;            // null | 'ipc' | 'spawn'
    this.child = null;           // ipc-mode mpv process
    this.spawnChild = null;      // spawn-mode mpv process
    this.ipc = null;
    this.starting = null;
    this.pipePath = `\\\\.\\pipe\\mpv-webdav-${process.pid}`;
    this.queue = [];
    this.queuePos = -1;
    this.urlMap = new Map();
    this.lastEmit = 0;
    this.state = this._blankState();
  }

  _blankState() {
    return {
      running: false,
      idle: true,
      paused: false,
      position: 0,
      duration: 0,
      volume: (this.store && this.store.settings.volume) || 100,
      mute: false,
      mediaTitle: '',
      albumId: null,
      path: null,
      playlist: [],
      playlistPos: -1,
      subtitleCount: 0,
      subtitles: [],
      subtitleTracks: 0,
      resumedFrom: 0,
      ontop: false,
      fullscreen: false,
      error: null,
      mode: null,
      updatedAt: Date.now(),
    };
  }

  getState() {
    this.state.mode = this.mode;
    this.state.updatedAt = Date.now();
    return Object.assign({}, this.state);
  }

  emitState(force = false) {
    const now = Date.now();
    if (!force && now - this.lastEmit < 400) {
      if (!this._emitTimer) {
        this._emitTimer = setTimeout(() => {
          this._emitTimer = null;
          this.emitState(true);
        }, 400);
      }
      return;
    }
    this.lastEmit = now;
    this.emit('player', this.getState());
  }

  setError(message) {
    this.state.error = message || null;
    this.emitState(true);
  }

  mpvPath() {
    const p = (this.store.settings.mpvPath || '').trim();
    return p;
  }

  mpvExists() {
    const p = this.mpvPath();
    try { return !!p && fs.existsSync(p); } catch { return false; }
  }

  // 进度交给 mpv 自己记：把它的 watch-later 目录**重定向**到我们的 data/cache 下，
  // 而不是禁用。这样：
  //   · 我们不再需要自己维护进度状态机（"看完没 / 什么时候存" 全由 mpv 决定）
  //   · 仍然与"用户直接用 mpv 打开文件"完全隔离：两边读写的是不同目录，键也不同
  //     （我们是 http 流地址，外部是本地路径）
  // 只记 start（进度），不记音量/音轨等 50 多项，行为可预期。
  watchLaterArgs() {
    return [
      '--watch-later-directory=' + this.store.watchLaterDir,
      '--watch-later-options=start',
      '--save-position-on-quit=yes',
      '--write-filename-in-watch-later-config=yes',
    ];
  }

  // 让 mpv 立刻把当前位置写进 watch-later。
  // 必须显式调用的场合：切换文件（实测 loadfile replace 不会保存上一个文件的进度）、
  // 停止、应用退出。暂停/关窗口 mpv 自己会存，这里只是双保险（幂等）。
  async savePosition() {
    if (this.mode !== 'ipc' || !this.ipc || !this.ipc.connected) return false;
    if (!this.state.running || this.state.idle) return false;
    try {
      await this.ipc.send(['write-watch-later-config']);
      return true;
    } catch {
      return false;
    }
  }

  // 播放中按设置给 mpv 开「置顶 / 自动全屏」；空闲时一律取消（空窗口不该盖住桌面）。
  // 只做「授予」，不在播放中强制关闭——否则用户自己按 f 全屏后，一切集就被踢出来。
  _syncWindowState() {
    if (this.mode !== 'ipc' || !this.ipc || !this.ipc.connected) return;
    const s = this.store.settings;
    const playing = !!(this.state.running && !this.state.idle);
    if (playing) {
      if (s.mpvOntop) this.ipc.send(['set_property', 'ontop', true]).catch(() => {});
      if (s.mpvAutoFullscreen) this.ipc.send(['set_property', 'fullscreen', true]).catch(() => {});
    } else {
      this.ipc.send(['set_property', 'ontop', false]).catch(() => {});
      this.ipc.send(['set_property', 'fullscreen', false]).catch(() => {});
    }
  }

  // 设置里改了「播放时置顶 / 自动全屏」：立刻作用到正在运行的 mpv
  applySettingChange(name) {
    if (this.mode !== 'ipc' || !this.ipc || !this.ipc.connected) return;
    const s = this.store.settings;
    const playing = !!(this.state.running && !this.state.idle);
    if (name === 'mpvOntop') {
      this.ipc.send(['set_property', 'ontop', !!(s.mpvOntop && playing)]).catch(() => {});
    } else if (name === 'mpvAutoFullscreen') {
      this.ipc.send(['set_property', 'fullscreen', !!(s.mpvAutoFullscreen && playing)]).catch(() => {});
    }
  }

  // 是否"确实在播"？（探时长前确认一下，别去抢带宽和进程）
  // 暂停中、播完停住（keep-open）都不算，那些时候补探时长不会打扰用户
  isBusy() {
    if (!this.mode) return false;
    const s = this.state;
    return !!(s.running && !s.idle && !s.paused && !s.eof);
  }

  // 让 mpv 快速探一个文件的时长（只解码 1 帧就退出）。
  // 输出重定向到临时文件而不是管道：管道在受限环境里会被拒（EPERM），文件不会有这个问题。
  async probeDuration(url, timeoutMs = 25000) {
    const exe = this.mpvPath();
    if (!exe || !fs.existsSync(exe) || !url) return null;
    const tmp = path.join(os.tmpdir(), `mpv-webdav-dur-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    let fd = null;
    let child = null;
    try {
      fd = fs.openSync(tmp, 'w');
      const args = [
        '--no-config', '--vo=null', '--ao=null', '--frames=1',
        '--term-playing-msg=DUR=${duration}',
        '--no-save-position-on-quit',
        url,
      ];
      await new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        try {
          child = spawn(exe, args, { stdio: ['ignore', fd, 'ignore'], windowsHide: true });
        } catch {
          return done();
        }
        const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } done(); }, timeoutMs);
        if (timer.unref) timer.unref();
        child.on('error', () => { clearTimeout(timer); done(); });
        child.on('exit', () => { clearTimeout(timer); done(); });
      });
      const text = fs.readFileSync(tmp, 'utf8');
      const line = text.split(/\r?\n/).find((l) => l.includes('DUR='));
      return line ? watchlater.parseClock(line.replace(/.*DUR=/, '')) : null;
    } catch {
      return null;
    } finally {
      try { if (fd != null) fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  // 把键盘焦点交给 mpv 的窗口。
  //
  // 背景（都是真机对照实测）：置顶只决定窗口层级，键盘输入跟着"焦点"走；
  // 从后台进程抢焦点会被 Windows 的前台锁定拒绝：
  //   · AllowSetForegroundWindow(mpvPid) → 返回 False（它要求调用者自己就是前台进程，
  //     而前台是用户的浏览器，不是我们，所以这条路在本项目里走不通）
  //   · 单独 AppActivate / SetForegroundWindow → 无效（前台窗口不变）
  // 可用的办法有两个，优先用不闪屏的：
  //   ① focus-mpv.vbs：先模拟敲一下 ALT 破限，再 AppActivate（约 45ms，不闪屏）
  //   ② 让 mpv 自己把窗口"最小化 → 立刻还原"（mpv 激活自己的窗口系统一定允许，会闪一下）
  focusWindow() {
    if (this.store.settings.mpvFocusOnPlay === false) return Promise.resolve(false);
    if (this.mode !== 'ipc' || !this.ipc || !this.ipc.connected) return Promise.resolve(false);
    if (!this.state.running || this.state.idle) return Promise.resolve(false);
    if (!this._expectsWindow()) return Promise.resolve(false);   // 无窗口（--vo=null 等）就别白起助手进程
    const pid = this.child && this.child.pid;
    return this._focusViaHelper(pid).then((ok) => {
      if (ok) {
        console.log('[mpv] 焦点已交给 mpv 窗口（focus-mpv.ps1，不闪屏）');
        return true;
      }
      console.log('[mpv] focus-mpv.ps1 未成功，改用「最小化→还原」要焦点');
      return this._focusViaMinimize();
    });
  }

  // 这次启动的 mpv 到底有没有窗口？（--vo=null / --force-window=no 时没有，直接跳过要焦点）
  _expectsWindow() {
    const args = this.lastArgs || [];
    if (args.includes('--vo=null')) return false;
    const fw = args.find((a) => a.startsWith('--force-window='));
    if (fw && /=(no|0)$/.test(fw)) return false;
    return true;
  }

  // ① 用 focus-mpv.ps1（ALT 破限 + SetForegroundWindow + 自己校验前台窗口）
  //    优先 pwsh（启动快），没有就退回系统自带的 powershell.exe
  _focusViaHelper(pid) {
    const script = path.join(__dirname, '..', 'focus-mpv.ps1');
    if (!pid || !fs.existsSync(script)) return Promise.resolve(false);
    const shells = ['pwsh', 'powershell'];
    const tryShell = (idx) => {
      if (idx >= shells.length) return Promise.resolve(false);
      const exe = shells[idx];
      return new Promise((resolve) => {
        let child;
        try {
          // stdio 用 ignore：受限环境里管道会 EPERM，这里也本来不需要读它的输出
          child = spawn(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, String(pid)],
            { stdio: 'ignore', windowsHide: true });
        } catch {
          return resolve(false);
        }
        const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(false); }, 5000);
        child.on('error', () => { clearTimeout(timer); resolve(false); });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) return resolve(true);
          resolve(tryShell(idx + 1));            // 这个 shell 没成，换下一个再试
        });
      });
    };
    return tryShell(0);
  }

  // ② 退路：让 mpv 自己最小化再还原。
  //    不能"发完就不管"——真实播放时窗口是带着文件刚建出来的，mpv 有时来不及处理还原命令，
  //    结果窗口就停在最小化（实测踩到过）。所以每一步都读回真实状态，没还原就重试。
  async _focusViaMinimize() {
    if (!this.ipc || !this.ipc.connected) return false;
    const readMinimized = async () => {
      try {
        return await this.ipc.send(['get_property', 'window-minimized']);
      } catch {
        return null;                    // 没有窗口（例如 --vo=null）：当作无需还原
      }
    };
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.ipc.send(['set_property', 'window-minimized', true]).catch(() => {});
        await sleep(attempt === 0 ? 220 : 350);
        await this.ipc.send(['set_property', 'window-minimized', false]).catch(() => {});
        await sleep(260);
        const stillMinimized = await readMinimized();
        if (stillMinimized !== true) return true;
      }
      console.warn('[mpv] 没能把焦点交给 mpv 窗口；可以在设置里关掉“开始播放时把焦点交给 mpv”');
      return false;
    } catch {
      return false;
    }
  }

  baseArgs() {
    const s = this.store.settings;
    const args = [
      '--no-terminal',
      '--force-window=yes',
      '--keep-open=no',
      '--idle=yes',
      ...this.watchLaterArgs(),
      // 启动时（还没开始播）不要置顶也不要全屏：空窗口不该盖住桌面。
      // 真正开始播放时再用 set_property 打开，见 _syncWindowState()。
      '--ontop=no',
      '--fullscreen=no',
    ];
    if (s.alang) args.push('--alang=' + s.alang);
    if (s.slang) args.push('--slang=' + s.slang);
    if (s.volume != null) args.push('--volume=' + s.volume);
    for (const line of s.extraMpvArgs || []) args.push(...splitArgs(line));
    return args;
  }

  spawnArgsFor(item) {
    const s = this.store.settings;
    const args = [
      '--no-terminal',
      '--force-window=yes',
      '--keep-open=yes',
      ...this.watchLaterArgs(),
      // 回退模式每个进程就播一个文件，直接按设置给参数
      '--ontop=' + (s.mpvOntop ? 'yes' : 'no'),
      '--fullscreen=' + (s.mpvAutoFullscreen ? 'yes' : 'no'),
      item.url,
      '--force-media-title=' + (item.title || item.name || ''),
    ];
    if (s.alang) args.push('--alang=' + s.alang);
    if (s.slang) args.push('--slang=' + s.slang);
    if (s.volume != null) args.push('--volume=' + s.volume);
    for (const sub of item.subUrls || []) args.push('--sub-files-append=' + sub);
    for (const line of s.extraMpvArgs || []) args.push(...splitArgs(line));
    return args;
  }

  // ---- startup ------------------------------------------------------------
  async ensureStarted() {
    if (this.mode === 'ipc' && this.ipc && this.ipc.connected) return this.mode;
    if (this.mode === 'spawn') return this.mode;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      if (!this.mpvExists()) {
        this.mode = null;
        this.setError(`找不到 mpv.exe：${this.mpvPath() || '(未配置)'}。请在“设置”里填写正确路径。`);
        return null;
      }

      const mpvArgs = [...this.baseArgs(), `--input-ipc-server=${this.pipePath}`];
      this.lastArgs = mpvArgs;
      const child = spawn(this.mpvPath(), mpvArgs, {
        stdio: 'ignore',
        windowsHide: false,
      });
      child.on('error', (err) => {
        this.setError('启动 mpv 失败：' + err.message);
      });

      const ipc = new IpcConnection(this.pipePath);
      const deadline = Date.now() + 4000;
      let connected = false;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        try {
          await ipc.connect(700);
          connected = true;
          break;
        } catch {
          await sleep(150);
        }
      }

      if (!connected) {
        try { child.kill(); } catch {}
        ipc.close();
        this.mode = 'spawn';
        this.child = null;
        this.ipc = null;
        this.state.mode = 'spawn';
        this.emit('log', {
          level: 'warn',
          message: 'mpv 命名管道 IPC 不可用，已回退到“每次启动 mpv”模式（播放/字幕正常，远程控制受限）。',
        });
        this.emitState(true);
        return this.mode;
      }

      this.child = child;
      this.ipc = ipc;
      this.mode = 'ipc';
      this.state.mode = 'ipc';
      this._wireIpc(child, ipc);
      this.emit('log', { level: 'info', message: 'mpv IPC 已连接（命名管道模式）' });
      this.emitState(true);
      return this.mode;
    })().finally(() => { this.starting = null; });

    return this.starting;
  }

  _wireIpc(child, ipc) {
    ipc.on('event', (msg) => this._onIpcEvent(msg));
    ipc.on('close', () => {
      if (this.mode !== 'ipc') return;
      this.state.running = false;
      this.state.idle = true;
      this.state.paused = false;
      this.state.position = 0;
      // 关掉 mpv 窗口是正常操作，不必在网页上弹消息（只在服务端日志留一行）；
      // 前端会借这次"播放结束"的状态变化去刷新列表里的进度。
      console.log('[mpv] 窗口已关闭（进度已保存，下次播放会重新拉起）');
      this.emitState(true);
      this.child = null;
      this.ipc = null;
      this.mode = null; // re-detect on next play
    });
    child.on('exit', () => {
      if (this.mode === 'ipc' && this.ipc) {
        this.ipc.close();
      }
    });
    child.on('error', (err) => this.setError('mpv 进程错误：' + err.message));

    const props = [
      'idle-active', 'pause', 'time-pos', 'duration', 'volume', 'mute',
      'media-title', 'path', 'filename', 'playlist', 'playlist-pos', 'playlist-count',
      'eof-reached', 'keep-open', 'track-list', 'ontop', 'fullscreen',
    ];
    props.forEach((name, i) => {
      ipc.send(['observe_property', i + 1, name]).catch(() => {});
    });
  }

  _onIpcEvent(msg) {
    const s = this.state;
    switch (msg.event) {
      case 'property-change': {
        switch (msg.name) {
          case 'idle-active':
            s.idle = !!msg.data;
            // 只在「变成空闲」时同步窗口状态；开始播放交给 start-file 处理
            if (s.idle) { s.running = false; s.position = 0; this._syncWindowState(); }
            break;
          case 'pause':
            s.paused = !!msg.data;
            break;
          case 'time-pos':
            // 重新加载文件的瞬间 mpv 会把这个属性报成 null：
            // 不能当成 0，否则界面进度条会"跳回起点"（真正的归零由 stop/idle 显式处理）
            if (typeof msg.data === 'number') s.position = msg.data;
            break;
          case 'eof-reached':
            s.eof = !!msg.data;
            break;
          case 'duration':
            if (typeof msg.data === 'number') {
              s.duration = msg.data;
              // 交给 index.js 记进"时长缓存"（列表里的进度条需要总时长，mpv 自己只存已看秒数）
              if (msg.data > 0 && s.path) {
                this.emit('duration', { albumId: s.albumId, path: s.path, duration: msg.data });
              }
            }
            break;
          case 'volume':
            s.volume = typeof msg.data === 'number' ? Math.round(msg.data) : s.volume;
            break;
          case 'mute':
            s.mute = !!msg.data;
            break;
          case 'media-title':
            s.mediaTitle = msg.data ? String(msg.data) : s.mediaTitle;
            break;
          case 'path':
            this._applyPath(msg.data ? String(msg.data) : null);
            break;
          case 'playlist':
            this._applyPlaylist(msg.data);
            break;
          case 'playlist-pos':
            s.playlistPos = typeof msg.data === 'number' ? msg.data : -1;
            this._syncPlaylistFlags();
            break;
          case 'track-list':
            s.subtitleTracks = Array.isArray(msg.data)
              ? msg.data.filter((t) => t && t.type === 'sub' && !t.dependent).length
              : 0;
            break;
          case 'ontop':
            s.ontop = !!msg.data;
            break;
          case 'fullscreen':
            s.fullscreen = !!msg.data;
            break;
          default:
            break;
        }
        break;
      }
      case 'start-file':
        s.running = true;
        s.idle = false;
        s.eof = false;
        this._syncWindowState();
        break;
      case 'file-loaded':
        s.running = true;
        s.idle = false;
        s.error = null;
        this._syncWindowState();
        break;
      case 'end-file':
        if (msg.reason === 'error') {
          this.setError('mpv 无法播放该文件（格式不支持或网络错误）');
        }
        break;
      case 'idle':
        s.idle = true;
        s.running = false;
        this._syncWindowState();
        break;
      default:
        break;
    }
    this.emitState();
  }

  _applyPath(url) {
    if (!url) return;
    const item = this._findItemByUrl(url);
    if (item) {
      // 换了文件：进度/时长归零交给这里显式处理（time-pos 报 null 时我们不再清零）
      if (this.state.path && this.state.path !== item.path) {
        this.state.position = 0;
        this.state.duration = 0;
      }
      this.state.albumId = item.albumId;
      this.state.path = item.path;
      this.state.mediaTitle = item.title || item.name || this.state.mediaTitle;
      this.state.subtitles = (item.subNames || []).slice();
      this.state.subtitleCount = this.state.subtitles.length;
    } else {
      this.state.mediaTitle = url.split('/').pop() || url;
      // 对应不回专辑文件时，续播记录会一直停在上一部片子上——把线索写进日志
      this.emit('log', {
        level: 'warn',
        message: '无法把 mpv 当前播放地址对应回专辑文件（进度不会记录）：' + String(url).slice(0, 140),
      });
    }
    this.emitState(true);
  }

  // mpv 回报的 path 有时与传入的 URL 在百分号编码上不一致（非 ASCII 文件名尤其常见），
  // 所以先精确匹配，再按「解码后相同」匹配一遍。
  _normalizeUrl(u) {
    if (!u) return '';
    let s = String(u);
    try { s = decodeURIComponent(s); } catch { /* 保留原样 */ }
    return s.replace(/\?.*$/, '');
  }

  _findItemByUrl(url) {
    if (!url) return null;
    const exact = this.urlMap.get(url);
    if (exact) return exact;
    const target = this._normalizeUrl(url);
    if (!target) return null;
    for (const [key, item] of this.urlMap) {
      if (this._normalizeUrl(key) === target) return item;
    }
    return null;
  }

  _applyPlaylist(list) {
    if (!Array.isArray(list)) return;
    const items = list.map((entry, index) => {
      const url = entry && entry.filename ? String(entry.filename) : '';
      const mapped = this._findItemByUrl(url);
      return {
        index,
        title: (mapped && (mapped.title || mapped.name)) || (entry && entry.title) || (url ? url.split('/').pop() : ''),
        path: mapped ? mapped.path : url,
        albumId: mapped ? mapped.albumId : null,
        playing: !!(entry && entry.current),
      };
    });
    this.state.playlist = items;
    this._syncPlaylistFlags();
  }

  _syncPlaylistFlags() {
    const pos = this.state.playlistPos;
    this.state.playlist.forEach((it, i) => { it.playing = i === pos; });
    const current = this.state.playlist[pos];
    if (current) {
      const item = this._itemForPlaylistIndex(pos);
      if (item) {
        this.state.albumId = item.albumId;
        this.state.path = item.path;
        this.state.mediaTitle = item.title || item.name || current.title;
        this.state.subtitles = (item.subNames || []).slice();
        this.state.subtitleCount = this.state.subtitles.length;
      }
    }
  }

  _itemForPlaylistIndex(index) {
    const entry = this.state.playlist[index];
    if (!entry) return null;
    for (const item of this.urlMap.values()) {
      if (item.path === entry.path && item.albumId === entry.albumId) return item;
    }
    return null;
  }

  // ---- playback -----------------------------------------------------------
  // item: { albumId, path, name, title, url, subUrls: [], subNames: [] }
  async play(items, { mode = 'replace' } = {}) {
    const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
    if (!list.length) throw new Error('没有可播放的文件');

    const transport = await this.ensureStarted();
    if (!transport) throw new Error(this.state.error || 'mpv 不可用');

    for (const item of list) this.urlMap.set(item.url, item);

    if (mode === 'append') {
      this.queue.push(...list);
      // 追加后立刻刷新界面上的播放列表（回退模式不会走 mpv 的 playlist 事件）
      this.state.playlistPos = this.queuePos;
      this.state.playlist = this.queue.map((it, i) => ({
        index: i,
        title: it.title || it.name,
        path: it.path,
        albumId: it.albumId,
        playing: i === this.queuePos,
      }));
    } else {
      this.queue = list.slice();
      this.queuePos = 0;
    }

    const first = list[0];
    this.state.error = null;
    this.state.subtitleTracks = 0;

    if (transport === 'ipc') {
      // 切换文件前先让 mpv 把**上一个文件**的进度存下来。
      // 实测：loadfile replace 不会触发保存，不主动存就会丢掉上一集的进度。
      if (mode !== 'append' && this.state.running && !this.state.idle && this.state.path !== first.path) {
        await this.savePosition();
      }
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        const flags = mode === 'append' ? 'append' : (i === 0 ? 'replace' : 'append');
        await this._loadfile(item, flags);
      }
      if (mode !== 'append') {
        await this.ipc.send(['set_property', 'playlist-pos', 0]).catch(() => {});
        // 窗口通常是 loadfile 之后才出现：稍等一下再把键盘焦点要过来，
        // 这样用户在网页里按下播放后，直接按空格就能暂停（不用先点一下 mpv）
        const t = setTimeout(() => { this.focusWindow().catch(() => {}); }, 350);
        if (t.unref) t.unref();
      }
    } else {
      if (mode === 'append') {
        // 回退模式：只入队，不要重启当前正在播的那个进程
        this.emit('log', { level: 'info', message: '已加入播放列表（回退模式：点击“下一首”逐条播放）' });
      } else {
        this.queuePos = 0;
        this._playSpawnItem(this.queuePos);
      }
    }

    // 只有「替换播放」才改变"当前在播的是谁"。
    // 追加到播放列表时绝不能把状态改成被追加的那一条——否则玩家状态（以及续播记录）
    // 会指向最后一个追加项，而实际在播的还是原来那个（剧集目录最容易踩到）。
    if (mode !== 'append') {
      this.state.subtitles = (first.subNames || []).slice();
      this.state.subtitleCount = this.state.subtitles.length;
      this.state.albumId = first.albumId;
      this.state.path = first.path;
      this.state.mediaTitle = first.title || first.name;
      this.state.resumedFrom = Number.isFinite(first.start) && first.start >= 0 ? first.start : 0;
      this.state.running = true;
      this.state.idle = false;
      // 立刻按"我们刚交给 mpv 的列表"填充播放列表：
      // 否则 IPC 模式下要等 mpv 的 playlist 事件回来，接口响应里会短暂是空的（连播时最明显）
      this.state.playlistPos = 0;
      this.state.playlist = this.queue.map((it, i) => ({
        index: i,
        title: it.title || it.name,
        path: it.path,
        albumId: it.albumId,
        playing: i === 0,
      }));
    }
    this.emitState(true);
    return this.getState();
  }

  async _loadfile(item, flags) {
    const urls = (item.subUrls || []).slice();
    const title = item.title || item.name || '';
    const startAt = Number.isFinite(item.start) && item.start >= 0 ? item.start : null;
    const attempts = this._buildLoadAttempts(item.url, flags, urls, title, startAt);
    const start = this.subStrategy == null ? 0 : Math.min(this.subStrategy, attempts.length - 1);

    for (let i = start; i < attempts.length; i++) {
      try {
        await attempts[i].run();
      } catch {
        continue; // 该写法不被这个 mpv 版本接受，试下一个
      }
      if (!urls.length) return;
      if (this.subStrategy === i) return;      // 已验证过的写法
      if (flags !== 'replace') return;         // 只在首个文件上做校验
      const tracks = await this._countSubtitleTracks(2500);
      if (tracks > 0) {
        this.subStrategy = i;
        this.state.subtitleTracks = tracks;
        this.emit('log', { level: 'info', message: `mpv 已自动挂载 ${tracks} 条外挂字幕（通道 ${i + 1}/${attempts.length}）` });
        return;
      }
      // 命令没报错但字幕没进去：换下一种写法重载（每个会话最多发生一次）
    }

    if (urls.length) {
      this.emit('log', {
        level: 'warn',
        message: '没能让 mpv 自动挂载外挂字幕；可在 mpv 里按 j 手动选择，或把“附加 mpv 参数”设置为 --sub-auto=fuzzy。',
      });
    }
  }

  // mpv versions differ in how loadfile accepts the per-file options argument,
  // so build several equivalent spellings and keep the first one that works.
  _buildLoadAttempts(url, flags, subUrls, title, startAt = null) {
    const listSep = process.platform === 'win32' ? ';' : ':';
    const titleOpts = title ? { 'force-media-title': title } : {};
    // 续播位置：key/value list 的值必须是字符串，数字会被判为类型不符
    if (startAt != null) titleOpts.start = startAt.toFixed(3);   // 0 也要显式传：用来压过 watch-later（从头播放）
    const attempts = [];

    if (subUrls.length) {
      // 1) options map with one string value (path lists are ;-separated on Windows)
      attempts.push({
        run: () => this.ipc.send(['loadfile', url, flags, -1,
          Object.assign({}, titleOpts, { 'sub-files': subUrls.join(listSep) })]),
      });
      // 2) change-list on the string-list option, then a plain loadfile
      attempts.push({
        run: async () => {
          await this.ipc.send(['change-list', 'sub-files', 'clr']).catch(() => {});
          for (const sub of subUrls) {
            await this.ipc.send(['change-list', 'sub-files', 'append', sub]);
          }
          if (title) await this.ipc.send(['set_property', 'force-media-title', title]).catch(() => {});
          await this.ipc.send(['loadfile', url, flags, -1]);
          // set_property start 不一定存在，退而求其次：加载后绝对跳转
          if (startAt) {
            await this.ipc.send(['seek', startAt, 'absolute']).catch(() => {});
          }
        },
      });
      // 3) options argument as a plain string (legacy key/value syntax)
      attempts.push({
        run: () => this.ipc.send(['loadfile', url, flags, -1,
          [`sub-files=${subUrls.join(listSep)}`]
            .concat(Object.entries(titleOpts).map(([k, v]) => `${k}=${v}`)).join(',')]),
      });
    }

    // 4) last resort: no per-file options at all
    attempts.push({
      run: async () => {
        if (title) await this.ipc.send(['set_property', 'force-media-title', title]).catch(() => {});
        if (subUrls.length) {
          await this.ipc.send(['loadfile', url, flags, -1]);
        } else {
          await this.ipc.send(['loadfile', url, flags, -1, titleOpts]);
        }
        if (startAt) await this.ipc.send(['seek', startAt, 'absolute']).catch(() => {});
      },
    });

    return attempts;
  }

  // How many subtitle tracks does mpv actually have for the current file?
  async _countSubtitleTracks(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const tracks = await this.ipc.send(['get_property', 'track-list']);
        if (Array.isArray(tracks)) {
          const n = tracks.filter((t) => t && t.type === 'sub' && !t.dependent).length;
          if (n > 0) return n;
        }
      } catch { /* mpv busy */ }
      await sleep(150);
    }
    return 0;
  }

  _playSpawnItem(index) {
    const item = this.queue[index];
    if (!item) return;
    if (this.spawnChild) {
      try { this.spawnChild.kill(); } catch {}
      this.spawnChild = null;
    }
    const child = spawn(this.mpvPath(), this.spawnArgsFor(item), { stdio: 'ignore', windowsHide: false });
    this.spawnChild = child;
    this.queuePos = index;
    child.on('error', (err) => this.setError('启动 mpv 失败：' + err.message));
    child.on('exit', () => {
      if (this.spawnChild === child) this.spawnChild = null;
      this.state.running = false;
      this.state.idle = true;
      this.state.paused = false;
      this.state.position = 0;
      this.emitState(true);
    });
    this.state.running = true;
    this.state.idle = false;
    this.state.paused = false;
    this.state.position = 0;
    this.state.duration = 0;
    this.state.albumId = item.albumId;
    this.state.path = item.path;
    this.state.mediaTitle = item.title || item.name;
    this.state.subtitles = (item.subNames || []).slice();
    this.state.subtitleCount = this.state.subtitles.length;
    this.state.resumedFrom = Number.isFinite(item.start) && item.start > 0 ? item.start : 0;
    this.state.playlistPos = index;
    this.state.playlist = this.queue.map((it, i) => ({
      index: i, title: it.title || it.name, path: it.path, albumId: it.albumId, playing: i === index,
    }));
    this.emitState(true);
  }

  async command(action, value) {
    const transport = this.mode;
    const ipcCommand = async (cmd) => {
      await this.ensureStarted();
      if (this.mode !== 'ipc') throw new Error('当前为回退模式，该控制不可用');
      return this.ipc.send(cmd);
    };

    switch (action) {
      case 'pause':
        return this._after(await ipcCommand(['set_property', 'pause', true]));
      case 'resume':
        return this._after(await ipcCommand(['set_property', 'pause', false]));
      case 'toggle':
        return this._after(await ipcCommand(['cycle', 'pause']));
      case 'stop':
        if (transport === 'ipc') {
          await this.savePosition();          // 停下之前先把进度交给 mpv 存好
          await ipcCommand(['stop']);
        } else {
          if (this.spawnChild) { try { this.spawnChild.kill(); } catch {} this.spawnChild = null; }
          this.state.running = false;
          this.state.idle = true;
          this.state.paused = false;
        }
        this.emitState(true);
        return this.getState();
      case 'seek': {
        const pos = Math.max(0, Number(value) || 0);
        if (transport === 'ipc') await ipcCommand(['seek', pos, 'absolute']);
        else throw new Error('当前为回退模式，无法拖动进度');
        this.state.position = pos;
        this.emitState(true);
        return this.getState();
      }
      case 'seek-relative': {
        if (transport === 'ipc') await ipcCommand(['seek', Number(value) || 0, 'relative']);
        else throw new Error('当前为回退模式，无法快进/快退');
        return this.getState();
      }
      case 'volume': {
        const vol = Math.min(150, Math.max(0, Math.round(Number(value) || 0)));
        if (transport === 'ipc') await ipcCommand(['set_property', 'volume', vol]);
        this.state.volume = vol;
        this.emitState(true);
        return this.getState();
      }
      case 'mute': {
        const next = value === undefined ? !this.state.mute : !!value;
        if (transport === 'ipc') await ipcCommand(['set_property', 'mute', next]);
        this.state.mute = next;
        this.emitState(true);
        return this.getState();
      }
      case 'next':
        return this.next();
      case 'prev':
        return this.prev();
      case 'play-index':
        return this.playIndex(parseInt(value, 10));
      default:
        throw Object.assign(new Error('未知的播放器操作：' + action), { status: 400 });
    }
  }

  _after() {
    this.emitState(true);
    return this.getState();
  }

  async playIndex(index) {
    const i = Number.isInteger(index) ? index : -1;
    if (i < 0 || i >= this.queue.length) throw Object.assign(new Error('播放列表索引无效'), { status: 400 });
    await this.ensureStarted();
    if (this.mode === 'ipc') {
      await this.ipc.send(['set_property', 'playlist-pos', i]);
      await this.ipc.send(['set_property', 'pause', false]).catch(() => {});
    } else {
      this._playSpawnItem(i);
    }
    return this.getState();
  }

  async next() {
    if (this.mode === 'ipc') {
      await this.ensureStarted();
      if (this.mode === 'ipc') await this.ipc.send(['playlist-next', 'weak']);
      this.emitState(true);
      return this.getState();
    }
    const nextIndex = this.queuePos + 1;
    if (nextIndex >= this.queue.length) return this.getState();
    this._playSpawnItem(nextIndex);
    return this.getState();
  }

  async prev() {
    if (this.mode === 'ipc') {
      await this.ensureStarted();
      if (this.mode === 'ipc') await this.ipc.send(['playlist-prev', 'weak']);
      this.emitState(true);
      return this.getState();
    }
    const prevIndex = Math.max(0, this.queuePos - 1);
    this._playSpawnItem(prevIndex);
    return this.getState();
  }

  clearQueue() {
    this.queue = [];
    this.urlMap.clear();
    this.state.playlist = [];
    this.state.playlistPos = -1;
    this.emitState(true);
  }

  async shutdown() {
    if (this.mode === 'ipc' && this.ipc) {
      try { await this.savePosition(); } catch {}   // 退出前最后一次落盘
      try { await this.ipc.send(['quit']); } catch {}
      this.ipc.close();
    }
    for (const c of [this.child, this.spawnChild]) {
      if (c) { try { c.kill(); } catch {} }
    }
    this.child = null;
    this.spawnChild = null;
  }
}

module.exports = { MpvController, splitArgs };
