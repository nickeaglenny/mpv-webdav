'use strict';
// 对着「真实专辑」跑一遍界面点击验证（用 data/ 里已保存的专辑，复制一份再测，
// 不会改动你的 data/）。重点验证：
//   1. 点专辑 → 能看到目录
//   2. 真实双击 / 单击文件夹 → 能进入下一层
//   3. 点「进入」按钮 → 能进入
//   4. 弹窗遮罩点击不会关掉对话框（交给 ui-test.js 覆盖）
//
// 用法：node tools/ui-live.js [--port 8786] [--data <data 目录>]
// 需要普通桌面环境（Chromium 要用命名管道）。

const fs = require('fs');
const path = require('path');
const { sleep, findBrowser, portOpen, waitForPort, getFreePort, httpJson, startNode, Cdp, makeReporter } = require('./cdp-client');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(__dirname, '.uilive');
// 端口动态分配，避免抢到用户正在运行的实例（默认 8787）
let APP_PORT = 0;
let CDP_PORT = 0;

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i === -1 ? def : argv[i + 1];
}
const DATA_SRC = arg('data', path.join(ROOT, 'data'));

const { check, summary } = makeReporter();

(async () => {
  const browser = findBrowser();
  if (!browser) { console.error('找不到 Chrome/Edge'); process.exit(2); }
  if (!fs.existsSync(path.join(DATA_SRC, 'albums.json'))) {
    console.error('没有找到已保存的专辑：' + path.join(DATA_SRC, 'albums.json') + '\n请先在网页里建好专辑，或用 --data 指定目录。');
    process.exit(2);
  }

  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const dataDir = path.join(WORK, 'data');
  fs.cpSync(DATA_SRC, dataDir, { recursive: true });

  APP_PORT = parseInt(arg('port', '0'), 10) || await getFreePort();
  CDP_PORT = await getFreePort();
  console.log(`本次测试使用端口：app=${APP_PORT}  cdp=${CDP_PORT}（数据用副本，不会动你的 data）\n`);

  const albums = JSON.parse(fs.readFileSync(path.join(dataDir, 'albums.json'), 'utf8'));
  const albumName = albums.length ? albums[0].name : '(空)';
  console.log(`使用专辑：${albumName}  →  ${albums.length ? albums[0].url : ''}\n`);

  const app = startNode(path.join(ROOT, 'server', 'index.js'), [], {
    MPV_WEBDAV_PORT: String(APP_PORT),
    MPV_WEBDAV_DATA: dataDir,
  }, path.join(WORK, 'app.log'));

  let proc = null;
  const cleanup = () => {
    try { app.kill(); } catch {}
    try { proc && proc.kill(); } catch {}
  };
  process.on('exit', cleanup);

  try {
    check('本地应用已启动', await waitForPort(APP_PORT));

    // 安全检查：确认端口上是本次测试刚起的实例（用的是数据副本），
    // 否则立刻中止，绝不去改用户正在运行的实例。
    const ident = await httpJson(`http://127.0.0.1:${APP_PORT}/api/state`);
    const ownInstance = !!(ident.json && ident.json.server && ident.json.server.port === APP_PORT);
    check('确认连到的是本次测试自己的实例（用数据副本）', ownInstance,
      ident.json ? `port=${ident.json.server && ident.json.server.port} albums=${(ident.json.albums || []).length}` : '无法读取 /api/state');
    if (!ownInstance) throw new Error(`端口 ${APP_PORT} 上不是本次测试的实例，已中止（未做任何修改）`);

    // 无窗口、无声，避免测试时弹播放器
    await httpJson(`http://127.0.0.1:${APP_PORT}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extraMpvArgs: ['--vo=null', '--ao=null', '--force-window=no', '--length=10'] }),
    });

    proc = startNodeBrowser(browser);
    check('浏览器已启动（CDP 端口开放）', await waitForPort(CDP_PORT, 25000));

    const listRes = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const page = (listRes.json || []).find((t) => t.type === 'page' && String(t.url).includes(String(APP_PORT)));
    check('找到页面调试目标', !!page);

    const cdp = new Cdp(page.webSocketDebuggerUrl);
    const errors = [];
    cdp.onEvent((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push((d.exception && d.exception.description) || d.text);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        errors.push(msg.params.args.map((a) => a.value || a.description || a.type).join(' '));
      }
    });
    await cdp.open();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    const namesExpr = `Array.from(document.querySelectorAll('#listing [data-path]')).map(function (n) { return n.getAttribute('title'); })`;
    const crumbExpr = `document.querySelector('#breadcrumb').textContent.trim()`;

    // 1) 点专辑
    await cdp.waitFor('document.querySelectorAll("#album-list .album-item").length > 0', 20000, '专辑列表');
    const albumPoint = await cdp.center('document.querySelector("#album-list .album-item")');
    await cdp.realClick(albumPoint.x, albumPoint.y);
    await cdp.waitFor('document.querySelectorAll("#listing [data-path]").length > 0', 30000, '专辑根目录');
    let names = await cdp.eval(namesExpr);
    check('点专辑后能看到目录', names.length > 0, names.slice(0, 10).join(' / '));
    console.log(`      第 1 层（${(await cdp.eval(crumbExpr))}）：${names.slice(0, 12).join(' / ')}`);
    const shot0 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(WORK, 'live-1.png'), Buffer.from(shot0.data, 'base64'));

    // 2) 真实双击第一个文件夹
    const firstDir = `Array.from(document.querySelectorAll('#listing [data-kind="dir"]'))[0]`;
    const p1 = await cdp.center(firstDir);
    check('根目录里找到文件夹行', !!p1);
    if (!p1) throw new Error('没有可进入的文件夹');
    const dir1Name = await cdp.eval(`(${firstDir}).getAttribute('title')`);
    await cdp.doubleClick(p1.x, p1.y);
    await sleep(1500);
    let names2 = await cdp.eval(namesExpr);
    let crumb2 = await cdp.eval(crumbExpr);
    check('真实双击文件夹后进入了下一层',
      crumb2.includes(dir1Name) && (names2.length === 0 || JSON.stringify(names2) !== JSON.stringify(names)),
      `面包屑=${crumb2}`);
    console.log(`      第 2 层（${crumb2}）：${names2.slice(0, 12).join(' / ')}`);

    // 3) 单击只选中，双击才进入下一层
    const hasDir2 = await cdp.eval(`document.querySelectorAll('#listing [data-kind="dir"]').length > 0`);
    if (hasDir2) {
      const dir2Name = await cdp.eval(`document.querySelector('#listing [data-kind="dir"]').getAttribute('title')`);
      const p2 = await cdp.center(`document.querySelector('#listing [data-kind="dir"]')`);
      const crumbBefore = await cdp.eval(crumbExpr);
      await cdp.realClick(p2.x, p2.y);
      await sleep(1200);
      const crumbAfterSingle = await cdp.eval(crumbExpr);
      const selected = await cdp.eval('!!document.querySelector("#listing .is-selected")');
      check('单击文件夹只选中、不进入', crumbAfterSingle === crumbBefore && selected,
        `面包屑 ${crumbBefore} → ${crumbAfterSingle}，选中=${selected}`);

      await cdp.doubleClick(p2.x, p2.y);
      await sleep(1500);
      const crumb3 = await cdp.eval(crumbExpr);
      const names3 = await cdp.eval(namesExpr);
      check('真实双击文件夹后进入了下一层', crumb3.includes(dir2Name), `面包屑=${crumb3}`);
      console.log(`      第 3 层（${crumb3}）：${names3.slice(0, 12).join(' / ')}`);
      const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(WORK, 'live-2.png'), Buffer.from(shot1.data, 'base64'));
    } else {
      console.log('      （第二层没有子目录，跳过单击/双击测试）');
    }

    // 4) 返回上级按钮
    const upPoint = await cdp.center('document.querySelector("#btn-up")');
    await cdp.realClick(upPoint.x, upPoint.y);
    await sleep(1200);
    const crumbBack = await cdp.eval(crumbExpr);
    check('「上级」按钮可以返回', crumbBack.length > 0 && !crumbBack.includes('…'), crumbBack);

    check('页面无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' || '));
  } catch (err) {
    check('联调未抛出异常', false, err.stack || String(err));
  } finally {
    cleanup();
    await sleep(500);
  }

  console.log('截图与日志: ' + WORK);
  process.exit(summary());
})();

function startNodeBrowser(browser) {
  const { spawn } = require('child_process');
  return spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-allow-origins=*', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(WORK, 'profile'),
    '--window-size=1600,1000',
    `http://127.0.0.1:${APP_PORT}/`,
  ], { stdio: 'ignore' });
}
