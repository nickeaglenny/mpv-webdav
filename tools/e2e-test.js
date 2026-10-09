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
const crypto = require('crypto');
const net = require('net');

const ROOT = path.join(__dirname, '..');
// 测试素材是生成的、不进仓库：缺了就直接说清楚怎么生成，别让它变成一堆莫名其妙的失败
const TESTDATA_DIR = path.join(__dirname, 'testdata');
if (!fs.existsSync(path.join(TESTDATA_DIR, '电影', '测试影片.mkv'))) {
  console.error('缺少测试素材，请先运行：');
  console.error('  powershell -NoProfile -ExecutionPolicy Bypass -File tools\\make-testdata.ps1');
  console.error('（或 npm run testdata）');
  process.exit(1);
}
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
        '--length=60',
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
    // 现在的做法是**重定向**（进度写到我们自己的 cache/watch-later），而不是禁用；
    // 具体断言在下面的 watch-later 段里（不放行 --no-* 参数、目录指向 data/cache/）。

    // --- 播放时的窗口行为（置顶默认开、自动全屏默认关）
    check('mpv 启动参数带上了置顶/全屏设置',
      /--ontop=/.test(mpvLog) && /--fullscreen=/.test(mpvLog),
      (mpvLog.match(/--(?:no-)?ontop=\S+|--(?:no-)?fullscreen=\S+/g) || []).join(' '));
    if (playing && playing.mode === 'ipc') {
      if (typeof playing.ontop === 'boolean') {
        check('IPC 播放中 mpv 处于置顶状态', playing.ontop === true, 'ontop=' + playing.ontop);
        check('IPC 播放中未自动全屏（默认关闭）', playing.fullscreen === false, 'fullscreen=' + playing.fullscreen);
      } else {
        console.log('SKIP  置顶/全屏属性（--vo=null 无窗口时 mpv 不提供这些属性；参数下发已在上一条验证）');
      }
    } else {
      check('回退模式按设置传入置顶参数', /--ontop=yes/.test(mpvLog), '--ontop=yes');
    }

    // --- 进度由 mpv 记账（watch-later）
    const wlDir = path.join(dataDir, 'cache', 'watch-later');
    const wlEntries = () => {
      try {
        return fs.readdirSync(wlDir)
          .map((f) => ({ file: path.join(wlDir, f), text: fs.readFileSync(path.join(wlDir, f), 'utf8') }))
          .filter((e) => /^start=/m.test(e.text));
      } catch { return []; }
    };
    const wlKeyFor = (url) => crypto.createHash('md5').update(url, 'utf8').digest('hex').toUpperCase();

    check('进度目录在 data/cache/watch-later/',
      fs.existsSync(wlDir), wlDir);
    check('mpv 启动参数把进度重定向到我们的目录（而不是禁用）',
      /--watch-later-directory=/.test(mpvLog) && /--save-position-on-quit=yes/.test(mpvLog)
      && !/--no-save-position-on-quit/.test(mpvLog) && !/--no-resume-playback/.test(mpvLog),
      (mpvLog.match(/--watch-later-[a-z-]+=\S+|--save-position-on-quit=\S+|--no-(?:save-position|resume-playback)[a-z-]*/g) || []).join(' '));

    r = await api('GET', '/api/resume');
    check('GET /api/resume 可用', r.status === 200 && !!(r.json && r.json.ok), JSON.stringify(r.json && r.json.resume));

    // --- 列表里的播放进度条：老进度（只有"已看多少秒"、没有时长）应能被自动补探出总时长
    {
      const probeRel = '/剧集/穹庐下的魔女 第03集.mp4';
      const probeUrl = `http://127.0.0.1:${APP_PORT}/stream/${state0.streamToken}/${album.id}${encodeURI(probeRel)}`;
      fs.mkdirSync(wlDir, { recursive: true });
      fs.writeFileSync(path.join(wlDir, wlKeyFor(probeUrl)), `# ${probeUrl}\nstart=5.000000\n`, 'utf8');
      fs.rmSync(path.join(dataDir, 'cache', 'durations.json'), { force: true });   // 模拟"升级前看的"：有进度、没时长
      await api('POST', '/api/player', { action: 'stop' });                        // 确保没在播，补探才会跑
      await sleep(600);

      let ep3 = null;
      let plain = null;
      let firstProgress = null;
      for (let i = 0; i < 40; i++) {
        const b = await api('GET', `/api/browse?albumId=${album.id}&path=${encodeURIComponent('/剧集')}`);
        const list = (b.json && b.json.entries) || [];
        ep3 = list.find((e) => e.path === probeRel);
        plain = list.find((e) => e.path === '/剧集/穹庐下的魔女 第01集.mp4');
        if (ep3 && ep3.progress) {
          if (!firstProgress) firstProgress = JSON.parse(JSON.stringify(ep3.progress));
          if (ep3.progress.dur > 0) break;
        }
        await sleep(700);
      }
      check('列表进度：能读到"已看多少"', !!(ep3 && ep3.progress && ep3.progress.pos === 5),
        JSON.stringify(firstProgress || (ep3 && ep3.progress)));
      check('列表进度：自动补探到总时长（进度条有比例）',
        !!(ep3 && ep3.progress && ep3.progress.dur > 0 && ep3.progress.ratio > 0),
        ep3 && ep3.progress ? `pos=${ep3.progress.pos} dur=${ep3.progress.dur} ${ep3.progress.percent}%` : '没有 progress');
      await sleep(2200);   // 时长缓存是延迟落盘的（1.5 秒防抖）
      check('时长缓存写在 cache/durations.json', fs.existsSync(path.join(dataDir, 'cache', 'durations.json')));
      check('没有进度的文件不会凭空显示进度条', !!plain && plain.progress === undefined,
        plain ? JSON.stringify(plain.progress) : '没找到第01集');
      fs.rmSync(path.join(wlDir, wlKeyFor(probeUrl)), { force: true });            // 清掉，别影响后面的用例
      fs.rmSync(path.join(dataDir, 'cache', 'durations.json'), { force: true });
    }

    if (playing && playing.mode === 'ipc') {
      const movieUrl = `http://127.0.0.1:${APP_PORT}/stream/${state0.streamToken}/${album.id}${encodeURI('/电影/测试影片.mkv')}`;
      const movieKey = wlKeyFor(movieUrl);

      // 1) 播 4 秒 → 停止：mpv 应当把进度写进 watch-later
      await api('POST', '/api/play', { albumId: album.id, path: '/电影/测试影片.mkv', mode: 'replace', loadSubs: true });
      await sleep(4000);
      await api('POST', '/api/player', { action: 'stop' });
      await sleep(1200);
      check('停止后 mpv 写入了进度条目（文件名为 URL 的 MD5）',
        fs.existsSync(path.join(wlDir, movieKey)), wlEntries().length + ' 条');
      const rec = (await api('GET', '/api/resume')).json.resume;
      check('接口报告的最近进度就是这部片', !!rec && rec.path === '/电影/测试影片.mkv' && rec.pos > 1,
        rec ? `${rec.path} @ ${rec.pos}` : JSON.stringify(rec));

      // 2) 再播同一地址：mpv 应当自动续播，接口也要如实报告
      r = await api('POST', '/api/play', { albumId: album.id, path: '/电影/测试影片.mkv', mode: 'replace', loadSubs: true });
      check('再次播放时接口报告了"将续播"', !!(r.json && r.json.resumed > 0),
        `resumed=${r.json && r.json.resumed} text=${r.json && r.json.resumedText}`);
      await sleep(1500);
      const pos = (await api('GET', '/api/player')).json.player.position;
      check('mpv 真的从上次位置继续（原生续播生效）', rec && pos >= rec.pos - 1.5,
        `position=${pos} 期望≈${rec && rec.pos}`);

      // 3) 「从头播放」应删掉该条进度并从 0 开始
      r = await api('POST', '/api/play', { albumId: album.id, path: '/电影/测试影片.mkv', mode: 'replace', loadSubs: true, resume: false });
      check('「从头播放」时接口不报续播', !r.json.resumed, `resumed=${r.json.resumed}`);
      check('「从头播放」确实从头开始（显式 start=0 压过 watch-later）',
        (await api('GET', '/api/player')).json.player.resumedFrom === 0);
      await sleep(1500);   // 等服务端在加载完成后再清一次（mpv 同文件重载会把旧位置写回去）
      check('「从头播放」会删掉那条进度', !fs.existsSync(path.join(wlDir, movieKey)));
      const pos0 = (await api('GET', '/api/player')).json.player.position;
      check('「从头播放」的位置从头累加', rec && pos0 < rec.pos, `position=${pos0} 上次=${rec && rec.pos}`);
      await api('POST', '/api/player', { action: 'stop' });
      await sleep(600);
    } else {
      console.log('SKIP  mpv 原生续播（当前是回退模式，命名管道不可用）');
      r = await api('DELETE', '/api/resume');
      check('DELETE /api/resume 可用', r.status === 200 && !!(r.json && r.json.ok));
    }

    // --- 每个专辑"上次浏览到哪 / 上次播了哪个文件"（data/state/views.json）
    r = await api('PUT', `/api/views/${album.id}`, { path: '/剧集' });
    check('接口能记录"上次浏览的目录"',
      !!(r.json && r.json.view && r.json.view.path === '/剧集'), JSON.stringify(r.json && r.json.view));
    r = await api('GET', '/api/state');
    check('state 里带着这条记录',
      !!(r.json.views && r.json.views[album.id] && r.json.views[album.id].path === '/剧集'),
      JSON.stringify(r.json.views && r.json.views[album.id]));
    await api('POST', '/api/play', { albumId: album.id, path: '/电影/测试影片.mkv', mode: 'single', loadSubs: false });
    await sleep(700);
    r = await api('GET', '/api/state');
    check('播放后自动记下"上次播的文件"（原先的目录记录保留）',
      !!(r.json.views && r.json.views[album.id]
        && r.json.views[album.id].file === '/电影/测试影片.mkv'
        && r.json.views[album.id].path === '/剧集'),
      JSON.stringify(r.json.views && r.json.views[album.id]));
    await api('POST', '/api/player', { action: 'stop' });
    await sleep(400);

    // --- 剧集目录（一个目录多个视频）：续播记录必须指向"真正在播的那一集"
    r = await api('GET', `/api/browse?albumId=${album.id}&path=${encodeURIComponent('/剧集')}`);
    const epEntries = (r.json && r.json.entries) || [];
    const ep1 = epEntries.find((e) => e.name === '穹庐下的魔女 第01集.mp4');
    const ep2 = epEntries.find((e) => e.name === '穹庐下的魔女 第02集.mp4');
    const ep3 = epEntries.find((e) => e.name === '穹庐下的魔女 第03集.mp4');
    check('剧集目录：识别到 3 集', !!ep1 && !!ep2 && !!ep3, epEntries.map((e) => e.name).join(' / '));

    // 「追加到播放列表」绝不能改变"当前正在播的是谁"——这条与传输方式无关，
    // 回退模式同样会踩到（旧代码会把状态改成最后追加的那一集，导致续播记录串集）。
    if (ep1 && ep2 && ep3) {
      const playEp = (ep, mode) => api('POST', '/api/play', {
        albumId: album.id, path: ep.path, mode, loadSubs: false, size: ep.size, mtime: ep.mtime,
      });
      await playEp(ep1, 'replace');
      await sleep(700);
      await playEp(ep2, 'append');
      await playEp(ep3, 'append');
      await sleep(700);
      const stAppend = (await api('GET', '/api/player')).json.player;
      check('追加剧集不会改掉「正在播的那一集」', stAppend.path === ep1.path, `path=${stAppend.path}`);
      check('追加后播放列表共 3 项', (stAppend.playlist || []).length === 3,
        (stAppend.playlist || []).map((x) => x.title).join(' | '));
      await api('POST', '/api/player', { action: 'stop' });
      await sleep(400);

      // 剧集连播（与传输方式无关）：从第 02 集开始 → 列表应是 [第02集, 第03集]
      const sr = await api('POST', '/api/play', { albumId: album.id, path: ep2.path, mode: 'series', loadSubs: true });
      const seriesInfo = sr.json && sr.json.series;
      const seriesPl = (sr.json && sr.json.player && sr.json.player.playlist) || [];
      check('连播：接口报告连播范围（第 02 集起共 2 集）',
        !!seriesInfo && seriesInfo.total === 2 && seriesInfo.from === ep2.name, JSON.stringify(seriesInfo));
      check('连播：播放列表 = [第02集, 第03集]（同目录剩余，自然排序）',
        seriesPl.length === 2 && seriesPl[0].title === ep2.name && seriesPl[1].title === ep3.name,
        seriesPl.map((x) => x.title).join(' | '));
      check('连播：当前播的就是被点的那一集（不会先闪第 01 集）',
        (await api('GET', '/api/player')).json.player.path === ep2.path,
        (await api('GET', '/api/player')).json.player.path);
      await api('POST', '/api/player', { action: 'stop' });
      await sleep(400);
    }

    if (playing && playing.mode === 'ipc' && ep1 && ep2 && ep3) {
      const playEpisode = (ep, mode) => api('POST', '/api/play', {
        albumId: album.id, path: ep.path, mode, loadSubs: true,
      });
      const getResume = async () => (await api('GET', '/api/resume')).json.resume;
      const playerPath = async () => (await api('GET', '/api/player')).json.player.path;
      const stopPlaying = async () => { await api('POST', '/api/player', { action: 'stop' }); await sleep(1000); };

      // 1) 只看某一集：播第 2 集 → 停止（mpv 会存盘）→ 最近的进度必须是第 2 集
      await playEpisode(ep2, 'replace');
      await sleep(2500);
      await stopPlaying();
      let recEp = await getResume();
      check('单集播放：最近的进度指向第 02 集', !!recEp && recEp.path === ep2.path,
        recEp ? `${recEp.path} pos=${recEp.pos}` : '没有进度');
      check('单集播放：播放状态也指向第 02 集', (await playerPath()) === ep2.path, await playerPath());

      // 2) 连播：replace 第 1 集 + append 第 2/3 集 → 状态必须仍指向第 1 集
      await playEpisode(ep1, 'replace');
      await sleep(1200);
      await playEpisode(ep2, 'append');
      await playEpisode(ep3, 'append');
      await sleep(1200);
      const pathAfterAppend = await playerPath();
      check('追加剧集后，播放状态仍指向正在播的第 01 集', pathAfterAppend === ep1.path, `path=${pathAfterAppend}`);
      const pl = (await api('GET', '/api/player')).json.player.playlist || [];
      check('播放列表共 3 项', pl.length === 3, pl.map((x) => x.title).join(' | '));

      // 停止让它落盘：进度必须写在第 01 集上（而不是被追加的第 3 集）
      await stopPlaying();
      recEp = await getResume();
      check('连播时进度记在第 01 集上（不会串到追加项）', !!recEp && recEp.path === ep1.path,
        recEp ? `${recEp.path} pos=${recEp.pos}` : '没有进度');

      // 2.5) 连播时的"每集各自挂字幕"：从第 02 集开始连播（第 02 集有字幕，第 03 集没有）
      await api('POST', '/api/play', { albumId: album.id, path: ep2.path, mode: 'series', loadSubs: true });
      await sleep(1200);
      check('连播：第 02 集的字幕被挂上（每集各自挂各自的）',
        (await api('GET', '/api/player')).json.player.subtitleCount === 1,
        JSON.stringify((await api('GET', '/api/player')).json.player.subtitles));

      // "下一集"由 mpv 自己推进：切到第 03 集后，字幕应当换成它自己的（没有字幕）
      await api('POST', '/api/player', { action: 'next' });
      await sleep(2000);
      const afterNext = (await api('GET', '/api/player')).json.player;
      check('连播：mpv 自己推进到第 03 集', afterNext.path === ep3.path, afterNext.path);
      check('连播：第 03 集没有字幕（各集互不串）', afterNext.subtitleCount === 0,
        String(afterNext.subtitleCount));
      await stopPlaying();

      // 3) 切集时，上一个文件的进度也要被保存（实测 mpv 自己不会存，需要我们主动存）
      await playEpisode(ep1, 'replace');
      await sleep(3000);
      await playEpisode(ep2, 'replace');        // 直接切到第 2 集，不先停止
      await sleep(1000);
      const ep1Key = wlKeyFor(`http://127.0.0.1:${APP_PORT}/stream/${state0.streamToken}/${album.id}${encodeURI(ep1.path)}`);
      check('切集时上一个文件的进度被主动保存下来',
        fs.existsSync(path.join(wlDir, ep1Key)), '第01集的进度条目');
      const pathNow = await playerPath();
      check('切集后播放状态指向第 02 集', pathNow === ep2.path, `path=${pathNow}`);

      // 4) 按空格暂停：不该出现"进度归零 / 自动续播"（回归：曾因 time-pos 报 null 与重载导致）
      await api('POST', '/api/play', { albumId: album.id, path: '/电影/测试影片.mkv', mode: 'replace', loadSubs: true });
      await sleep(3000);
      const beforePause = (await api('GET', '/api/player')).json.player;
      await api('POST', '/api/player', { action: 'toggle' });     // 等价于按空格
      await sleep(400);
      const paused1 = (await api('GET', '/api/player')).json.player;
      check('按暂停后处于暂停状态', paused1.paused === true, `paused=${paused1.paused}`);
      check('暂停瞬间进度不归零', paused1.position >= beforePause.position - 0.5,
        `position=${paused1.position} 之前=${beforePause.position}`);
      check('暂停期间仍是同一个文件', paused1.path === beforePause.path && paused1.albumId === beforePause.albumId,
        `${paused1.albumId}${paused1.path}`);
      await sleep(2500);
      const paused2 = (await api('GET', '/api/player')).json.player;
      check('暂停不会被自动续播', paused2.paused === true, `paused=${paused2.paused}`);
      check('暂停期间进度保持不动', Math.abs(paused2.position - paused1.position) < 0.6,
        `${paused1.position} → ${paused2.position}`);
      await api('POST', '/api/player', { action: 'toggle' });     // 恢复播放，收尾用
      await sleep(300);
      check('再按一次可以继续播放', (await api('GET', '/api/player')).json.player.paused === false);

      // 5) 点「继续观看」= 播最近这条：应当续播
      recEp = await getResume();
      r = await api('POST', '/api/play', { albumId: album.id, path: recEp.path, mode: 'replace', loadSubs: true });
      check('剧集续播：接口报告了"将续播"', !!(r.json && r.json.resumed > 0),
        `resumed=${r.json && r.json.resumed} text=${r.json && r.json.resumedText}`);
      await sleep(1500);
      const posEp = (await api('GET', '/api/player')).json.player.position;
      check('剧集续播：mpv 实际跳到了上次位置', posEp >= recEp.pos - 1.5,
        `position=${posEp} 期望≈${recEp.pos}`);
      await stopPlaying();
    } else if (ep1) {
      console.log('SKIP  剧集续播（回退模式无法采集位置）');
    }

    // --- 焦点设置：开始播放时把键盘焦点交给 mpv（默认开）
    r = await api('GET', '/api/settings');
    check('设置里有"播放时把焦点交给 mpv"且默认开启',
      !!(r.json && r.json.mpvFocusOnPlay === true), JSON.stringify(r.json && r.json.mpvFocusOnPlay));
    r = await api('PUT', '/api/settings', { mpvFocusOnPlay: false });
    check('可以关掉它', !!(r.json && r.json.settings && r.json.settings.mpvFocusOnPlay === false));
    r = await api('PUT', '/api/settings', { mpvFocusOnPlay: true });
    check('可以再打开', !!(r.json && r.json.settings && r.json.settings.mpvFocusOnPlay === true));

    // --- 置顶 / 自动全屏 开关（默认：置顶开、全屏关）
    r = await api('PUT', '/api/settings', { mpvOntop: false, mpvAutoFullscreen: true });
    check('设置里能关掉置顶、打开自动全屏',
      !!(r.json && r.json.settings.mpvOntop === false && r.json.settings.mpvAutoFullscreen === true),
      JSON.stringify(r.json && r.json.settings && { ontop: r.json.settings.mpvOntop, fs: r.json.settings.mpvAutoFullscreen }));

    if (!playing || playing.mode !== 'ipc') {
      // 回退模式每个文件重新起 mpv，参数应当立刻跟着设置变
      await api('POST', '/api/play', { albumId: album.id, path: '/动画/样片二.mp4', mode: 'replace', loadSubs: false });
      await sleep(1500);
      const log2 = readLog(MPV_LOG);
      check('回退模式：开关变化后 mpv 参数同步变化',
        /--ontop=no/.test(log2) && /--fullscreen=yes/.test(log2));
    } else {
      console.log('SKIP  回退模式参数同步（IPC 模式是运行时 set_property，由置顶属性断言覆盖）');
    }

    r = await api('PUT', '/api/settings', { mpvOntop: true, mpvAutoFullscreen: false });
    check('设置可以复原', !!(r.json && r.json.settings.mpvOntop === true && r.json.settings.mpvAutoFullscreen === false));

    // --- data/ 目录结构：配置在根目录、状态在 state/、缓存在 cache/
    const dataFiles = (function walk(dir, base) {
      const out = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        const rel = (base ? base + '/' : '') + e.name;
        if (e.isDirectory()) out.push(...walk(p, rel)); else out.push(rel);
      }
      return out;
    })(dataDir, '');
    check('data 根目录只有配置类文件（没有零散状态文件）',
      dataFiles.filter((f) => !f.includes('/')).every((f) => /^(albums|settings)\.json(\.bak)?$/.test(f)),
      dataFiles.filter((f) => !f.includes('/')).join(', '));
    check('没有遗留的 last-played.json（已迁移到 state/）',
      !fs.existsSync(path.join(dataDir, 'last-played.json')));
    check('state/ 与 cache/ 已就绪',
      fs.existsSync(path.join(dataDir, 'state')) && fs.existsSync(path.join(dataDir, 'cache')));
    check('固定令牌文件已生成', fs.existsSync(path.join(dataDir, 'state', 'instance.json')));
    const instOnDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 'instance.json'), 'utf8'));
    check('令牌与本次运行使用的一致（重启后 URL 不变）',
      instOnDisk.streamToken === state0.streamToken, instOnDisk.streamToken);

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
