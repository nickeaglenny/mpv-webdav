'use strict';
// 诊断脚本：查清 DevTools 真实鼠标事件为什么点不动页面。
//   1) 在 data: 页面上对比几种 Input.dispatchMouseEvent 派发方式，看哪个能触发 click/dblclick
//   2) 在真实应用页面上，打印点击坐标处到底是哪个元素，并试一次点专辑
//
// 用法：node tools/probe-input.js [--app-port 8787]

const fs = require('fs');
const path = require('path');
const { sleep, findBrowser, waitForPort, httpJson, startNode, Cdp } = require('./cdp-client');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(__dirname, '.probe');
const CDP_PORT = 9224;
const argv = process.argv.slice(2);
const appPortIdx = argv.indexOf('--app-port');
const APP_PORT = appPortIdx === -1 ? 8787 : parseInt(argv[appPortIdx + 1], 10);

const TEST_PAGE = 'data:text/html,' + encodeURIComponent(`<!doctype html><meta charset="utf-8">
<style>body{margin:0;font:14px sans-serif}#box{width:300px;height:100px;background:#ccd;margin:20px;display:flex;align-items:center;justify-content:center}#log{margin:20px;white-space:pre}</style>
<div id="box">点我</div><div id="log">-</div>
<script>
var c = { mdown: 0, mup: 0, click: 0, dbl: 0 };
function dump() { document.getElementById('log').textContent = JSON.stringify(c); }
var box = document.getElementById('box');
box.addEventListener('mousedown', function (e) { c.mdown++; c.lastButtons = e.buttons; dump(); });
box.addEventListener('mouseup', function (e) { c.mup++; c.lastButtons = e.buttons; dump(); });
box.addEventListener('click', function (e) { c.click++; c.detail = e.detail; dump(); });
box.addEventListener('dblclick', function () { c.dbl++; dump(); });
</script>`);

async function counters(cdp) {
  return cdp.eval('JSON.stringify({c: window.c, log: document.getElementById("log").textContent})');
}

(async () => {
  const browser = findBrowser();
  if (!browser) { console.error('找不到 Chrome/Edge'); process.exit(2); }
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  const { spawn } = require('child_process');
  const proc = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-allow-origins=*', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(WORK, 'profile'),
    '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' });
  process.on('exit', () => { try { proc.kill(); } catch {} });

  let app = null;
  let mock = null;
  let appStarted = false;
  let mockStarted = false;
  try {
    if (!await waitForPort(CDP_PORT, 25000)) throw new Error('浏览器没起来');

    const listRes = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const page = (listRes.json || []).find((t) => t.type === 'page');
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    // ---------------- 第一部分：哪种派发方式有效 ----------------
    await cdp.send('Page.navigate', { url: TEST_PAGE });
    await cdp.waitFor('!!document.getElementById("box")', 10000, '测试页加载');
    await sleep(300);

    const box = await cdp.center('document.getElementById("box")');
    console.log(`测试页 box 中心 = ${JSON.stringify(box)}`);
    const size = await cdp.eval('JSON.stringify({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})');
    console.log(`视口 = ${size}\n`);

    async function variant(name, fn) {
      await cdp.eval('window.c = { mdown: 0, mup: 0, click: 0, dbl: 0 }; document.getElementById("log").textContent = "-";');
      await fn();
      await sleep(350);
      console.log(`${name.padEnd(34)} => ${await counters(cdp)}`);
    }

    await variant('A 只给 button+clickCount', async () => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    });

    await variant('B 带 buttons 位掩码', async () => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
    });

    await variant('C 带 buttons + 稍等时长', async () => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
      await sleep(60);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
    });

    await variant('D 双击（B 的方式 + clickCount=2）', async () => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(60);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 2 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 2 });
    });

    await variant('E JS 合成 MouseEvent', async () => {
      await cdp.eval(`(function () {
        var b = document.getElementById('box');
        b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, detail: 1 }));
        b.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, detail: 1 }));
        b.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
        return true;
      })()`);
    });

    // ---------------- 第二部分：真实应用页面 ----------------
    const probeApp = argv.includes('--with-app');
    console.log('');
    if (probeApp) {
      if (argv.includes('--with-mock')) {
        mock = startNode(path.join(ROOT, 'tools', 'mock-webdav.js'), [
          '--root', path.join(ROOT, 'tools', 'testdata'), '--port', '8899', '--base', '/dav',
          '--auth', 'basic', '--user', 'tester', '--pass', 'secret',
        ], {}, path.join(WORK, 'mock.log'));
        mockStarted = await waitForPort(8899, 15000);
        console.log(`mock WebDAV 已启动: ${mockStarted}`);
      }
      app = startNode(path.join(ROOT, 'server', 'index.js'), [], {
        MPV_WEBDAV_PORT: String(APP_PORT),
        MPV_WEBDAV_DATA: path.join(WORK, 'data'),
      }, path.join(WORK, 'app.log'));
      appStarted = await waitForPort(APP_PORT, 15000);
      console.log(`应用服务已启动: ${appStarted}`);
      await httpJson(`http://127.0.0.1:${APP_PORT}/api/albums`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '探针', url: mockStarted ? 'http://127.0.0.1:8899/dav' : 'http://127.0.0.1:8899/dav',
          root: '/', username: 'tester', password: 'secret', auth: 'basic',
        }),
      });
      await httpJson(`http://127.0.0.1:${APP_PORT}/api/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extraMpvArgs: ['--vo=null', '--ao=null', '--force-window=no', '--length=5'] }),
      });
    } else {
      console.log('（未加 --with-app，跳过应用页面部分；请确保 8787 上有服务）');
    }

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/` });
    await cdp.waitFor('document.querySelectorAll("#album-list .album-item").length > 0', 20000, '专辑列表');
    const albumPoint = await cdp.center('document.querySelector("#album-list .album-item")');

    // 悬停后各元素的真实占位与命中情况（透明度为 0 的元素照样会吃掉点击）
    const hitInfo = await cdp.eval(`(function () {
      function styleOf(sel) {
        var n = document.querySelector(sel);
        if (!n) return null;
        var cs = getComputedStyle(n), r = n.getBoundingClientRect();
        return { sel: sel, display: cs.display, opacity: cs.opacity, visibility: cs.visibility,
                 pointerEvents: cs.pointerEvents, position: cs.position,
                 rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
      }
      function at(x, y) {
        var el = document.elementFromPoint(x, y);
        return el ? (el.tagName + '.' + el.className + (el.dataset && el.dataset.act ? '[act=' + el.dataset.act + ']' : '')) : null;
      }
      var item = document.querySelector('#album-list .album-item');
      var r = item.getBoundingClientRect();
      return JSON.stringify({
        itemRect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        styles: [styleOf('#album-list .album-item'), styleOf('#album-list .album-item .album-actions'), styleOf('#album-list .album-item .album-name')],
        hitAtCenter: at(r.left + r.width / 2, r.top + r.height / 2),
        hitAtLeft: at(r.left + 30, r.top + r.height / 2),
        hitAtNameTop: at(r.left + 120, r.top + 22)
      });
    })()`);
    console.log('专辑条目命中图: ' + hitInfo);

    // 悬停后（actions 已出现）再看一次中心点是谁
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: albumPoint.x, y: albumPoint.y, buttons: 0 });
    await sleep(300);
    const afterHover = await cdp.eval(`(function () {
      var el = document.elementFromPoint(${albumPoint.x}, ${albumPoint.y});
      var a = document.querySelector('#album-list .album-item .album-actions');
      var n = document.querySelector('#album-list .album-item .album-name');
      var cs = a ? getComputedStyle(a) : null;
      var ar = a ? a.getBoundingClientRect() : null;
      var nr = n ? n.getBoundingClientRect() : null;
      var overlap = (ar && nr) ? !(ar.bottom <= nr.top || ar.top >= nr.bottom) : null;
      return JSON.stringify({
        hitAfterHover: el ? (el.tagName + '.' + el.className + (el.dataset && el.dataset.act ? '[act=' + el.dataset.act + ']' : '')) : null,
        actionsDisplay: cs ? cs.display : null,
        actionsRect: ar ? [Math.round(ar.left), Math.round(ar.top), Math.round(ar.width), Math.round(ar.height)] : null,
        nameRect: nr ? [Math.round(nr.left), Math.round(nr.top), Math.round(nr.width), Math.round(nr.height)] : null,
        nameRowOverlapped: overlap
      });
    })()`);
    console.log('悬停后中心点: ' + afterHover);
    const hoverInfo = JSON.parse(afterHover);
    console.log(`>>> 悬停时操作按钮是否压住专辑名: ${hoverInfo.nameRowOverlapped ? '是（有风险）' : '否（安全）'}`);

    async function appState(label) {
      const s = await cdp.eval(`JSON.stringify({
        rows: document.querySelectorAll('#listing [data-path]').length,
        crumb: document.querySelector('#breadcrumb').textContent.trim(),
        albumDialog: !document.querySelector('#dlg-album').classList.contains('hidden'),
        status: document.querySelector('#status-left').textContent.trim(),
        error: (document.querySelector('#listing .state-msg') || {}).textContent || null
      })`);
      console.log(`  ${label}: ${s}`);
      return JSON.parse(s);
    }

    async function closeIfDialog() {
      const open = await cdp.eval('!document.querySelector("#dlg-album").classList.contains("hidden")');
      if (open) { await cdp.pressKey('Escape', 'Escape', 27); await sleep(400); }
      return open;
    }

    // 真实用户路径：鼠标先移到专辑上（触发悬停），再点专辑名中心
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: albumPoint.x, y: albumPoint.y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: albumPoint.x, y: albumPoint.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(2500);
    const selState = await appState('悬停状态下点专辑名中心');
    console.log(`>>> 结果: ${selState.rows > 0 && !selState.albumDialog ? '正常选中专辑 ✅' : '异常 ❌（rows=' + selState.rows + ', 弹窗=' + selState.albumDialog + '）'}`);
    await closeIfDialog();

    // ---- 目录行命中图
    await cdp.waitFor('document.querySelectorAll("#listing [data-path]").length > 0', 15000, '根目录列表');
    const rowMap = await cdp.eval(`(function () {
      function at(x, y) {
        var el = document.elementFromPoint(x, y);
        if (!el) return null;
        return el.tagName + '.' + el.className + (el.dataset && el.dataset.act ? '[act=' + el.dataset.act + ']' : '');
      }
      var row = document.querySelector('#listing [data-kind="dir"]');
      var r = row.getBoundingClientRect();
      var out = { rowRect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
                  name: row.getAttribute('title'), map: {} };
      [0.05, 0.15, 0.3, 0.5, 0.7, 0.85, 0.97].forEach(function (f) {
        out.map[f] = at(r.left + r.width * f, r.top + r.height / 2);
      });
      var acts = row.querySelector('.col-actions');
      var ar = acts.getBoundingClientRect();
      out.actionsRect = [Math.round(ar.left), Math.round(ar.top), Math.round(ar.width), Math.round(ar.height)];
      return JSON.stringify(out);
    })()`);
    console.log('目录行命中图: ' + rowMap);
    const rowInfo = JSON.parse(rowMap);

    // 真实双击目录行「名称区域」→ 应该进入
    const clickX = rowInfo.rowRect[0] + rowInfo.rowRect[2] * 0.15;
    const clickY = rowInfo.rowRect[1] + rowInfo.rowRect[3] / 2;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(1500);
    await appState('单击目录行名称区域后');

    // 回上级，再真实双击同一行，确认不会连进两层
    const up = await cdp.center('document.querySelector("#btn-up")');
    if (up) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: up.x, y: up.y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: up.x, y: up.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(1200);
      await appState('点「上级」后');
      const row2 = JSON.parse(await cdp.eval(`(function () {
        var r = document.querySelector('#listing [data-kind="dir"]').getBoundingClientRect();
        return JSON.stringify([Math.round(r.left + r.width * 0.15), Math.round(r.top + r.height / 2)]);
      })()`));
      for (const cc of [1, 2]) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: row2[0], y: row2[1], button: 'left', buttons: 1, clickCount: cc });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: row2[0], y: row2[1], button: 'left', buttons: 0, clickCount: cc });
        await sleep(120);
      }
      await sleep(1500);
      await appState('真实双击目录行后');
    }
    await cdp.pressKey('Escape', 'Escape', 27);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(WORK, 'probe.png'), Buffer.from(shot.data, 'base64'));
  } catch (err) {
    console.error('探针异常: ' + (err.stack || err.message));
  } finally {
    try { app && app.kill(); } catch {}
    try { mock && mock.kill(); } catch {}
    try { proc.kill(); } catch {}
    await sleep(400);
  }
  console.log('\n截图: ' + path.join(WORK, 'probe.png'));
  process.exit(0);
})();
