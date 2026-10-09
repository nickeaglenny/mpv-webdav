'use strict';
// mpv-webdav — local web app that browses WebDAV albums and plays media with mpv.
// Usage: node server/index.js [port]     (default port 8787, env MPV_WEBDAV_PORT)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { Store } = require('./store');
const { WebDAVClient, WebDAVError, normalizeRel } = require('./webdav');
const media = require('./media');
const textEncoding = require('./text-encoding');
const watchlater = require('./watchlater');
const { MpvController } = require('./mpv');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.MPV_WEBDAV_DATA || path.join(ROOT, 'data');
// 参数解析放在 Node 里（而不是批处理里），这样启动脚本可以保持极简、
// 也不受 .bat 换行符影响：node server/index.js [--open] [--no-browser] [端口]
const ARGS = process.argv.slice(2);
const PORT = parseInt(process.env.MPV_WEBDAV_PORT || ARGS.find((a) => /^\d+$/.test(a)) || '8787', 10);
const OPEN_BROWSER = (process.env.MPV_WEBDAV_OPEN === '1' || ARGS.includes('--open'))
  && !ARGS.includes('--no-browser')
  && process.env.MPV_WEBDAV_NO_BROWSER !== '1';
const HOST = '127.0.0.1';
const VERSION = '1.0.0';

const store = new Store(DATA_DIR, path.join(ROOT, 'mpv', 'mpv.exe'));
// 流地址令牌固定保存在 data/state/instance.json：重启后 URL 不变。
// mpv 的进度文件是以流地址为键的，地址稳定是「让 mpv 自己记进度」的前提。
const TOKEN = store.getOrCreateInstance().streamToken;
const mpv = new MpvController({ store });

const sseClients = new Set();
const clientCache = new Map();

mpv.on('player', (state) => {
  broadcast('player', state);
});
mpv.on('log', (entry) => broadcast('log', entry));

// ------------------------------------------------------- 播放进度（mpv 记账）---
// 进度由 mpv 自己写进 data/cache/watch-later/，我们只做三件事：
//   读出来给界面显示 / 「从头播放」时删掉某一条 / 按上限做 LRU 清理。
// 不再有任何"我们判断何时该存、什么算看完"的状态机。

const WL_DIR = store.watchLaterDir;
watchlater.ensureDir(WL_DIR);              // mpv 不会自己建目录

// 旧版把进度存在 data/state/recent.json：搬进 state/ 再转成 mpv 的格式（一次性）
store.migrateLegacySnapshot();
migrateLegacySnapshot();

function wlUrlFor(albumId, relPath) {
  return streamUrl(albumId, relPath);   // 与 mpv 实际请求的地址完全一致（键 = MD5(该地址)）
}

// 「最近有进度的那一条」→ 界面需要的形状
function currentResume() {
  for (const entry of watchlater.scan(WL_DIR)) {
    const parsed = watchlater.parseStreamUrl(entry.target, TOKEN);
    if (!parsed) continue;                                  // 不是我们这台实例的地址（换过端口/token）
    const album = store.albums.find((a) => a.id === parsed.albumId);
    if (!album) continue;                                   // 专辑已被删掉
    return {
      albumId: parsed.albumId,
      path: parsed.path,
      name: parsed.path.split('/').pop() || parsed.path,
      pos: entry.pos,
      updatedAt: entry.updatedAt,
    };
  }
  return null;
}

// ---- 时长缓存（列表里的进度条需要"总时长"，mpv 只存"已看多少秒"）--------------
const DUR_FILE = path.join(store.cacheDir, 'durations.json');
let durations = watchlater.loadDurations(DUR_FILE);
let durationsSaveTimer = null;

function saveDurationsSoon() {
  if (durationsSaveTimer) return;
  durationsSaveTimer = setTimeout(() => {
    durationsSaveTimer = null;
    watchlater.saveDurations(DUR_FILE, durations);
  }, 1500);
  if (durationsSaveTimer.unref) durationsSaveTimer.unref();
}

function rememberDuration(albumId, rel, dur) {
  if (!albumId || !rel || !(dur > 0)) return;
  const key = watchlater.keyFor(streamUrl(albumId, rel));
  const prev = durations[key];
  if (prev && prev.dur > 0 && Math.abs(prev.dur - dur) < 0.5) return;
  durations[key] = { dur, updatedAt: Date.now() };
  saveDurationsSoon();
}

// 老文件（有进度但没记过时长，比如升级前看的）补探一次时长：
// 顺序执行、每次最多 3 个、只在没有在播时做；探过但拿不到时长的 7 天后再试
const probeQueue = [];
let probing = false;

function needsDuration(key) {
  const d = durations[key];
  if (!d) return true;
  if (d.dur > 0) return false;
  return Date.now() - (d.updatedAt || 0) > 7 * 24 * 3600 * 1000;
}

function queueDurationProbe(items) {
  let added = 0;
  for (const it of items) {
    if (added >= 3) break;
    const key = watchlater.keyFor(streamUrl(it.albumId, it.path));
    if (!needsDuration(key)) continue;
    if (probeQueue.some((q) => q.key === key)) continue;
    probeQueue.push({ key, albumId: it.albumId, path: it.path, url: streamUrl(it.albumId, it.path) });
    added++;
  }
  runProbeQueue();
}

async function runProbeQueue() {
  if (probing || !probeQueue.length) return;
  probing = true;
  try {
    while (probeQueue.length) {
      if (mpv.isBusy()) return;                       // 正在看片就不打扰
      const job = probeQueue.shift();
      const dur = await mpv.probeDuration(job.url);
      durations[job.key] = { dur: dur || 0, updatedAt: Date.now() };
      saveDurationsSoon();
      if (dur > 0) {
        const progress = watchlater.progressFor(watchlater.readEntry(WL_DIR, job.url), durations[job.key]);
        if (progress) broadcast('progress', { albumId: job.albumId, path: job.path, progress });
      }
    }
  } finally {
    probing = false;
  }
}

mpv.on('duration', (info) => rememberDuration(info.albumId, info.path, info.duration));

function pruneWatchLater() {
  const s = store.settings;
  try {
    const r = watchlater.prune(WL_DIR, {
      maxEntries: s.watchLaterMaxEntries,
      maxAgeDays: s.watchLaterMaxDays,
    });
    if (r.removed > 0) {
      mpv.emit('log', { level: 'info', message: `已清理 ${r.removed} 条过期播放进度（保留上限 ${s.watchLaterMaxEntries} 条 / ${s.watchLaterMaxDays} 天）` });
    }
    // 进度条目没了，对应的时长缓存也跟着清掉（内存同步更新）
    const live = new Set(watchlater.scan(WL_DIR).map((e) => e.key));
    const dr = watchlater.pruneDurations(DUR_FILE, live);
    if (dr.removed > 0) durations = watchlater.loadDurations(DUR_FILE);
    return r;
  } catch (err) {
    mpv.emit('log', { level: 'warn', message: '清理播放进度失败：' + err.message });
    return null;
  }
}

// 把旧版本"我们自己记的进度快照"转成 mpv 的条目（一次性），然后删掉快照
function migrateLegacySnapshot() {
  const snapshot = path.join(store.stateDir, 'recent.json');
  if (!fs.existsSync(snapshot)) return null;
  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  } catch (err) {
    const quarantine = path.join(store.stateDir, 'recent.json.corrupt');
    if (!fs.existsSync(quarantine)) {
      try {
        fs.renameSync(snapshot, quarantine);
        console.warn('[migrate] 旧进度快照无法解析，已挪到 data/state/recent.json.corrupt（内容未改动）');
      } catch { /* 挪不动就留着 */ }
    }
    return null;
  }
  if (record && record.albumId && record.path && Number(record.pos) > 0) {
    const r = watchlater.migrateLegacyRecord(WL_DIR, streamUrl(record.albumId, record.path), record.pos);
    if (r && !r.skipped) {
      console.log(`[migrate] 已把旧进度转成 mpv 的条目：${record.path} @ ${watchlater.formatClock(record.pos)}`);
    }
  } else {
    console.log('[migrate] 旧进度快照里没有可用的进度（为空），不生成新条目');
  }
  // 只删掉这个已经没用的快照主文件；**它的 .bak 属于用户数据，保留在原地**（README 里有说明，可随手删）
  try {
    fs.rmSync(snapshot, { force: true });
    if (fs.existsSync(snapshot + '.bak')) {
      console.log('[migrate] 旧快照的备份保留在 data/state/recent.json.bak（不再使用，可随时删）');
    }
    console.log('[migrate] 进度现在由 mpv 记在 data/cache/watch-later/');
  } catch { /* 删不掉也不影响 */ }
  return record;
}

// ---------------------------------------------------------------- helpers ---
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, err) {
  const status = err && err.status ? err.status : 500;
  const message = err && err.message ? err.message : String(err);
  if (status >= 500) console.error('[error]', message);
  sendJson(res, status, { ok: false, error: message });
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function clientFor(album) {
  let client = clientCache.get(album.id);
  if (!client || client.album !== album) {
    client = new WebDAVClient(album);
    clientCache.set(album.id, client);
  }
  return client;
}

function invalidateClient(albumId) {
  clientCache.delete(albumId);
}

function streamUrl(albumId, relPath) {
  const enc = normalizeRel(relPath).split('/').map((s) => encodeURIComponent(s)).join('/');
  // The token lives in the path (not the query) so mpv's track list shows clean
  // file names such as "movie.chs.srt" instead of "...srt?t=abc".
  return `http://${HOST}:${PORT}/stream/${TOKEN}/${albumId}${enc}`;
}

function detectMpvVersion() {
  return new Promise((resolve) => {
    const exe = store.settings.mpvPath;
    if (!exe) return resolve(null);
    try {
      if (!fs.existsSync(exe)) return resolve(null);
      const child = execFile(exe, ['--version'], { timeout: 10000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const first = String(stdout).split(/\r?\n/)[0] || '';
        const m = /mpv\s+v?([^\s]+)/i.exec(first);
        resolve(m ? m[1] : first.trim() || null);
      });
      child.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

let mpvVersionCache = null;
async function mpvVersion() {
  if (mpvVersionCache === undefined || mpvVersionCache === null) {
    mpvVersionCache = await detectMpvVersion();
  }
  return mpvVersionCache;
}

async function buildState() {
  return {
    app: 'mpv-webdav',
    version: VERSION,
    streamToken: TOKEN,
    server: { host: HOST, port: PORT, url: `http://${HOST}:${PORT}/` },
    mpv: {
      path: store.settings.mpvPath,
      found: !!(store.settings.mpvPath && fs.existsSync(store.settings.mpvPath)),
      version: await mpvVersion(),
      mode: mpv.mode,
    },
    settings: store.publicSettings(),
    albums: store.listAlbums(),
    resume: currentResume(),
    player: mpv.getState(),
  };
}

// -------------------------------------------------------------- discovery ---
async function discoverSubtitles(client, settings, filePath, fileName) {
  const dir = filePath.replace(/[^/]*$/, '') || '/';
  const found = new Map();

  const add = (list, penalty) => {
    for (const m of list) {
      const prev = found.get(m.path);
      if (!prev || prev.score < m.score - penalty) {
        found.set(m.path, { name: m.name, path: m.path, score: m.score - penalty });
      }
    }
  };

  const { entries } = await client.propfind(dir, 1);
  const named = media.findSubtitlesIn(entries, fileName, settings.subExts, settings.slang);
  add(named, 0);

  // 文件名规则没命中时，若这个目录里只有一个视频，目录里的字幕就归它
  if (!named.length && settings.subFallbackSingleVideo !== false) {
    const fb = media.singleVideoFallback(entries, settings);
    if (fb && fb.video.name === fileName) {
      add(fb.subs.map((s) => ({ name: s.name, path: s.path, score: 40 })), 0);
    }
  }

  const wanted = (settings.subDirs || []).map((s) => s.toLowerCase());
  const subdirs = entries.filter((e) => e.isDir && wanted.includes(e.name.toLowerCase()));
  for (const d of subdirs) {
    try {
      const sub = await client.propfind(d.path, 1);
      add(media.findSubtitlesIn(sub.entries, fileName, settings.subExts, settings.slang), 5);
      if (!named.length && settings.subFallbackSingleVideo !== false) {
        const fb = media.singleVideoFallback(entries, settings);
        if (fb && fb.video.name === fileName) {
          add(sub.entries
            .filter((e) => !e.isDir && (settings.subExts || []).includes(media.extOf(e.name)))
            .map((s) => ({ name: s.name, path: s.path, score: 40 })), 5);
        }
      }
    } catch {
      /* a missing/unreadable subtitle folder must never block playback */
    }
  }

  return Array.from(found.values())
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 16);
}

// ------------------------------------------------------------ api handlers ---
async function handleBrowse(query) {
  const album = store.findAlbum(query.albumId);
  if (!album) throw Object.assign(new Error('专辑不存在或已被删除'), { status: 404 });
  const rel = normalizeRel(query.path || '/');
  const client = clientFor(album);
  const { entries } = await client.propfind(rel, 1);
  const settings = store.settings;

  const subExts = settings.subExts;
  const mapped = entries.map((e) => {
    const kind = media.kindOf(e.name, e.isDir, settings);
    const base = { name: e.name, path: e.path, isDir: e.isDir, size: e.size, mtime: e.mtime, ext: media.extOf(e.name), kind };
    if (kind === 'video') {
      base.subtitleCount = media.findSubtitlesIn(entries, e.name, subExts, settings.slang).length;
      if (!base.subtitleCount && settings.subFallbackSingleVideo !== false) {
        const fb = media.singleVideoFallback(entries, settings);
        if (fb && fb.video.name === e.name) base.subtitleCount = fb.subs.length;
      }
    }
    return base;
  });

  // 播放进度：一次扫描 watch-later 目录，再逐条查表 —— 不给 WebDAV 服务器添任何额外请求
  const posMap = new Map(watchlater.scan(WL_DIR).map((e) => [e.key, e]));
  const probeWanted = [];
  for (const e of mapped) {
    if (e.isDir || (e.kind !== 'video' && e.kind !== 'audio')) continue;
    const key = watchlater.keyFor(streamUrl(album.id, e.path));
    const progress = watchlater.progressFor(posMap.get(key), durations[key]);
    if (!progress) continue;
    e.progress = progress;
    if (!progress.dur) probeWanted.push({ albumId: album.id, path: e.path });
  }
  if (probeWanted.length) queueDurationProbe(probeWanted);

  return { ok: true, albumId: album.id, path: rel, parent: rel === '/' ? null : rel.replace(/\/[^/]*$/, '') || '/', entries: mapped };
}

async function handleTest(body) {
  const started = Date.now();
  const album = Store.sanitize(body, body && body.id ? store.findAlbum(body.id) || undefined : undefined);
  const client = new WebDAVClient(album);
  const { entries } = await client.propfind('/', 1);
  const dirs = entries.filter((e) => e.isDir).length;
  const files = entries.length - dirs;
  return {
    ok: true,
    status: 207,
    entries: entries.length,
    message: `连接成功：${dirs} 个文件夹 / ${files} 个文件`,
    elapsedMs: Date.now() - started,
  };
}

async function handlePlay(body) {
  const album = store.findAlbum(body.albumId);
  if (!album) throw Object.assign(new Error('专辑不存在或已被删除'), { status: 404 });
  const rel = normalizeRel(body.path);
  const name = decodeURIComponent(rel.split('/').filter(Boolean).pop() || '');
  const settings = store.settings;
  const kind = media.kindOf(name, false, settings);
  if (!media.isPlayable(kind)) throw Object.assign(new Error('该类型暂不支持播放：' + name), { status: 400 });

  const client = clientFor(album);
  let subtitles = [];
  if (body.loadSubs !== false) {
    try {
      subtitles = await discoverSubtitles(client, settings, rel, name);
    } catch (err) {
      mpv.emit('log', { level: 'warn', message: '字幕扫描失败：' + err.message });
    }
  }

  // 续播交给 mpv：它自己会在加载时读取 watch-later 里的 start。
  // 「从头播放」两手都要：①删掉那条进度（界面/接口不再报它）②显式 start=0，
  // 因为 mpv 在**同文件重载**时会先把旧位置存回去，只删文件会被立刻写回来。
  const url = streamUrl(album.id, rel);
  let entry = null;
  let forceStart = null;
  if (body.resume === false) {
    const removed = watchlater.removeEntry(WL_DIR, url);
    forceStart = 0;
    if (removed) mpv.emit('log', { level: 'info', message: `已清除该文件的播放进度（从头播放）：${name}` });
  } else {
    entry = watchlater.readEntry(WL_DIR, url);
  }

  const item = {
    albumId: album.id,
    path: rel,
    name,
    title: name,
    url,
    subUrls: subtitles.map((s) => streamUrl(album.id, s.path)),
    subNames: subtitles.map((s) => s.name),
  };
  if (forceStart != null) item.start = forceStart;

  const mode = body.mode === 'append' ? 'append' : 'replace';
  if (entry) {
    mpv.emit('log', { level: 'info', message: `从上次位置继续：${watchlater.describe(entry, name)}` });
  }
  const player = await mpv.play([item], { mode });

  if (forceStart === 0) {
    // mpv 在"同文件重载"时会把旧位置又写回条目（实测），所以加载完之后再清一次，
    // 让「从头播放」真的从零开始记账（之后的停止/退出仍由 mpv 正常保存）。
    const timer = setTimeout(() => watchlater.removeEntry(WL_DIR, url), 700);
    if (timer.unref) timer.unref();
  }

  return {
    ok: true,
    item: { albumId: album.id, path: rel, name, title: name },
    subtitles: item.subNames,
    resumed: entry ? entry.pos : null,
    resumedText: entry ? `${name} · ${watchlater.formatClock(entry.pos)}` : '',
    player,
  };
}

// --------------------------------------------------------------- streaming --
// 字幕文件先转成 UTF-8 再转发：中文影视库里大量 .srt/.ass 是 GBK/BIG5，
// mpv 按 UTF-8 解出来就是 ÎÒh»á¹yz 这种乱码。成功返回 true。
async function streamSubtitleAsUtf8(req, res, client, album, rel, settings) {
  const upstream = await client.open(rel, { method: 'GET' });
  if (upstream.status !== 200) {
    if (upstream.stream) upstream.stream.destroy();
    return false;
  }
  const limit = settings.subTranscodeMaxBytes || 8 * 1024 * 1024;
  const declared = parseInt(upstream.headers['content-length'] || '0', 10);
  if (declared && declared > limit) {
    if (upstream.stream) upstream.stream.destroy();
    return false;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of upstream.stream) {
    size += chunk.length;
    if (size > limit) {
      upstream.stream.destroy();
      return false;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks);
  const forced = settings.subEncoding && settings.subEncoding !== 'auto' ? settings.subEncoding : null;
  const { buffer, encoding, changed } = textEncoding.toUtf8Buffer(raw, { force: forced });
  if (changed) {
    mpv.emit('log', {
      level: 'info',
      message: `字幕编码 ${encoding.toUpperCase()} → UTF-8：${decodeURIComponent((rel.split('/').pop() || ''))}`,
    });
  }
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
  return true;
}

async function handleStream(req, res, query, token, albumId, relPath) {
  if (!safeEqual(token, TOKEN)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }
  const album = store.findAlbum(albumId);
  if (!album) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('album not found');
  }
  const client = clientFor(album);
  const rel = normalizeRel(decodeURIComponent(relPath || '/'));
  const settings = store.settings;

  // 字幕走转码通道（视频/音频仍然直接 Range 透传）
  const ext = media.extOf(rel);
  const isSubtitle = (settings.subExts || []).includes(ext);
  if (isSubtitle && settings.subEncoding !== 'off' && req.method !== 'HEAD') {
    try {
      if (await streamSubtitleAsUtf8(req, res, client, album, rel, settings)) return;
    } catch (err) {
      if (res.headersSent) { try { res.destroy(); } catch {} return; }
      mpv.emit('log', { level: 'warn', message: '字幕转码失败，按原始字节转发：' + err.message });
    }
  }

  const upstream = await client.open(rel, {
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    range: req.headers.range || null,
    ifRange: req.headers['if-range'] || null,
  });

  const status = upstream.status || 200;
  if (status >= 400) {
    if (upstream.stream) upstream.stream.destroy();
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('upstream HTTP ' + status);
  }

  const headers = {};
  const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
  for (const key of pass) {
    if (upstream.headers[key] !== undefined) headers[key] = upstream.headers[key];
  }
  if (!headers['accept-ranges']) headers['Accept-Ranges'] = 'bytes';
  headers['Cache-Control'] = 'no-store';

  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    if (upstream.stream) upstream.stream.destroy();
    return res.end();
  }

  upstream.stream.on('error', () => { try { res.destroy(); } catch {} });
  res.on('close', () => {
    if (!res.writableEnded && upstream.stream) upstream.stream.destroy();
  });
  upstream.stream.pipe(res);
}

// ------------------------------------------------------------ static files --
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  if (!target.startsWith(path.resolve(PUBLIC_DIR))) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      if (rel !== 'index.html') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 not found');
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('前端文件缺失：public/index.html');
    }
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    fs.createReadStream(target).pipe(res);
  });
}

// ------------------------------------------------------------------- routes --
async function route(req, res, parsed) {
  const { pathname, searchParams: query } = parsed;
  const method = req.method.toUpperCase();

  // ---- SSE
  if (pathname === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    res.write(`event: player\ndata: ${JSON.stringify(mpv.getState())}\n\n`);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 20000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  // ---- state
  if (pathname === '/api/state' && method === 'GET') return sendJson(res, 200, await buildState());
  if (pathname === '/api/health' && method === 'GET') return sendJson(res, 200, { ok: true, version: VERSION });

  // 优雅退出（托盘「退出」/脚本调用）：需要 streamToken，避免本机其它页面随手关掉服务
  if (pathname === '/api/shutdown' && method === 'POST') {
    const body = await readBody(req);
    if (!safeEqual(body.token || query.get('token') || '', TOKEN)) {
      throw Object.assign(new Error('token 不正确'), { status: 403 });
    }
    sendJson(res, 200, { ok: true, message: '正在退出' });
    setTimeout(() => gracefulShutdown('api'), 80);
    return;
  }

  // ---- albums
  if (pathname === '/api/albums' && method === 'GET') return sendJson(res, 200, { ok: true, albums: store.listAlbums() });
  if (pathname === '/api/albums' && method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, { ok: true, album: store.createAlbum(body) });
  }
  if (pathname === '/api/albums/test' && method === 'POST') {
    const body = await readBody(req);
    try {
      return sendJson(res, 200, await handleTest(body));
    } catch (err) {
      return sendJson(res, 200, { ok: false, status: err.status || 0, entries: 0, message: err.message, elapsedMs: 0 });
    }
  }
  const albumMatch = /^\/api\/albums\/([^/]+)$/.exec(pathname);
  if (albumMatch) {
    const id = decodeURIComponent(albumMatch[1]);
    if (method === 'PUT') {
      const body = await readBody(req);
      invalidateClient(id);
      return sendJson(res, 200, { ok: true, album: store.updateAlbum(id, body) });
    }
    if (method === 'DELETE') {
      invalidateClient(id);
      store.deleteAlbum(id);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'GET') {
      const album = store.findAlbum(id);
      if (!album) throw Object.assign(new Error('专辑不存在'), { status: 404 });
      return sendJson(res, 200, { ok: true, album: store.publicAlbum(album) });
    }
  }

  // ---- 播放进度（进度本身存在 mpv 的 watch-later 目录里，这里只是读取视图）
  if (pathname === '/api/resume' && method === 'GET') {
    const rec = currentResume();
    return sendJson(res, 200, {
      ok: true,
      resume: rec,
      text: rec ? `${rec.name} · ${watchlater.formatClock(rec.pos)}` : '',
      // 顺带把目录规模报给界面/排查用
      entries: watchlater.scan(WL_DIR).length,
      dir: WL_DIR,
    });
  }
  if (pathname === '/api/resume' && method === 'DELETE') {
    // 只清掉"最近这一条"（界面上的 Shift+点击），不要一把清空所有进度
    const rec = currentResume();
    const removed = rec ? watchlater.removeEntry(WL_DIR, wlUrlFor(rec.albumId, rec.path)) : false;
    return sendJson(res, 200, { ok: true, resume: currentResume(), removed });
  }
  if (pathname === '/api/resume/prune' && method === 'POST') {
    return sendJson(res, 200, { ok: true, result: pruneWatchLater(), resume: currentResume() });
  }

  // ---- browse
  if (pathname === '/api/browse' && method === 'GET') {
    return sendJson(res, 200, await handleBrowse({
      albumId: query.get('albumId'),
      path: query.get('path') || '/',
    }));
  }

  // ---- play
  if (pathname === '/api/play' && method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, await handlePlay(body));
  }

  // ---- player
  if (pathname === '/api/player' && method === 'GET') return sendJson(res, 200, { ok: true, player: mpv.getState() });
  if (pathname === '/api/player' && method === 'POST') {
    const body = await readBody(req);
    const player = await mpv.command(body.action, body.value);
    return sendJson(res, 200, { ok: true, player });
  }
  if (pathname === '/api/player/queue' && method === 'DELETE') {
    mpv.clearQueue();
    return sendJson(res, 200, { ok: true, player: mpv.getState() });
  }

  // ---- settings
  if (pathname === '/api/settings' && method === 'GET') return sendJson(res, 200, store.publicSettings());
  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await readBody(req);
    const prevPath = store.settings.mpvPath;
    const prevOntop = store.settings.mpvOntop;
    const prevFullscreen = store.settings.mpvAutoFullscreen;
    const prevWlEntries = store.settings.watchLaterMaxEntries;
    const prevWlDays = store.settings.watchLaterMaxDays;
    const settings = store.updateSettings(body);
    if (settings.mpvPath !== prevPath) mpvVersionCache = null;
    // 进度上限改小了：立刻按新上限清一次，让设置"看起来就是生效的"
    if (settings.watchLaterMaxEntries !== prevWlEntries || settings.watchLaterMaxDays !== prevWlDays) {
      pruneWatchLater();
    }
    mpv.state.volume = settings.volume;
    // 正在播放时改「置顶 / 自动全屏」，立即作用到当前 mpv
    if (settings.mpvOntop !== prevOntop) mpv.applySettingChange('mpvOntop');
    if (settings.mpvAutoFullscreen !== prevFullscreen) mpv.applySettingChange('mpvAutoFullscreen');
    return sendJson(res, 200, { ok: true, settings });
  }

  // ---- stream proxy (consumed by mpv, not by the browser)
  if (pathname.startsWith('/stream/')) {
    const rest = pathname.slice('/stream/'.length);
    const segs = rest.split('/');
    const token = decodeURIComponent(segs.shift() || '');
    const albumId = decodeURIComponent(segs.shift() || '');
    const relPath = '/' + segs.join('/');
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405);
      return res.end('method not allowed');
    }
    return handleStream(req, res, query, token, albumId, relPath);
  }

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { ok: false, error: '未知接口：' + pathname });
  }

  return serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${HOST}:${PORT}`);
  route(req, res, parsed).catch((err) => {
    if (res.headersSent) { try { res.destroy(); } catch {} return; }
    sendError(res, err);
  });
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n[错误] 端口 ${PORT} 已被占用（可能已经有一个 mpv-webdav 在运行了）。`);
    console.error(`       换个端口再启动：start.bat 9000   或   node server\\index.js 9000\n`);
  } else if (err && err.code === 'EACCES') {
    console.error(`\n[错误] 没有权限监听端口 ${PORT}，请换一个 1024 以上的端口。\n`);
  } else {
    console.error('\n[错误] 服务启动失败：' + (err && err.message ? err.message : err) + '\n');
  }
  process.exit(1);
});

server.listen(PORT, HOST, async () => {
  const version = await mpvVersion();
  const found = store.settings.mpvPath && fs.existsSync(store.settings.mpvPath);
  store.setLastPort(PORT);
  console.log('');
  console.log('  mpv-webdav v' + VERSION);
  console.log('  ────────────────────────────────────────────');
  console.log('  控制台:   http://' + HOST + ':' + PORT + '/');
  console.log('  数据目录: ' + DATA_DIR + '   (state/ 状态文件有界 · cache/ 可随手删)');
  console.log('  专辑:     ' + store.albums.length + ' 个' +
    (store.albums.length ? '（' + store.albums.map((a) => a.name).join('、') + '）' : '（还没有专辑，点右上角「+ 新建专辑」）'));
  console.log('  mpv:      ' + (found ? store.settings.mpvPath + (version ? '  (v' + version + ')' : '') : '未找到，请在设置里指定'));
  console.log('  播放进度: mpv 自己记在 data/cache/watch-later/（上限 ' +
    store.settings.watchLaterMaxEntries + ' 条 / ' + store.settings.watchLaterMaxDays + ' 天）');
  console.log('  ────────────────────────────────────────────');
  console.log('  按 Ctrl+C 退出');
  console.log('');
  // 启动后延迟清一次历史进度，之后每天一次（不阻塞启动，也不影响正在播的文件）
  const pruneTimer = setTimeout(pruneWatchLater, 5000);
  if (pruneTimer.unref) pruneTimer.unref();
  const dailyTimer = setInterval(pruneWatchLater, 24 * 3600 * 1000);
  if (dailyTimer.unref) dailyTimer.unref();
  if (OPEN_BROWSER) {
    try {
      const { spawn } = require('child_process');
      spawn('cmd', ['/c', 'start', '', `http://${HOST}:${PORT}/`], { stdio: 'ignore', detached: true }).unref();
    } catch { /* ignore */ }
  }
});

process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });

let shuttingDown = false;
async function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason !== 'api') console.log('\n正在关闭…');
  for (const res of sseClients) { try { res.write('event: bye\ndata: {}\n\n'); res.end(); } catch {} }
  // mpv.shutdown() 内部会先让 mpv 保存当前进度再退出
  try { await mpv.shutdown(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.message ? err.message : err);
});

module.exports = { server, store, mpv, streamUrl };
