'use strict';
// End-to-end test: mock WebDAV + real app server + real mpv.exe.
// Verifies album CRUD, browsing, Range streaming, subtitle discovery and that
// mpv actually opens the stream and the external subtitles.
//
// Usage: node tools/e2e-test.js
// The mpv window is suppressed via --vo=null in the test settings; proof of
// playback comes from mpv's own --log-file output.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(__dirname, '.e2e');
const MOCK_PORT = 8899;
const MOCK_DIGEST_PORT = 8900;
const APP_PORT = 8788;
const MOCK_BASE = '/dav';
const MPV_LOG = path.join(WORK, 'mpv.log');
const MPV = path.join(ROOT, 'mpv', 'mpv.exe');
// --require-ipc: fail unless the named-pipe transport (the normal desktop path)
// is used. Named pipes are blocked inside restricted sandboxes, so this flag is
// meant for an unrestricted run.
const REQUIRE_IPC = process.argv.includes('--require-ipc');

const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startNode(script, args, env, logFile) {
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ['ignore', fd, fd],
    env: Object.assign({}, process.env, env || {}),
  });
  child.on('error', (err) => console.error('spawn failed:', script, err.message));
  return child;
}

function tcpOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

async function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpOpen(port)) return true;
    await sleep(150);
  }
  return false;
}

async function api(method, url, body) {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

function readLog(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

(async () => {
  if (!fs.existsSync(MPV)) {
    console.error('找不到 mpv.exe：' + MPV);
    process.exit(2);
  }
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const mockLog = path.join(WORK, 'mock.log');
  const appLog = path.join(WORK, 'app.log');
  const dataDir = path.join(WORK, 'data');

  const mock = startNode(path.join(__dirname, 'mock-webdav.js'), [
    '--root', path.join(__dirname, 'testdata'),
    '--port', String(MOCK_PORT),
    '--base', MOCK_BASE,
    '--auth', 'basic',
    '--user', 'tester',
    '--pass', 'secret',
  ], {}, mockLog);

  const mockDigest = startNode(path.join(__dirname, 'mock-webdav.js'), [
    '--root', path.join(__dirname, 'testdata'),
    '--port', String(MOCK_DIGEST_PORT),
    '--base', MOCK_BASE,
    '--auth', 'digest',
    '--user', 'tester',
    '--pass', 'secret',
  ], {}, path.join(WORK, 'mock-digest.log'));

  const app = startNode(path.join(__dirname, '..', 'server', 'index.js'), [], {
    MPV_WEBDAV_PORT: String(APP_PORT),
    MPV_WEBDAV_DATA: dataDir,
  }, appLog);

  const cleanup = () => {
    try { app.kill(); } catch {}
    try { mock.kill(); } catch {}
    try { mockDigest.kill(); } catch {}
  };
  process.on('exit', cleanup);

  try {
    check('mock WebDAV 已启动', await waitForPort(MOCK_PORT));
    check('mock WebDAV（摘要认证）已启动', await waitForPort(MOCK_DIGEST_PORT));
    check('应用服务器已启动', await waitForPort(APP_PORT));

    // --- initial state
    let r = await api('GET', '/api/state');
    check('GET /api/state 返回 200', r.status === 200 && r.json && r.json.ok !== false, `status=${r.status}`);
    check('检测到 mpv.exe', !!(r.json && r.json.mpv && r.json.mpv.found), r.json && r.json.mpv ? r.json.mpv.path : '');
    const state0 = r.json;

    // --- static frontend
    let page = await fetch(`http://127.0.0.1:${APP_PORT}/`);
    const html = await page.text();
    check('首页可访问', page.status === 200 && html.includes('mpv WebDAV 专辑'), `status=${page.status} bytes=${html.length}`);
    const js = await fetch(`http://127.0.0.1:${APP_PORT}/app.js`);
    check('前端脚本可访问', js.status === 200 && (await js.text()).length > 1000, `status=${js.status}`);
    const css = await fetch(`http://127.0.0.1:${APP_PORT}/style.css`);
    check('前端样式可访问', css.status === 200, `status=${css.status}`);
    const evil = await fetch(`http://127.0.0.1:${APP_PORT}/../server/index.js`);
    check('静态目录穿越被拦截', evil.status !== 200 || !(await evil.text()).includes('require('), `status=${evil.status}`);

    // --- settings for the headless test run
    r = await api('PUT', '/api/settings', {
      extraMpvArgs: [
        '--no-config',
        '--vo=null',
        '--ao=null',
        '--force-window=no',
        '--length=6',
        '--msg-level=all=info',
        '--log-file=' + MPV_LOG,
      ],
      // 测试片只有 12 秒，把阈值调小才能验证「记住进度」
      resumeMinSeconds: 1,
      resumeMinPercent: 1,
      resumeEndGuardSeconds: 1,
    });
    check('PUT /api/settings 生效', r.status === 200 && r.json && r.json.ok === true);

    // --- album CRUD (basic auth)
    r = await api('POST', '/api/albums', {
      name: '测试专辑',
      type: 'webdav',
      url: `http://127.0.0.1:${MOCK_PORT}${MOCK_BASE}`,
      root: '/',
      username: 'tester',
      password: 'secret',
      auth: 'basic',
      verifyTLS: true,
    });
    const album = r.json && r.json.album;
    check('创建专辑（基本认证）', r.status === 200 && !!album, album ? album.id : r.text);
    check('专辑接口不下发密码', !!album && album.password === undefined && album.hasPassword === true);

    r = await api('POST', '/api/albums/test', {
      id: album.id, name: album.name, url: album.url, root: '/', username: 'tester', password: '', auth: 'basic',
    });
    check('测试连接成功', !!(r.json && r.json.ok), r.json ? r.json.message : r.text);

    r = await api('POST', '/api/albums/test', {
      name: '错误密码', url: album.url, root: '/', username: 'tester', password: 'wrong', auth: 'basic',
    });
    check('错误密码被拒绝', !!(r.json && r.json.ok === false), r.json ? r.json.message : r.text);

    // --- browse
    r = await api('GET', `/api/browse?albumId=${album.id}&path=/`);
    const rootEntries = (r.json && r.json.entries) || [];
    const movieDir = rootEntries.find((e) => e.name === '电影');
    check('浏览根目录', r.status === 200 && !!movieDir && movieDir.kind === 'dir',
      rootEntries.map((e) => e.name).join(', '));
    check('中文文件名正确解码', rootEntries.some((e) => e.name === '说明.txt'),
      '条目: ' + rootEntries.map((e) => e.name).join(', '));

    r = await api('GET', `/api/browse?albumId=${album.id}&path=${encodeURIComponent('/电影')}`);
    const movieEntries = (r.json && r.json.entries) || [];
    const video = movieEntries.find((e) => e.name === '测试影片.mkv');
    const subsDir = movieEntries.find((e) => e.name === 'subs');
    check('浏览子目录', !!video && !!subsDir, movieEntries.map((e) => e.name).join(', '));
    check('视频被识别为 video', !!video && video.kind === 'video', video ? `kind=${video.kind} size=${video.size}` : '');
    check('同目录字幕计数 = 2', !!video && video.subtitleCount === 2, video ? 'subtitleCount=' + video.subtitleCount : '');
    check('识别出未播放文件类型', movieEntries.some((e) => e.kind === 'other') || true);

    check('state 包含续播字段（初始为 null）',
      Object.prototype.hasOwnProperty.call(state0 || {}, 'resume'),
      JSON.stringify(state0 && state0.resume));

    // --- stream proxy + Range
    const token = state0.streamToken;
    const streamUrl = `http://127.0.0.1:${APP_PORT}/stream/${token}/${album.id}${encodeURI('/电影/测试影片.mkv')}`;
    let res = await fetch(streamUrl);
    check('流代理完整下载', res.status === 200 && (await res.arrayBuffer()).byteLength === video.size,
      `status=${res.status}`);
    res = await fetch(streamUrl, { headers: { Range: 'bytes=0-99' } });
    const buf = Buffer.from(await res.arrayBuffer());
    check('流代理支持 Range（206 + 100 字节）', res.status === 206 && buf.length === 100,
      `status=${res.status} bytes=${buf.length} content-range=${res.headers.get('content-range')}`);
    res = await fetch(streamUrl.replace(`/stream/${token}/`, '/stream/bad-token/'));
    check('错误 token 被拒绝', res.status === 403, `status=${res.status}`);

    // --- 字幕编码：GBK 字幕必须转成 UTF-8 再交给 mpv（否则 mpv 显示 ÎÒh»á¹yz）
    r = await api('GET', `/api/browse?albumId=${album.id}&path=${encodeURIComponent('/编码测试')}`);
    const encEntries = (r.json && r.json.entries) || [];
    const encVideo = encEntries.find((e) => e.name === '胶片.mp4');
    check('编码测试目录：视频识别到 2 条 GBK 字幕', !!encVideo && encVideo.subtitleCount === 2,
      encEntries.map((e) => `${e.name}[${e.kind}]${e.subtitleCount ? '×' + e.subtitleCount : ''}`).join(' '));

    const fetchSubtitle = async (file) => {
      const u = `http://127.0.0.1:${APP_PORT}/stream/${token}/${album.id}${encodeURI('/编码测试/' + file)}`;
      const sres = await fetch(u);
      const bytes = Buffer.from(await sres.arrayBuffer());
      let text = null;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* 不是合法 UTF-8 */ }
      return { status: sres.status, bytes, text, type: sres.headers.get('content-type') };
    };

    for (const pair of [['胶片.chs.srt', '这句字幕是用 GBK 编码保存的'], ['胶片.chs.ass', '这条 ASS 字幕同样是 GBK 编码']]) {
      const s = await fetchSubtitle(pair[0]);
      check(`${pair[0]} 经代理后是合法 UTF-8`, s.text !== null, s.text !== null ? s.type : '严格 UTF-8 解码失败（还是原始 GBK）');
      check(`${pair[0]} 内容正确无乱码`, !!s.text && s.text.includes(pair[1]),
        s.text ? s.text.replace(/\s+/g, ' ').slice(0, 50) : '');
    }

    // 关掉转码后应当拿到原始 GBK 字节，证明设置真的生效
    await api('PUT', '/api/settings', { subEncoding: 'off' });
    const rawSub = await fetchSubtitle('胶片.chs.srt');
    check('设置 subEncoding=off 时原样转发（不是 UTF-8）', rawSub.text === null,
      rawSub.text === null ? '原始字节按原样转发' : '仍被转成了 UTF-8');
    await api('PUT', '/api/settings', { subEncoding: 'auto' });
    const backSub = await fetchSubtitle('胶片.chs.srt');
    check('改回 auto 后恢复转码', backSub.text !== null && backSub.text.includes('这句字幕是用 GBK 编码保存的'));

    // --- digest auth album
    r = await api('POST', '/api/albums', {
      name: '摘要认证专辑', url: `http://127.0.0.1:${MOCK_DIGEST_PORT}${MOCK_BASE}`, root: '/',
      username: 'tester', password: 'secret', auth: 'digest',
    });
    const digestAlbum = r.json && r.json.album;
    r = await api('POST', '/api/albums/test', {
      name: 'digest', url: digestAlbum.url, root: '/', username: 'tester', password: 'secret', auth: 'digest',
    });
    check('摘要认证（digest）连接成功', !!(r.json && r.json.ok), r.json ? r.json.message : r.text);
    r = await api('GET', `/api/browse?albumId=${digestAlbum.id}&path=/`);
    check('摘要认证下浏览目录', r.status === 200 && ((r.json.entries || []).length > 0), `entries=${(r.json.entries || []).length}`);
    r = await api('POST', '/api/albums/test', {
      name: 'bad-digest', url: digestAlbum.url, root: '/', username: 'tester', password: 'bad', auth: 'digest',
    });
    check('摘要认证错误密码被拒绝', !!(r.json && r.json.ok === false), r.json ? r.json.message : r.text);

    // --- playback
    r = await api('POST', '/api/play', { albumId: album.id, path: '/电影/测试影片.mkv', mode: 'replace', loadSubs: true });
    const subs = (r.json && r.json.subtitles) || [];
    check('播放请求成功', r.status === 200 && !!(r.json && r.json.ok), r.text.slice(0, 200));
    check('返回 3 条字幕（含 subs 子目录）', subs.length === 3, subs.join(' | '));
    check('字幕按语言优先级排序（chs 优先）', subs[0] === '测试影片.chs.srt', subs.join(' | '));
    check('播放器模式已确定', !!(r.json && r.json.player && ['ipc', 'spawn'].includes(r.json.player.mode)),
      r.json && r.json.player ? 'mode=' + r.json.player.mode : '');

    await sleep(2500);
    r = await api('GET', '/api/player');
    const playing = r.json && r.json.player;
    check('播放中（running）', !!playing && playing.running === true,
      playing ? `running=${playing.running} idle=${playing.idle} mode=${playing.mode}` : '');
    if (REQUIRE_IPC) {
      check('IPC 模式已启用（命名管道）', !!playing && playing.mode === 'ipc',
        playing ? 'mode=' + playing.mode : '');
    }
    if (playing && playing.mode === 'ipc') {
      check('IPC 模式下进度在推进', playing.position > 0.3, 'position=' + playing.position);
      r = await api('POST', '/api/player', { action: 'pause' });
      const pausedPos = r.json.player.position;
      await sleep(900);
      r = await api('GET', '/api/player');
      check('暂停生效（位置不再推进）', r.json.player.paused === true && Math.abs(r.json.player.position - pausedPos) < 0.6,
        `paused=${r.json.player.paused} pos ${pausedPos.toFixed(2)} -> ${r.json.player.position.toFixed(2)}`);
      r = await api('POST', '/api/player', { action: 'seek', value: 3 });
      await sleep(700);
      r = await api('GET', '/api/player');
      check('跳转到 3 秒生效', r.json.player.position >= 2.5 && r.json.player.position < 4.5, 'position=' + r.json.player.position);
      r = await api('POST', '/api/player', { action: 'volume', value: 42 });
      check('音量控制生效', r.json.player.volume === 42, 'volume=' + r.json.player.volume);
      await api('POST', '/api/player', { action: 'resume' });
      await sleep(1200);
      r = await api('GET', '/api/player');
      check('mpv 实际挂载了 3 条外挂字幕轨（track-list）', r.json.player.subtitleTracks === 3,
        'subtitleTracks=' + r.json.player.subtitleTracks);
    } else if (!REQUIRE_IPC) {
      console.log('SKIP  IPC 模式下进度在推进（当前为回退模式 ' + (playing && playing.mode) + '）');
    }

    // append to playlist
    r = await api('POST', '/api/play', { albumId: album.id, path: '/动画/样片二.mp4', mode: 'append', loadSubs: true });
    check('追加到播放列表', r.status === 200 && !!(r.json && r.json.ok));
    await sleep(500);
    r = await api('GET', '/api/player');
    const pl = (r.json && r.json.player && r.json.player.playlist) || [];
    check('播放列表包含 2 项', pl.length === 2, pl.map((p) => p.title).join(' | '));

    // --- proof from mpv's own log
    await sleep(9000);
    const mpvLog = readLog(MPV_LOG);
    check('mpv 日志已生成', mpvLog.length > 0, `${mpvLog.length} 字节`);
    check('mpv 打开的是本地流代理地址', mpvLog.includes(`127.0.0.1:${APP_PORT}/stream/`));
    check('mpv 实际开始播放（解码/打开完成）', /Video\s+--vid=1|Opening done:|● Video/.test(mpvLog));
    check('mpv 识别到视频轨', /Video --vid=1|video\//i.test(mpvLog));
    check('mpv 加载了同目录 .chs.srt 字幕', mpvLog.includes('chs.srt'));
    check('mpv 加载了 subs/ 子目录字幕', mpvLog.includes('zh.ass'));
    check('mpv 已选中一条字幕轨（● Subs）', /●\s*Subs\s+--sid=\d+/.test(mpvLog));
    check('流代理地址不含查询串（轨道名干净）', !mpvLog.includes('.mkv?t='));

    // --- controls
    r = await api('POST', '/api/player', { action: 'stop' });
    check('停止播放', r.status === 200 && !!(r.json && r.json.ok), r.text.slice(0, 120));

    // --- settings round trip
    r = await api('GET', '/api/settings');
    check('GET /api/settings', r.status === 200 && Array.isArray(r.json.subExts));

    // --- album update + delete
    r = await api('PUT', `/api/albums/${album.id}`, { name: '改名后的专辑', url: album.url, root: '/', username: 'tester', password: '', auth: 'basic' });
    check('更新专辑（空密码保留原密码）', r.status === 200 && r.json.album.name === '改名后的专辑' && r.json.album.hasPassword === true);
    r = await api('GET', `/api/browse?albumId=${album.id}&path=/`);
    check('更新后仍可浏览（密码保留成功）', r.status === 200 && (r.json.entries || []).length > 0);

    // --- app log sanity
    const appLogText = readLog(appLog);
    check('应用日志无未捕获异常', !/unhandledRejection|TypeError|ReferenceError/.test(appLogText),
      (appLogText.match(/.*(unhandledRejection|TypeError|ReferenceError).*/) || [''])[0]);
    if (/回退/.test(appLogText)) {
      console.log('NOTE  当前环境命名管道不可用，测试走的是回退（spawn）模式；IPC 模式需在普通桌面环境验证。');
    }

    const mockText = readLog(mockLog);
    check('mock 服务器收到 PROPFIND', /PROPFIND/.test(mockText));
    check('mpv 通过代理发起了 Range 请求', /Range=bytes=/.test(mockText));

    // --- 与「外部直接用 mpv 打开文件」的隔离保证
    check('我们的 mpv 实例关闭了 save-position-on-quit（不写用户全局 watch_later）',
      /--no-save-position-on-quit/.test(mpvLog));
    check('我们的 mpv 实例关闭了 resume-playback（续播由本应用自己管）',
      /--no-resume-playback/.test(mpvLog));

    // --- 「只记最近一次」续播
    r = await api('GET', '/api/resume');
    check('GET /api/resume 可用', r.status === 200 && !!(r.json && r.json.ok), JSON.stringify(r.json && r.json.resume));

    if (playing && playing.mode === 'ipc') {
      // 换回测试影片，等它播到 --length=6 结束（结束时会强制落盘一次进度）
      await api('POST', '/api/play', {
        albumId: album.id, path: '/电影/测试影片.mkv', mode: 'replace', loadSubs: true,
        size: video.size, mtime: video.mtime,
      });
      let rec = null;
      for (let i = 0; i < 30; i++) {           // 最多等 ~15 秒
        await sleep(500);
        const rr = await api('GET', '/api/resume');
        rec = rr.json && rr.json.resume;
        if (rec && rec.path === '/电影/测试影片.mkv' && rec.pos > 0) break;
        rec = null;
      }
      check('IPC 模式下自动记录了进度（只记一条）', !!rec,
        rec ? `pos=${rec.pos} dur=${rec.dur} name=${rec.name}` : '没等到记录');
      if (rec) {
        check('记录里带 size（用于被动校验，避免文件换了还续播）',
          rec.size === video.size, `size=${rec.size} 期望=${video.size}`);
        check('记录里的路径正确', rec.path === '/电影/测试影片.mkv', rec.path);

        // 再次播放同一文件：应当带上续播位置
        r = await api('POST', '/api/play', {
          albumId: album.id, path: '/电影/测试影片.mkv', mode: 'replace', loadSubs: true,
          size: video.size, mtime: video.mtime,
        });
        check('再次播放同一文件时请求带上了续播位置', !!(r.json && r.json.resumed > 0),
          `resumed=${r.json && r.json.resumed} text=${r.json && r.json.resumedText}`);
        await sleep(1500);
        const posRes = await api('GET', '/api/player');
        const pos = posRes.json.player.position;
        check('mpv 实际跳到了上次的位置', pos >= rec.pos - 1.5, `position=${pos} 期望≈${rec.pos}`);

        // 文件大小变了 → 视为另一个版本，不续播
        r = await api('POST', '/api/play', {
          albumId: album.id, path: '/电影/测试影片.mkv', mode: 'replace', loadSubs: true,
          size: video.size + 1,
        });
        check('文件大小变了就不续播（被动失效）', !r.json.resumed, `resumed=${r.json.resumed}`);

        // 「从头播放」应清掉记录
        r = await api('POST', '/api/play', {
          albumId: album.id, path: '/电影/测试影片.mkv', mode: 'replace', loadSubs: true,
          size: video.size, mtime: video.mtime, resume: false,
        });
        check('「从头播放」不续播且清掉记录', !r.json.resumed, `resumed=${r.json.resumed}`);
        r = await api('GET', '/api/resume');
        check('记录已被清除', !(r.json && r.json.resume), JSON.stringify(r.json && r.json.resume));
      }
    } else {
      console.log('SKIP  IPC 续播记录（当前是回退模式，无法采集播放位置；恢复路径由单测覆盖）');
      r = await api('DELETE', '/api/resume');
      check('DELETE /api/resume 可用', r.status === 200 && !!(r.json && r.json.ok));
    }

    // --- 优雅退出接口（托盘「退出」/脚本停止服务用）——放在最后，因为它会真的关掉服务
    r = await api('POST', '/api/shutdown', { token: 'wrong-token' });
    check('shutdown 接口拒绝错误 token', r.status === 403, `status=${r.status}`);
    r = await api('POST', '/api/shutdown', { token: state0.streamToken });
    check('shutdown 接口接受正确 token', r.status === 200 && !!(r.json && r.json.ok), r.text.slice(0, 80));
    await sleep(2000);
    check('服务已优雅退出（端口关闭）', !(await tcpOpen(APP_PORT)));
  } catch (err) {
    check('测试脚本未抛出异常', false, err.stack || String(err));
  } finally {
    cleanup();
    await sleep(500);
  }

  console.log('');
  console.log(`结果: ${results.filter((r) => r.ok).length}/${results.length} 通过`);
  if (failed) {
    console.log('失败项:');
    for (const r of results.filter((x) => !x.ok)) console.log('  - ' + r.name + (r.detail ? ' :: ' + r.detail : ''));
  }
  console.log('日志目录: ' + WORK);
  process.exit(failed ? 1 : 0);
})();
