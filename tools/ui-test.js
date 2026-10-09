'use strict';
// Headless UI test: starts the mock WebDAV server + the app, drives a real
// browser over the DevTools protocol, checks the rendered DOM / console and
// saves screenshots to tools/.ui/.
//
// Usage: node tools/ui-test.js
// Requires a normal (non-sandboxed) session: Chromium needs named pipes.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const { getFreePort } = require('./cdp-client');

const ROOT = path.join(__dirname, '..');
// 测试素材是生成的、不进仓库：缺了就直接说清楚怎么生成，别让它变成一堆莫名其妙的失败
const TESTDATA_DIR = path.join(__dirname, 'testdata');
if (!fs.existsSync(path.join(TESTDATA_DIR, '电影', '测试影片.mkv'))) {
  console.error('缺少测试素材，请先运行：');
  console.error('  powershell -NoProfile -ExecutionPolicy Bypass -File tools\\make-testdata.ps1');
  console.error('（或 npm run testdata）');
  process.exit(1);
}
const WORK = path.join(__dirname, '.ui');
// 端口全部动态分配：绝不能抢用户正在使用的 8787，
// 否则测试请求会落到用户的实例上，把他的专辑/设置改掉。
let MOCK_PORT = 0;
let APP_PORT = 0;
let CDP_PORT = 0;

const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return process.env.CHROME_PATH || null;
}

function startNode(script, args, env, logFile) {
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ['ignore', fd, fd],
    env: Object.assign({}, process.env, env || {}),
  });
  return child;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.setTimeout(800, () => done(false));
  });
}

async function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(200);
  }
  return false;
}

async function httpJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null, text }; }
}

// 发一个 JSON POST（播放 / 停止等按钮背后的接口）
function httpPost(url, body) {
  return httpJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 1; this.pending = new Map(); this.handlers = []; }

  // 元素中心点坐标（真实鼠标事件用）
  async center(expression) {
    return this.eval(`(function () {
      var n = ${expression};
      if (!n) return null;
      var r = n.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
  }

  // 通过 DevTools 派发真实鼠标事件（合成 MouseEvent 不会产生 clickCount / dblclick 语义）
  async realClick(x, y, clickCount = 1) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
  }

  async doubleClick(x, y) {
    await this.realClick(x, y, 1);
    await sleep(110);
    await this.realClick(x, y, 2);
  }

  async pressKey(key, code, vk) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve(true));
      ws.addEventListener('error', (e) => reject(new Error('CDP WebSocket 连接失败: ' + (e.message || 'error'))));
      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
          return;
        }
        for (const h of this.handlers) h(msg);
      });
    });
  }

  onEvent(fn) { this.handlers.push(fn); }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
      }, 15000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('页面脚本异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    }
    return r.result ? r.result.value : undefined;
  }

  async waitFor(expression, timeoutMs = 15000, label = expression) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (await this.eval(expression)) return true; } catch { /* keep polling */ }
      await sleep(200);
    }
    throw new Error('等待超时: ' + label);
  }
}

(async () => {
  const browser = findBrowser();
  if (!browser) { console.error('找不到 Chrome/Edge'); process.exit(2); }
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  MOCK_PORT = await getFreePort();
  APP_PORT = await getFreePort();
  CDP_PORT = await getFreePort();
  console.log(`本次测试使用端口：mock=${MOCK_PORT}  app=${APP_PORT}  cdp=${CDP_PORT}\n`);

  const mock = startNode(path.join(__dirname, 'mock-webdav.js'), [
    '--root', path.join(__dirname, 'testdata'), '--port', String(MOCK_PORT),
    '--base', '/dav', '--auth', 'basic', '--user', 'tester', '--pass', 'secret',
  ], {}, path.join(WORK, 'mock.log'));

  const app = startNode(path.join(ROOT, 'server', 'index.js'), [], {
    MPV_WEBDAV_PORT: String(APP_PORT),
    MPV_WEBDAV_DATA: path.join(WORK, 'data'),
  }, path.join(WORK, 'app.log'));

  let proc = null;
  const cleanup = () => {
    try { app.kill(); } catch {}
    try { mock.kill(); } catch {}
    try { proc && proc.kill(); } catch {}
  };
  process.on('exit', cleanup);

  try {
    check('mock WebDAV 已启动', await waitForPort(MOCK_PORT));
    check('应用服务器已启动', await waitForPort(APP_PORT));

    // 安全检查：确认这个端口上就是本次测试刚起的实例（空专辑列表 + 端口一致）。
    // 如果端口被别的实例占用，立刻中止，绝不去改别人的数据。
    const ident = await httpJson(`http://127.0.0.1:${APP_PORT}/api/state`);
    const ownInstance = !!(ident.json && ident.json.server && ident.json.server.port === APP_PORT
      && Array.isArray(ident.json.albums) && ident.json.albums.length === 0);
    check('确认连到的是本次测试自己的实例（不会碰你的数据）', ownInstance,
      ident.json ? `port=${ident.json.server && ident.json.server.port} albums=${(ident.json.albums || []).length}` : '无法读取 /api/state');
    if (!ownInstance) {
      throw new Error(`端口 ${APP_PORT} 上不是本次测试的实例，已中止（未做任何修改）`);
    }

    // Album + headless-friendly mpv settings (no window, short playback).
    let r = await httpJson(`http://127.0.0.1:${APP_PORT}/api/albums`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '我的 NAS', type: 'webdav', url: `http://127.0.0.1:${MOCK_PORT}/dav`,
        root: '/', username: 'tester', password: 'secret', auth: 'basic',
      }),
    });
    const album = r.json && r.json.album;
    check('已创建演示专辑', !!album);
    await httpJson(`http://127.0.0.1:${APP_PORT}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        extraMpvArgs: ['--vo=null', '--ao=null', '--force-window=no', '--length=30',
          '--msg-level=all=info', '--log-file=' + path.join(WORK, 'mpv.log')],
        // 测试片只有 12 秒：把阈值调小，才能在测试里看到「续播」
        resumeMinSeconds: 1,
        resumeMinPercent: 1,
        resumeEndGuardSeconds: 1,
      }),
    });

    // --- launch browser
    const args = [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-allow-origins=*', '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + path.join(WORK, 'profile'),
      '--window-size=1600,1000',
      `http://127.0.0.1:${APP_PORT}/`,
    ];
    proc = spawn(browser, args, { stdio: 'ignore' });
    check('浏览器已启动（CDP 端口开放）', await waitForPort(CDP_PORT, 25000));

    const listRes = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const page = (listRes.json || []).find((t) => t.type === 'page' && String(t.url).includes('127.0.0.1'));
    check('找到页面调试目标', !!page, page ? page.url : JSON.stringify(listRes.json).slice(0, 160));

    const cdp = new Cdp(page.webSocketDebuggerUrl);
    const consoleErrors = [];
    const dialogs = [];
    let dialogAccept = true;
    cdp.onEvent((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        consoleErrors.push('exception: ' + (d.exception && d.exception.description || d.text));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push('console.error: ' + msg.params.args.map((a) => a.value || a.description || a.type).join(' '));
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        consoleErrors.push('log: ' + msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
      }
      if (msg.method === 'Page.javascriptDialogOpening') {
        dialogs.push(msg.params.message);
        cdp.send('Page.handleJavaScriptDialog', { accept: dialogAccept }).catch(() => {});
      }
    });
    await cdp.open();
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    // --- boot
    await cdp.waitFor('!!document.querySelector("#album-list .album-item")', 20000, '专辑列表渲染');
    const albumText = await cdp.eval('document.querySelector("#album-list .album-item").textContent.trim()');
    check('侧边栏显示专辑', /我的 NAS/.test(albumText), albumText);
    const pill = await cdp.eval('document.querySelector("#mpv-pill-text").textContent.trim()');
    check('顶栏显示 mpv 状态', /mpv/i.test(pill) && !/未找到/.test(pill), pill);

    // --- open album（真实用户路径：鼠标移上去产生悬停，再点专辑名中心）
    const albumPoint = await cdp.center('document.querySelector("#album-list .album-item")');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: albumPoint.x, y: albumPoint.y, buttons: 0 });
    await sleep(200);
    const overlap = await cdp.eval(`(function () {
      var a = document.querySelector('#album-list .album-item .album-actions');
      var n = document.querySelector('#album-list .album-item .album-name');
      if (!a || !n) return false;
      var ar = a.getBoundingClientRect(), nr = n.getBoundingClientRect();
      return !(ar.bottom <= nr.top || ar.top >= nr.bottom);
    })()`);
    check('悬停时操作按钮不会压住专辑名', overlap === false, 'overlap=' + overlap);
    await cdp.realClick(albumPoint.x, albumPoint.y);
    await sleep(500);
    check('悬停状态下点专辑名不会误开编辑框',
      await cdp.eval('document.querySelector("#dlg-album").classList.contains("hidden")'));
    await cdp.waitFor('document.querySelectorAll("#listing [data-path]").length >= 3', 20000, '根目录列表');
    const rootNames = await cdp.eval('Array.from(document.querySelectorAll("#listing [data-path]")).map(function (n) { return n.getAttribute("title"); }).join(",")');
    check('根目录内容渲染', /电影/.test(rootNames) && /说明\.txt/.test(rootNames), rootNames);

    const crumb = await cdp.eval('document.querySelector("#breadcrumb").textContent.trim()');
    check('面包屑显示专辑名', /我的 NAS/.test(crumb), crumb);

    // --- 真实鼠标：单击只选中，双击才进入
    const movieRow = `Array.from(document.querySelectorAll('#listing [data-kind="dir"]')).filter(function (n) { return n.getAttribute('title') === '电影'; })[0]`;
    const moviePoint = await cdp.center(movieRow);
    check('找到「电影」文件夹行', !!moviePoint, JSON.stringify(moviePoint));

    await cdp.realClick(moviePoint.x, moviePoint.y);
    await sleep(600);
    const afterSingle = JSON.parse(await cdp.eval(`JSON.stringify({
      crumb: document.querySelector('#breadcrumb').textContent.trim(),
      selected: !!document.querySelector('#listing .is-selected'),
      stillRoot: Array.from(document.querySelectorAll('#listing [data-path]')).some(function (n) { return n.getAttribute('title') === '说明.txt'; })
    })`));
    check('单击文件夹只选中、不进入', afterSingle.stillRoot && afterSingle.selected && !/电影/.test(afterSingle.crumb),
      JSON.stringify(afterSingle));

    await cdp.doubleClick(moviePoint.x, moviePoint.y);
    await cdp.waitFor('Array.from(document.querySelectorAll("#listing [data-path]")).some(function (n) { return n.getAttribute("title") === "测试影片.mkv"; })', 20000, '电影目录列表');
    check('真实双击进入文件夹', true);
    const crumbAfterDbl = await cdp.eval('document.querySelector("#breadcrumb").textContent.trim()');
    check('双击不会连进两层（停在「电影」）', /电影/.test(crumbAfterDbl) && !/subs/.test(crumbAfterDbl), crumbAfterDbl);
    const subBadge = await cdp.eval(`(function () {
      var row = Array.from(document.querySelectorAll('#listing [data-path]'))
        .filter(function (n) { return n.getAttribute('title') === '测试影片.mkv'; })[0];
      var b = row.querySelector('.sub-badge');
      return b ? b.textContent.trim() : '';
    })()`);
    check('视频行显示字幕角标', /字幕\s*×2/.test(subBadge), subBadge);

    const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(WORK, 'ui-browse.png'), Buffer.from(shot1.data, 'base64'));
    check('已保存浏览界面截图', fs.existsSync(path.join(WORK, 'ui-browse.png')));

    // --- 行内「进入」按钮（回到根目录后测试）
    const upPoint = await cdp.center('document.querySelector("#btn-up")');
    await cdp.realClick(upPoint.x, upPoint.y);
    await cdp.waitFor('Array.from(document.querySelectorAll("#listing [data-path]")).some(function (n) { return n.getAttribute("title") === "电影"; })', 15000, '回到根目录');
    const enterBtn = await cdp.center(`(function () {
      var row = Array.from(document.querySelectorAll('#listing [data-kind="dir"]'))
        .filter(function (n) { return n.getAttribute('title') === '电影'; })[0];
      return row ? row.querySelector('[data-act="enter"]') : null;
    })()`);
    check('文件夹行有「进入」按钮', !!enterBtn);
    await cdp.realClick(enterBtn.x, enterBtn.y);
    await cdp.waitFor('Array.from(document.querySelectorAll("#listing [data-path]")).some(function (n) { return n.getAttribute("title") === "测试影片.mkv"; })', 15000, '按钮进入文件夹');
    check('点「进入」按钮可进入文件夹', true);

    // --- 键盘上下选择：一次只移动一格（回归：曾被列表与全局两个处理器各处理一次 → 跳两格）
    await cdp.eval('document.querySelector("#listing").focus()');
    const sel0 = await cdp.eval('state.selIndex');
    await cdp.pressKey('ArrowDown', 'ArrowDown', 40);
    await sleep(250);
    const sel1 = await cdp.eval('state.selIndex');
    check('按一次 ↓ 只移动一格', sel1 === sel0 + 1, `selIndex ${sel0} → ${sel1}`);
    await cdp.pressKey('ArrowDown', 'ArrowDown', 40);
    await sleep(250);
    const sel2 = await cdp.eval('state.selIndex');
    check('再按一次 ↓ 仍然只移动一格', sel2 === sel1 + 1, `selIndex ${sel1} → ${sel2}`);
    await cdp.pressKey('ArrowUp', 'ArrowUp', 38);
    await sleep(250);
    const sel3 = await cdp.eval('state.selIndex');
    check('按一次 ↑ 也只移动一格', sel3 === sel2 - 1, `selIndex ${sel2} → ${sel3}`);
    check('选中项确实高亮在界面上',
      (await cdp.eval('document.querySelectorAll("#listing .row.is-selected").length')) === 1);

    // --- 播放方式：双击行 / 回车即可播（行内不再有播放按钮）
    await cdp.eval(`(function () {
      var row = Array.from(document.querySelectorAll('#listing [data-path]'))
        .filter(function (n) { return n.getAttribute('title') === '测试影片.mkv'; })[0];
      return !!row && !row.querySelector('[data-act="play"]');
    })()`).then(function (noPlayBtn) {
      check('视频行内不再有「播放」按钮', noPlayBtn === true, String(noPlayBtn));
    });
    const rowPoint = await cdp.center(`Array.from(document.querySelectorAll('#listing [data-path]')).filter(function (n) { return n.getAttribute('title') === '测试影片.mkv'; })[0]`);
    await cdp.doubleClick(rowPoint.x, rowPoint.y);          // 真实双击开始播放
    // 界面上不再有播放控制面板：以「标签页标题出现进度」作为"已经开始播"的界面信号
    await cdp.waitFor('document.title.indexOf("测试影片") >= 0', 20000, '标签页标题出现影片名');

    await sleep(2500);
    const player = await httpJson(`http://127.0.0.1:${APP_PORT}/api/player`);
    const ps = player.json && player.json.player;
    check('后端确认正在播放', !!ps && ps.running === true, ps ? `mode=${ps.mode} pos=${ps.position}` : '');
    check('后端确认已挂载 3 条字幕', !!ps && ps.subtitleCount === 3, ps ? ps.subtitles.join(' | ') : '');
    check('mpv 实际挂载了 3 条字幕轨', !!ps && ps.subtitleTracks === 3, ps ? 'subtitleTracks=' + ps.subtitleTracks : '');

    // --- 界面里不该再残留播放面板 / 队列 / 播放按钮 / 继续观看 / 播放全部
    const leftover = await cdp.eval(`JSON.stringify({
      playerbar: !!document.querySelector('#playerbar, .playerbar'),
      playerbarButtons: document.querySelectorAll('#btn-toggle, #btn-stop, #btn-mute, #seek, #volume').length,
      queuePane: !!document.querySelector('#queue-list, .pane-queue, #queue-toggle'),
      rowPlayButtons: document.querySelectorAll('#listing [data-act="play"]').length,
      topButtons: document.querySelectorAll('#btn-resume, #btn-play-all').length
    })`);
    check('播放面板/队列/播放按钮/继续/播放全部 都已从界面移除',
      leftover === '{"playerbar":false,"playerbarButtons":0,"queuePane":false,"rowPlayButtons":0,"topButtons":0}', leftover);

    // --- 浏览器标签页标题显示播放进度（切到别的标签也能看到播到哪了）
    const tabTitle = await cdp.eval('document.title');
    check('标签页标题显示播放进度', /^▶\s+\d+:\d\d\s*\/\s*\d+:\d\d\s+·\s+测试影片/.test(tabTitle), tabTitle);
    check('标签页标题不是默认标题', tabTitle !== 'mpv WebDAV 专辑', tabTitle);

    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(WORK, 'ui-playing.png'), Buffer.from(shot2.data, 'base64'));
    check('已保存播放界面截图', fs.existsSync(path.join(WORK, 'ui-playing.png')));

    // --- 进度仍由 mpv 记（播一集 → 停止 → /api/resume 能读到），网页这边只用于 ⋯ 菜单的「从头播放」
    await httpPost(`http://127.0.0.1:${APP_PORT}/api/play`,
      { albumId: album.id, path: '/剧集/穹庐下的魔女 第01集.mp4', mode: 'replace', loadSubs: false });
    await sleep(3000);
    await httpPost(`http://127.0.0.1:${APP_PORT}/api/player`, { action: 'stop' });
    let rec = null;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const rr = await httpJson(`http://127.0.0.1:${APP_PORT}/api/resume`);
      rec = rr.json && rr.json.resume;
      if (rec && rec.pos > 0) break;
      rec = null;
    }
    check('停止后服务端能从 mpv 的进度里读到记录', !!rec, rec ? `${rec.name} pos=${rec.pos}` : '没等到记录');
    if (rec) {
      await cdp.eval('refreshState()');     // 让页面把记录读回来（行内菜单据此显示「从头播放」）
      await httpPost(`http://127.0.0.1:${APP_PORT}/api/play`,
        { albumId: album.id, path: '/剧集/穹庐下的魔女 第01集.mp4', mode: 'replace', loadSubs: false });
      await cdp.waitFor('document.title.indexOf("穹庐下的魔女") >= 0', 15000, '第二集开始播放');
      await sleep(1800);        // mpv 应用 watch-later 的续播位置需要一点时间
      const resumePos = (await httpJson(`http://127.0.0.1:${APP_PORT}/api/player`)).json.player.position;
      check('再次播放同一文件时由 mpv 自动续播', resumePos >= rec.pos - 1.5,
        `position=${resumePos} 期望≈${rec.pos}`);

      // 网页不再做播放遥控：焦点在列表上时按空格，不该影响 mpv 的播放
      await cdp.eval('document.querySelector("#listing").focus()');
      const beforeSpace = (await httpJson(`http://127.0.0.1:${APP_PORT}/api/player`)).json.player;
      await sleep(900);                                   // 让进度自然推进一点
      await cdp.pressKey(' ', 'Space', 32);
      await sleep(900);
      const afterSpace = (await httpJson(`http://127.0.0.1:${APP_PORT}/api/player`)).json.player;
      check('网页里按空格不再控制 mpv（没暂停、没重新加载、进度继续走）',
        afterSpace.paused === false
        && afterSpace.path === beforeSpace.path
        && afterSpace.position > beforeSpace.position,
        `paused=${afterSpace.paused} pos ${beforeSpace.position} → ${afterSpace.position}`);

      await httpPost(`http://127.0.0.1:${APP_PORT}/api/player`, { action: 'stop' });
      await sleep(500);
    }

    // --- 列表里显示播放进度（mpv 记的"看到哪了" + 时长缓存 → 一条小进度条）
    let barInfo = null;
    for (let i = 0; i < 12; i++) {
      await cdp.eval(`loadBrowse(${JSON.stringify(album.id)}, '/电影')`);
      await sleep(800);
      barInfo = await cdp.eval(`(function () {
        var row = Array.from(document.querySelectorAll('#listing [data-path]'))
          .filter(function (n) { return n.getAttribute('title') === '测试影片.mkv'; })[0];
        if (!row) return null;
        var fill = row.querySelector('.prog-fill');
        var pct = row.querySelector('.prog-pct');
        if (!fill) return null;
        return JSON.stringify({ width: fill.style.width, pct: pct ? pct.textContent : '' });
      })()`);
      if (barInfo) break;
    }
    check('列表里显示播放进度条', !!barInfo, barInfo || '没看到进度条');
    if (barInfo) {
      const info = JSON.parse(barInfo);
      check('进度条有具体宽度与百分比', /%$/.test(info.width || '') && parseInt(info.width, 10) > 0,
        `width=${info.width} pct=${info.pct}`);
      const shot3 = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(WORK, 'ui-progress.png'), Buffer.from(shot3.data, 'base64'));
      check('已保存进度条截图', fs.existsSync(path.join(WORK, 'ui-progress.png')));
    }

    // --- 剧集连播：双击一集 = 从这集开始连播本目录剩余（默认行为）
    await cdp.eval(`loadBrowse(${JSON.stringify(album.id)}, '/剧集')`);
    await cdp.waitFor('Array.from(document.querySelectorAll("#listing [data-path]")).some(function (n) { return n.getAttribute("title") === "穹庐下的魔女 第02集.mp4"; })', 15000, '进入剧集目录');
    const ep2Point = await cdp.center(`Array.from(document.querySelectorAll('#listing [data-path]')).filter(function (n) { return n.getAttribute('title') === '穹庐下的魔女 第02集.mp4'; })[0]`);
    await cdp.doubleClick(ep2Point.x, ep2Point.y);
    await sleep(2500);
    const seriesPlayer = (await httpJson(`http://127.0.0.1:${APP_PORT}/api/player`)).json.player;
    const seriesPl = seriesPlayer.playlist || [];
    check('双击一集 → 自动把本目录剩余集排进播放列表',
      seriesPl.length === 2 && seriesPl[0].title === '穹庐下的魔女 第02集.mp4' && seriesPl[1].title === '穹庐下的魔女 第03集.mp4',
      seriesPl.map((x) => x.title).join(' | '));
    check('双击的那一集就是正在播的那一集', seriesPlayer.path === '/剧集/穹庐下的魔女 第02集.mp4', seriesPlayer.path);
    await httpPost(`http://127.0.0.1:${APP_PORT}/api/player`, { action: 'stop' });
    await sleep(500);

    // --- settings dialog: 点遮罩不应该关闭
    await cdp.eval('document.querySelector("#btn-settings").click()');
    await cdp.waitFor('!document.querySelector("#dlg-settings").classList.contains("hidden")');
    const mpvPathShown = await cdp.eval('document.querySelector("#st-mpv-path").value');
    check('设置对话框回填 mpv 路径', /mpv\.exe$/i.test(mpvPathShown), mpvPathShown);
    await cdp.realClick(12, 12);
    await sleep(300);
    check('点遮罩不会关闭设置对话框',
      await cdp.eval('!document.querySelector("#dlg-settings").classList.contains("hidden")'));
    await cdp.eval('document.querySelector("#st-btn-save").click()');
    await cdp.waitFor('document.querySelector("#dlg-settings").classList.contains("hidden")');

    // --- 新建专辑对话框：类型 / 测试连接 / 遮罩点击 / Esc 保护
    await cdp.eval('document.querySelector("#btn-new-album").click()');
    await cdp.waitFor('!document.querySelector("#dlg-album").classList.contains("hidden")');
    const typeOptions = await cdp.eval('Array.from(document.querySelectorAll("#al-type option")).map(function (o) { return o.value + (o.disabled ? ":disabled" : ""); }).join(",")');
    check('新建专辑对话框含 WebDAV 类型', /webdav/.test(typeOptions), typeOptions);
    await cdp.eval('document.querySelector("#al-btn-test").click()');
    await cdp.waitFor('!document.querySelector("#al-test-result").classList.contains("hidden")', 15000, '测试连接结果');
    const testMsg = await cdp.eval('document.querySelector("#al-test-result").textContent.trim()');
    check('空表单测试连接给出提示', /错误|失败|不能为空|请/.test(testMsg), testMsg.slice(0, 80));

    // 输入一半内容，然后点遮罩
    const namePoint = await cdp.center('document.querySelector("#al-name")');
    await cdp.realClick(namePoint.x, namePoint.y);
    await cdp.send('Input.insertText', { text: '测试草稿' });
    await sleep(150);
    await cdp.realClick(12, 12);
    await sleep(300);
    check('点遮罩不会关闭新建专辑对话框',
      await cdp.eval('!document.querySelector("#dlg-album").classList.contains("hidden")'));
    check('已填内容没有因点遮罩丢失',
      (await cdp.eval('document.querySelector("#al-name").value')) === '测试草稿',
      await cdp.eval('document.querySelector("#al-name").value'));

    // Esc：有改动时应先确认；这里让确认框走「取消」，对话框应保持打开
    dialogAccept = false;
    await cdp.pressKey('Escape', 'Escape', 27);
    await sleep(500);
    check('Esc 在有未保存内容时会先弹确认', dialogs.length >= 1, dialogs.join(' | '));
    check('确认框选「取消」后对话框仍然打开',
      await cdp.eval('!document.querySelector("#dlg-album").classList.contains("hidden")'));
    dialogAccept = true;

    // 点「取消」应能直接关掉
    const cancelPoint = await cdp.center('document.querySelector("#dlg-album .modal-foot button[data-close]")');
    await cdp.realClick(cancelPoint.x, cancelPoint.y);
    await sleep(300);
    check('点「取消」可以关闭对话框',
      await cdp.eval('document.querySelector("#dlg-album").classList.contains("hidden")'));

    check('页面无 JS 报错', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' || '));

    const appLog = fs.existsSync(path.join(WORK, 'app.log')) ? fs.readFileSync(path.join(WORK, 'app.log'), 'utf8') : '';
    check('服务端日志无异常', !/unhandledRejection|TypeError|ReferenceError/.test(appLog));
    const mpvLogPath = path.join(WORK, 'mpv.log');
    const mpvLog = fs.existsSync(mpvLogPath) ? fs.readFileSync(mpvLogPath, 'utf8') : '';
    check('mpv 由界面操作启动并打开字幕流', /chs\.srt/.test(mpvLog) && /Opening done:/.test(mpvLog),
      mpvLog ? '' : '未生成 mpv 日志');
  } catch (err) {
    check('UI 测试未抛出异常', false, err.stack || String(err));
  } finally {
    cleanup();
    await sleep(600);
  }

  console.log('');
  console.log(`结果: ${results.filter((r) => r.ok).length}/${results.length} 通过`);
  if (failed) {
    console.log('失败项:');
    for (const x of results.filter((r) => !r.ok)) console.log('  - ' + x.name + (x.detail ? ' :: ' + x.detail : ''));
  }
  console.log('截图与日志: ' + WORK);
  process.exit(failed ? 1 : 0);
})();
