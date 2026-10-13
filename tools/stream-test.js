'use strict';
// /stream 流代理的「断流续传」测试（离线：不需要 mpv，也不需要浏览器）
//   1. 正常透传：字节完整，上游只被打一次
//   2. 上游中途断一次 → 自动从断点续传，客户端仍拿到完整文件
//   3. 客户端暂停读取（= mpv 暂停 / 缓存写满）→ 上游连接不许被空闲超时杀掉
//   4. 上游卡死（不发也不关）→ 看门狗触发后续传
//   5. 上游每次都断 → 重试若干次后放弃，并留下一条 error 日志（不再静默跳集）
//
// 用法：node tools/stream-test.js
// 端口全部动态分配，数据目录在 tools/.streamtest 下，不碰你正在用的 data/ 与 8787。

const fs = require('fs');
const path = require('path');
const http = require('http');

const { sleep, waitForPort, getFreePort, startNode, makeReporter } = require('./cdp-client');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(__dirname, '.streamtest');
const DATA = path.join(WORK, 'data');
const LOG = path.join(WORK, 'app.log');
const DAV_BASE = '/dav';
const FILE_SIZE = 8 * 1024 * 1024;
const FILES = ['normal.bin', 'resume.bin', 'pause.bin', 'stall.bin', 'always.bin', 'abort.bin'];

const { check, summary } = makeReporter();

// ---- 内容：确定性伪随机，方便断言「收到的字节和源文件一模一样」 ----
const contentCache = new Map();
function contentOf(name) {
  if (contentCache.has(name)) return contentCache.get(name);
  const buf = Buffer.alloc(FILE_SIZE);
  let x = 2166136261;
  for (const ch of Buffer.from(name)) x = (((x ^ ch) * 16777619) >>> 0);
  for (let i = 0; i < buf.length; i++) { x = ((x * 1664525 + 1013904223) >>> 0); buf[i] = x & 0xff; }
  contentCache.set(name, buf);
  return buf;
}

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// ---- 极简 WebDAV 桩：PROPFIND + 带 Range 的 GET，并可按文件名做手脚 ----
//   flaky: name -> { cutAt, cutEvery, stallAfter }
//     cutAt      第一次 GET 发这么多字节后掐断连接（模拟网络/服务器把长连接弄没）
//     cutEvery   每次 GET 都掐断（用来验证「重试到放弃」）
//     stallAfter 第一次 GET 发这么多字节后卡住不动（不发也不关，模拟上游僵死）
function startStubDav(port) {
  const gets = new Map();      // name -> 上游被请求了几次
  const ranges = new Map();    // name -> 收到的 Range 头
  const closes = new Map();    // name -> 上游连接被提前关掉了几次
  const flaky = new Map();

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    const name = decodeURIComponent(pathname.slice(DAV_BASE.length + 1));

    if (req.method === 'PROPFIND') {
      const one = (n, isDir) =>
        '<D:response><D:href>' + xmlEscape(DAV_BASE + '/' + n + (isDir ? '/' : '')) + '</D:href>'
        + '<D:propstat><D:prop><D:resourcetype>' + (isDir ? '<D:collection/>' : '')
        + '</D:resourcetype>' + (isDir ? '' : '<D:getcontentlength>' + FILE_SIZE + '</D:getcontentlength>')
        + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';
      const body = '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">'
        + one('', true) + FILES.map((f) => one(f, false)).join('') + '</D:multistatus>';
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      return res.end(body);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('405');
    }

    const buf = contentOf(name);
    const n = (gets.get(name) || 0) + 1;
    gets.set(name, n);
    if (req.headers.range) ranges.set(name, (ranges.get(name) || []).concat(String(req.headers.range)));

    let start = 0;
    let end = buf.length - 1;
    let status = 200;
    const m = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range).trim());
    if (m) {
      start = m[1] ? parseInt(m[1], 10) : 0;
      end = m[2] ? Math.min(parseInt(m[2], 10), buf.length - 1) : buf.length - 1;
      status = 206;
    }
    if (start > end || start >= buf.length) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + buf.length });
      return res.end();
    }

    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'ETag': '"' + name + '"',
    };
    if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + buf.length;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();

    const mode = flaky.get(name) || {};
    const total = end - start + 1;
    const cutAt = mode.cutEvery ? Math.floor(total / 2) : (n === 1 && mode.cutAt != null ? mode.cutAt : null);
    const stallAfter = n === 1 && mode.stallAfter != null ? mode.stallAfter : null;

    let sent = 0;
    let stopped = false;
    const step = 64 * 1024;
    const timer = setInterval(() => {
      if (stopped || res.writableEnded || res.destroyed) return;
      if (cutAt != null && sent >= cutAt) {
        stopped = true;
        clearInterval(timer);
        try { res.socket.destroy(); } catch { /* ignore */ }
        return;
      }
      if (stallAfter != null && sent >= stallAfter) {
        stopped = true;                    // 僵死：不发、也不关
        clearInterval(timer);
        return;
      }
      const to = Math.min(start + sent + step, end + 1);
      const chunk = buf.subarray(start + sent, to);
      sent += chunk.length;
      res.write(chunk);
      if (sent >= total) { stopped = true; clearInterval(timer); res.end(); }
    }, 2);
    res.on('close', () => {
      if (!res.writableEnded) closes.set(name, (closes.get(name) || 0) + 1);
      stopped = true;
      clearInterval(timer);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, gets, ranges, closes, flaky }));
  });
}

// 像 mpv 一样读这条流；可选「读到这里就暂停一会儿」（= mpv 暂停 / 缓存写满）
function fetchStream(port, urlPath, { pauseAfter = 0, pauseMs = 0 } = {}) {
  return new Promise((resolve) => {
    const out = { status: 0, bytes: 0, complete: false, chunks: [] };
    let paused = false;
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(out); } };
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'GET',
      headers: { Range: 'bytes=0-' },       // 和 mpv 一样
    }, (res) => {
      out.status = res.statusCode;
      res.on('data', (c) => {
        out.chunks.push(c);
        out.bytes += c.length;
        if (pauseAfter && !paused && out.bytes >= pauseAfter) {
          paused = true;
          res.pause();
          setTimeout(() => res.resume(), pauseMs);
        }
      });
      res.on('end', () => { out.complete = true; done(); });
      res.on('close', done);                // 正常结束时 end 先到；被掐断时只有 close
      res.on('error', done);
    });
    req.on('error', () => done());
    req.end();
  });
}

function sameContent(name, out) {
  const want = contentOf(name);
  if (out.bytes !== want.length) return false;
  return Buffer.concat(out.chunks).equals(want);
}

// 读一点就断开（= mpv 拖动进度条 / 换集时把自己的请求掐掉）
function fetchAndAbort(port, urlPath, afterBytes) {
  return new Promise((resolve) => {
    let bytes = 0;
    let aborted = false;
    const done = () => resolve({ bytes });
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { Range: 'bytes=0-' },
    }, (res) => {
      res.on('data', (c) => {
        bytes += c.length;
        if (!aborted && bytes >= afterBytes) {
          aborted = true;
          try { req.destroy(); } catch { /* ignore */ }
          setTimeout(done, 200);
        }
      });
      res.on('error', () => { /* 断开后必然有 */ });
      res.on('close', () => { if (aborted) done(); });
    });
    req.on('error', () => { if (aborted) done(); });
    req.end();
  });
}

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

const postJson = (port, p, obj) => raw(port, {
  method: 'POST', path: p,
  headers: { 'Content-Type': 'application/json' },
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

  const stopAll = async () => {
    try { app.kill(); } catch { /* ignore */ }
    if (app.exitCode === null && app.signalCode === null) {
      await Promise.race([new Promise((resolve) => app.once('exit', resolve)), sleep(3000)]);
    }
    try { dav.server.close(); } catch { /* ignore */ }
  };
  const removeWork = () => {
    try {
      fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    } catch (err) {
      console.warn('清理 tools/.streamtest 失败（不影响测试结论）：' + err.message);
    }
  };
  process.on('exit', () => { try { app.kill(); } catch { /* ignore */ } });

  try {
    check('应用服务器已启动', await waitForPort(APP_PORT));

    // timeoutMs 调小：老代码就是用它当「socket 空闲超时」把暂停中的流杀掉的（默认 20s，测试等不起）
    const created = await postJson(APP_PORT, '/api/albums', {
      name: '流测试', type: 'webdav',
      url: `http://127.0.0.1:${DAV_PORT}${DAV_BASE}`, root: '/', auth: 'none',
      timeoutMs: 3000, streamStallMs: 700, streamResumeMax: 3,
    });
    const album = created.json && created.json.album;
    check('专辑能带上流式参数', !!album && album.timeoutMs === 3000
      && album.streamStallMs === 700 && album.streamResumeMax === 3,
      JSON.stringify(album && { timeoutMs: album.timeoutMs, stall: album.streamStallMs, max: album.streamResumeMax }));

    const state = (await raw(APP_PORT, { path: '/api/state' })).json;
    const streamPath = (name) => `/stream/${state.streamToken}/${album.id}/${encodeURIComponent(name)}`;

    // ---------------- 1. 正常透传 ----------------
    dav.flaky.clear();
    let r = await fetchStream(APP_PORT, streamPath('normal.bin'));
    check('正常透传：客户端拿到完整且一致的文件',
      r.complete && r.status === 206 && sameContent('normal.bin', r),
      `status=${r.status} bytes=${r.bytes}/${FILE_SIZE} complete=${r.complete}`);
    check('正常透传只打一次上游', dav.gets.get('normal.bin') === 1, `upstream GETs=${dav.gets.get('normal.bin')}`);

    // ---------------- 2. 上游中途断一次 → 断点续传 ----------------
    dav.flaky.set('resume.bin', { cutAt: 2 * 1024 * 1024 });
    r = await fetchStream(APP_PORT, streamPath('resume.bin'));
    check('上游中途断一次 → 自动续传，客户端仍拿到完整且一致的文件',
      r.complete && sameContent('resume.bin', r),
      `bytes=${r.bytes}/${FILE_SIZE} complete=${r.complete}`);
    const resumeRanges = dav.ranges.get('resume.bin') || [];
    check('续传是按断点发的 Range 请求（不是从头重下）',
      resumeRanges.some((x) => /^bytes=[1-9]\d*-\d*$/.test(x)),
      `ranges=${resumeRanges.join(' | ')}`);

    // ---------------- 3. 客户端暂停读取 → 上游不许被空闲超时杀掉 ----------------
    // 这一条正是线上「看到一半突然跳下一集」的成因：mpv 暂停/缓存写满后不再读，
    // 代理背压 → 上游 socket 空闲。以前 album.timeoutMs（这里 3 秒）一到就把连接杀了。
    dav.flaky.clear();
    r = await fetchStream(APP_PORT, streamPath('pause.bin'), { pauseAfter: 256 * 1024, pauseMs: 3500 });
    check('客户端暂停 3.5 秒（> timeoutMs）后继续读，字节依然完整',
      r.complete && sameContent('pause.bin', r),
      `bytes=${r.bytes}/${FILE_SIZE} complete=${r.complete}`);
    check('暂停期间没有把「等 mpv」当成上游卡死而重连',
      dav.gets.get('pause.bin') === 1, `upstream GETs=${dav.gets.get('pause.bin')}`);

    // ---------------- 4. 上游僵死（不发也不关）→ 看门狗 + 续传 ----------------
    dav.flaky.set('stall.bin', { stallAfter: 1 * 1024 * 1024 });
    r = await fetchStream(APP_PORT, streamPath('stall.bin'));
    check('上游卡住不发 → 看门狗触发后续传，客户端仍拿到完整且一致的文件',
      r.complete && sameContent('stall.bin', r),
      `bytes=${r.bytes}/${FILE_SIZE} complete=${r.complete}`);
    check('卡死后确实重开了上游连接',
      (dav.gets.get('stall.bin') || 0) >= 2, `upstream GETs=${dav.gets.get('stall.bin')}`);

    // ---------------- 5. 一直断 → 重试到放弃，但不再静默 ----------------
    dav.flaky.set('always.bin', { cutEvery: true });
    r = await fetchStream(APP_PORT, streamPath('always.bin'));
    check('上游每次都断 → 重试若干次后放弃（客户端拿到的是截断的流）',
      !r.complete && r.bytes < FILE_SIZE, `bytes=${r.bytes}/${FILE_SIZE} complete=${r.complete}`);
    check('重试次数受 streamResumeMax 限制',
      (dav.gets.get('always.bin') || 0) <= 1 + 3, `upstream GETs=${dav.gets.get('always.bin')}`);
    await sleep(400);   // 等日志落盘
    const logText = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
    check('放弃时留下了明确的错误日志（不再静默跳集）',
      /无法续传/.test(logText), logText.split(/\r?\n/).filter((l) => l.includes('[stream]')).slice(-2).join(' // '));

    // ---------------- 6. 客户端中途断开 → 服务不能被带崩 ----------------
    //（mpv 换集 / 拖动进度条时就是这么断开自己那条请求的；写 res 会报 EPIPE，漏处理会整进程退出）
    dav.flaky.clear();
    const aborted = await fetchAndAbort(APP_PORT, streamPath('abort.bin'), 512 * 1024);
    check('客户端中途断开后服务依然健在（没有未捕获错误）',
      (await raw(APP_PORT, { path: '/api/health' })).status === 200,
      `客户端读了 ${aborted.bytes} 字节后断开`);
    check('客户端断开后上游连接也被释放',
      (dav.closes.get('abort.bin') || 0) >= 1, `上游提前关闭次数=${dav.closes.get('abort.bin')}`);
  } catch (err) {
    check('流式测试未抛出异常', false, err && err.message ? err.message : String(err));
  } finally {
    await stopAll();
    removeWork();
  }

  process.exit(summary());
})();
