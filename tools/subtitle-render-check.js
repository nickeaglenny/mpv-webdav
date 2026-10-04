'use strict';
// 字幕渲染体检：把同一帧画面渲染两次并输出 PNG，用来直观对比
//   1) 直接用原始 GBK 字幕文件  → 乱码（ÎÒh»á¹yz 那种）
//   2) 通过本应用代理（自动转 UTF-8）→ 正常中文
//
// 用法：node tools/subtitle-render-check.js
// 只用 tools/testdata 里的示例数据，不会碰你的 data/。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { sleep, getFreePort, waitForPort, httpJson, startNode } = require('./cdp-client');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(__dirname, '.rendercheck');
const MPV = path.join(ROOT, 'mpv', 'mpv.exe');
const VIDEO = path.join(__dirname, 'testdata', '编码测试', '胶片.mp4');
const RAW_SUB = path.join(__dirname, 'testdata', '编码测试', '胶片.chs.srt');

function runMpv(args) {
  return new Promise((resolve) => {
    const child = spawn(MPV, args, { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(-1));
  });
}

function shot(outDir, subSource) {
  fs.mkdirSync(outDir, { recursive: true });
  return runMpv([
    '--no-config', '--really-quiet',
    '--vo=image', '--vo-image-outdir=' + outDir, '--vo-image-format=png',
    '--frames=2', '--start=1', '--audio=no', '--no-osc',
    '--sub-file=' + subSource,
    VIDEO,
  ]).then(() => {
    const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.png')).sort();
    return files.length ? path.join(outDir, files[files.length - 1]) : null;
  });
}

(async () => {
  if (!fs.existsSync(MPV)) { console.error('找不到 mpv：' + MPV); process.exit(2); }
  if (!fs.existsSync(VIDEO) || !fs.existsSync(RAW_SUB)) {
    console.error('缺少测试素材，请先运行：powershell -NoProfile -File tools/make-testdata.ps1');
    process.exit(2);
  }
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  const MOCK_PORT = await getFreePort();
  const APP_PORT = await getFreePort();

  const mock = startNode(path.join(__dirname, 'mock-webdav.js'), [
    '--root', path.join(__dirname, 'testdata'), '--port', String(MOCK_PORT),
    '--base', '/dav', '--auth', 'basic', '--user', 'tester', '--pass', 'secret',
  ], {}, path.join(WORK, 'mock.log'));
  const app = startNode(path.join(ROOT, 'server', 'index.js'), [], {
    MPV_WEBDAV_PORT: String(APP_PORT),
    MPV_WEBDAV_DATA: path.join(WORK, 'data'),
  }, path.join(WORK, 'app.log'));
  const cleanup = () => { try { app.kill(); } catch {} try { mock.kill(); } catch {} };
  process.on('exit', cleanup);

  try {
    if (!await waitForPort(MOCK_PORT) || !await waitForPort(APP_PORT)) throw new Error('测试服务没起来');

    const created = await httpJson(`http://127.0.0.1:${APP_PORT}/api/albums`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '渲染体检', type: 'webdav', url: `http://127.0.0.1:${MOCK_PORT}/dav`,
        root: '/', username: 'tester', password: 'secret', auth: 'basic',
      }),
    });
    const album = created.json && created.json.album;
    if (!album) throw new Error('建专辑失败：' + created.text);

    const state = await httpJson(`http://127.0.0.1:${APP_PORT}/api/state`);
    const token = state.json.streamToken;
    const proxySub = `http://127.0.0.1:${APP_PORT}/stream/${token}/${album.id}${encodeURI('/编码测试/胶片.chs.srt')}`;

    console.log('1) 直接用原始 GBK 字幕文件渲染 …');
    const bad = await shot(path.join(WORK, 'raw'), RAW_SUB);
    console.log('2) 通过应用代理（自动转 UTF-8）渲染 …');
    const good = await shot(path.join(WORK, 'proxy'), proxySub);

    console.log('');
    console.log('原始 GBK 字幕   : ' + (bad || '渲染失败'));
    console.log('代理转码后字幕  : ' + (good || '渲染失败'));
    console.log('（用图片查看器打开上面两张图对比：第一张应是乱码，第二张应是正常中文）');

    // 顺便把两张图放到 docs/ 便于查看
    const docs = path.join(ROOT, 'docs');
    fs.mkdirSync(docs, { recursive: true });
    if (bad) fs.copyFileSync(bad, path.join(docs, 'subtitle-gbk-before.png'));
    if (good) fs.copyFileSync(good, path.join(docs, 'subtitle-utf8-after.png'));
    console.log('已复制到 docs\\subtitle-gbk-before.png 与 docs\\subtitle-utf8-after.png');
  } catch (err) {
    console.error('失败：' + (err.stack || err.message));
    process.exitCode = 1;
  } finally {
    cleanup();
    await sleep(300);
  }
})();
