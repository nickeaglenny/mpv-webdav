'use strict';
// HTTP 层测试（离线：不需要 mpv，也不需要浏览器）
//   1. 本机来源校验：挡 DNS rebinding（Host 不是本机）与其它网页的 CSRF（跨站 Origin / Sec-Fetch-Site）
//   2. POST /api/progress：只读本机进度缓存，一次 WebDAV 请求都不发
//   3. 静态文件目录穿越
//
// 用法：node tools/http-test.js
// 端口全部动态分配，数据目录在 tools/.httptest 下，不会碰你正在用的 data/ 与 8787。

const fs = require('fs');
const path = require('path');
const http = require('http');

const { sleep, waitForPort, getFreePort, startNode, makeReporter } = require('./cdp-client');
const wl = require('../server/watchlater');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(__dirname, '.httptest');
const DATA = path.join(WORK, 'data');
const LOG = path.join(WORK, 'app.log');
const DAV_BASE = '/dav';

const { check, summary } = makeReporter();

// ---- 极简 WebDAV 桩：只答 PROPFIND，顺带统计被打了几次（用来证明"没联网"） ----
function startStubDav(port) {
  let hits = 0;
  const response = (href, isDir) =>
    '<D:response>' +
    `<D:href>${href}</D:href>` +
    '<D:propstat><D:prop>' +
    `<D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>` +
    (isDir ? '' : '<D:getcontentlength>1024</D:getcontentlength>') +
    '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>' +
    '</D:response>';

  const server = http.createServer((req, res) => {
    hits++;
    if (req.method === 'PROPFIND') {
      const body = '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">' +
        response(DAV_BASE + '/', true) +
        response(DAV_BASE + '/movie.mkv', false) +
        '</D:multistatus>';
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      return res.end(body);
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('no');
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      server,
      hits: () => hits,
      resetHits: () => { hits = 0; },
    }));
  });
}

// 用 node:http 而不是 fetch：fetch 不允许随便改 Host 头，而这几条测试恰恰要伪造 Host
function raw(port, { method = 'GET', path: p = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const postJson = (port, p, obj, extra) => raw(port, {
  method: 'POST',
  path: p,
  headers: Object.assign({ 'Content-Type': 'application/json' }, extra || {}),
  body: JSON.stringify(obj),
});

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  const DAV_PORT = await getFreePort();
  const APP_PORT = await getFreePort();
  const dav = await startStubDav(DAV_PORT);
  const app = startNode(path.join(ROOT, 'server', 'index.js'), [], {
    MPV_WEBDAV_PORT: String(APP_PORT),
    MPV_WEBDAV_DATA: DATA,
  }, LOG);

  const cleanup = () => {
    try { app.kill(); } catch { /* ignore */ }
    try { dav.server.close(); } catch { /* ignore */ }
  };
  process.on('exit', cleanup);

  try {
    check('应用服务器已启动', await waitForPort(APP_PORT));

    // ---------------- 本机来源校验 ----------------
    let r = await raw(APP_PORT, { path: '/api/health' });
    check('正常本机请求放行', r.status === 200 && r.json && r.json.ok === true, `status=${r.status}`);

    r = await raw(APP_PORT, { path: '/api/health', headers: { Host: 'evil.example' } });
    check('Host 不是本机地址 → 403（挡 DNS rebinding）', r.status === 403, `status=${r.status} ${r.text.slice(0, 60)}`);

    r = await raw(APP_PORT, { path: '/api/health', headers: { Host: `127.0.0.1:${APP_PORT + 1}` } });
    check('Host 端口不对 → 403', r.status === 403, `status=${r.status}`);

    r = await raw(APP_PORT, { path: '/api/health', headers: { Host: `localhost:${APP_PORT}` } });
    check('localhost 也放行', r.status === 200, `status=${r.status}`);

    const newAlbum = {
      name: '外壳测试', type: 'webdav',
      url: `http://127.0.0.1:${DAV_PORT}${DAV_BASE}`, root: '/', auth: 'none',
    };
    const before = await raw(APP_PORT, { path: '/api/albums' });
    r = await postJson(APP_PORT, '/api/albums', newAlbum, { Origin: 'http://evil.example' });
    check('跨站 Origin → 403（挡其它网页的 CSRF）', r.status === 403, `status=${r.status} ${r.text.slice(0, 60)}`);
    const after = await raw(APP_PORT, { path: '/api/albums' });
    check('被拒的请求确实没有建出专辑',
      (after.json && after.json.albums.length) === (before.json && before.json.albums.length),
      `before=${before.json && before.json.albums.length} after=${after.json && after.json.albums.length}`);

    r = await postJson(APP_PORT, '/api/albums', newAlbum, { 'Sec-Fetch-Site': 'cross-site' });
    check('Sec-Fetch-Site: cross-site → 403', r.status === 403, `status=${r.status}`);

    r = await postJson(APP_PORT, '/api/albums', newAlbum, { Origin: `http://127.0.0.1:${APP_PORT}` });
    check('同源 Origin 放行（正常前端请求不受影响）',
      r.status === 200 && !!(r.json && r.json.album), `status=${r.status} ${r.text.slice(0, 80)}`);
    const album = r.json.album;

    // ---------------- POST /api/progress 不碰 WebDAV ----------------
    r = await raw(APP_PORT, { path: `/api/browse?albumId=${album.id}&path=%2F` });
    const entries = (r.json && r.json.entries) || [];
    check('浏览目录可用，且确实访问了 WebDAV（计数器有效）',
      r.status === 200 && dav.hits() > 0 && entries.some((e) => e.name === 'movie.mkv'),
      `hits=${dav.hits()} entries=${entries.map((e) => e.name).join(',')}`);

    dav.resetHits();
    r = await postJson(APP_PORT, '/api/progress', { albumId: album.id, paths: ['/movie.mkv', '/nope.mkv'] });
    check('没有进度时返回空表（不报错）',
      r.status === 200 && r.json && r.json.ok === true && !r.json.progress['/movie.mkv'],
      `status=${r.status} ${r.text.slice(0, 80)}`);
    check('POST /api/progress 一次 WebDAV 请求都没发', dav.hits() === 0, `hits=${dav.hits()}`);

    // 直接往 watch-later 里塞一条（等于 mpv 记过进度），再看接口能不能读出来
    const state = (await raw(APP_PORT, { path: '/api/state' })).json;
    const streamUrl = `http://127.0.0.1:${APP_PORT}/stream/${state.streamToken}/${album.id}/movie.mkv`;
    const wlDir = path.join(DATA, 'cache', 'watch-later');
    fs.mkdirSync(wlDir, { recursive: true });
    fs.writeFileSync(wl.entryFile(wlDir, streamUrl), `# ${streamUrl}\nstart=42.500000\n`, 'utf8');

    r = await postJson(APP_PORT, '/api/progress', { albumId: album.id, paths: ['/movie.mkv', '/nope.mkv'] });
    check('能读出某个文件的已看进度',
      r.status === 200 && !!(r.json.progress['/movie.mkv']) && r.json.progress['/movie.mkv'].pos === 42.5,
      `progress=${JSON.stringify(r.json && r.json.progress)}`);
    check('没进度的文件不出现在结果里', !(r.json.progress['/nope.mkv']));
    check('这次查询同样没碰 WebDAV', dav.hits() === 0, `hits=${dav.hits()}`);

    r = await postJson(APP_PORT, '/api/progress', { albumId: 'alb_nope', paths: ['/movie.mkv'] });
    check('专辑不存在 → 404', r.status === 404, `status=${r.status}`);

    // 前端（浏览器）就是这么发的：同源 + Origin + Sec-Fetch-*，必须放行
    r = await postJson(APP_PORT, '/api/progress', { albumId: album.id, paths: ['/movie.mkv'] },
      { Origin: `http://127.0.0.1:${APP_PORT}`, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' });
    check('浏览器同源请求（Origin + Sec-Fetch-*）放行',
      r.status === 200 && !!(r.json.progress['/movie.mkv']), `status=${r.status} ${r.text.slice(0, 80)}`);

    r = await postJson(APP_PORT, '/api/progress', { albumId: album.id, paths: ['/movie.mkv'] },
      { Origin: 'https://evil.example' });
    check('新接口同样挡跨站来源', r.status === 403, `status=${r.status}`);

    // ---------------- 静态目录穿越 ----------------
    r = await raw(APP_PORT, { path: '/..%2fserver%2findex.js' });
    check('静态目录穿越被拦截', r.status !== 200 || !r.text.includes('require('), `status=${r.status}`);
  } finally {
    cleanup();
    await sleep(120);
    fs.rmSync(WORK, { recursive: true, force: true });
  }

  process.exit(summary());
})();
