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

// ------------------------------------------------------------ 本机来源校验 ---
// 服务只监听 127.0.0.1，但"端口在本机"≠"只有本机页面能调用"：
//   · DNS rebinding：恶意站点把自己的域名解析到 127.0.0.1，就能以同源身份读写本接口；
//   · CSRF：其它网页可以用"简单请求"（text/plain 也能带 JSON 体）POST 到本接口，
//     建/改/删专辑、改设置、触发播放。而 readBody 不校验 Content-Type，拦不住。
// 所以在路由入口统一校验：Host 必须是本机地址，带 Origin 的请求必须同源，跨站请求直接拒绝。
// 返回 null 表示放行，否则返回可读的拒绝原因。
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function localRequestProblem(req) {
  const rawHost = String(req.headers.host || '').trim();
  if (!rawHost) return '缺少 Host 头';
  const hostMatch = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(rawHost);
  const hostname = String(hostMatch ? hostMatch[1] : rawHost).toLowerCase();
  const hostPort = hostMatch && hostMatch[2] ? hostMatch[2] : '';
  if (!LOCAL_HOSTNAMES.has(hostname)) return '只允许通过本机地址访问（Host: ' + rawHost + '）';
  if (hostPort && hostPort !== String(PORT)) return '端口与本服务不一致（Host: ' + rawHost + '）';

  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') return '拒绝跨站请求';

  const origin = req.headers.origin;
  if (origin != null && origin !== '' && origin !== 'null') {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return '来源地址不是合法 URL（Origin: ' + origin + '）';
    }
    const originPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    if (!LOCAL_HOSTNAMES.has(parsed.hostname.toLowerCase()) || originPort !== String(PORT)) {
      return '拒绝跨站来源（Origin: ' + origin + '）';
    }
  }
  return null;
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
    // 每个专辑"上次浏览到哪 / 上次播了哪个文件"（有界：条数 = 专辑数）
    views: store.getViews(),
    resume: currentResume(),
    player: mpv.getState(),
  };
}

// -------------------------------------------------------------- discovery ---
// 列一次目录（含字幕子目录），供"一个文件"或"一整段剧集"复用 —— 连播时不给服务器添重复请求
async function subtitleContext(client, settings, dirPath) {
  const { entries } = await client.propfind(dirPath || '/', 1);
  const wanted = (settings.subDirs || []).map((s) => s.toLowerCase());
  const subLists = [];
  for (const d of entries.filter((e) => e.isDir && wanted.includes(e.name.toLowerCase()))) {
    try {
      const sub = await client.propfind(d.path, 1);
      subLists.push(sub.entries);
    } catch {
      /* a missing/unreadable subtitle folder must never block playback */
    }
  }
  return { entries, subLists };
}

// 字幕匹配的唯一实现：列表里的「字幕 ×N」和播放时真正挂上的字幕都走这里，
// 免得两处规则各写一遍、日后漂移（列表显示有字幕、播放却一条都没挂）。
// 纯计算、不联网：
//   entries  ：文件所在目录的条目
//   subLists ：字幕子目录的条目；只是"列目录算个数"时传空数组，省掉额外请求
// 返回按分值排序、最多 16 条（和真正交给 mpv 的条数一致）。
function pickSubtitles(entries, subLists, settings, fileName) {
  const subExts = settings.subExts || [];
  const allSubFiles = (list, penalty) => list
    .filter((e) => !e.isDir && subExts.includes(media.extOf(e.name)))
    .map((s) => ({ name: s.name, path: s.path, score: 40 - penalty }));

  const found = new Map();

  const add = (list, penalty) => {
    for (const m of list) {
      const score = m.score - penalty;
      const prev = found.get(m.path);
      if (!prev || prev.score < score) {
        found.set(m.path, { name: m.name, path: m.path, score });
      }
    }
  };

  const named = media.findSubtitlesIn(entries, fileName, subExts, settings.slang);
  add(named, 0);

  // 文件名规则没命中时，若这个目录里只有一个视频，目录里的字幕就归它。
  // 只在开头算一次（原来每个字幕子目录里都重算一遍，结果一样但白算）。
  const fallback = (!named.length && settings.subFallbackSingleVideo !== false)
    ? media.singleVideoFallback(entries, settings)
    : null;
  const fallbackHit = !!(fallback && fallback.video.name === fileName);
  if (fallbackHit) add(allSubFiles(entries, 0), 0);

  for (const subEntries of subLists || []) {
    add(media.findSubtitlesIn(subEntries, fileName, subExts, settings.slang), 5);
    if (fallbackHit) add(allSubFiles(subEntries, 5), 5);
  }

  return Array.from(found.values())
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 16);
}

// 在已列好的目录清单里给某个文件挑字幕
function subtitlesFor(context, settings, fileName) {
  return pickSubtitles(context.entries, context.subLists, settings, fileName);
}

// 单个文件的字幕（保持原有行为）
async function discoverSubtitles(client, settings, filePath, fileName) {
  const dir = filePath.replace(/[^/]*$/, '') || '/';
  return subtitlesFor(await subtitleContext(client, settings, dir), settings, fileName);
}

// ------------------------------------------------------------ api handlers ---
async function handleBrowse(query) {
  const album = store.findAlbum(query.albumId);
  if (!album) throw Object.assign(new Error('专辑不存在或已被删除'), { status: 404 });
  const rel = normalizeRel(query.path || '/');
  const client = clientFor(album);
  const { entries } = await client.propfind(rel, 1);
  const settings = store.settings;

  const mapped = entries.map((e) => {
    const kind = media.kindOf(e.name, e.isDir, settings);
    const base = { name: e.name, path: e.path, isDir: e.isDir, size: e.size, mtime: e.mtime, ext: media.extOf(e.name), kind };
    if (kind === 'video') {
      // 与播放时真正会挂上的字幕同一个函数（这里不列字幕子目录，省掉额外联网请求）
      base.subtitleCount = pickSubtitles(entries, [], settings, e.name).length;
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

// 只要进度、不要目录：播放结束后界面刷新进度条用它。
// 完全读本机缓存（watch-later + durations），一次 WebDAV 请求都不发 —— 这是它相对
// 「再调一次 /api/browse」的意义：不必为了几条进度条重新 PROPFIND 整个目录、重算字幕。
async function handleProgress(body) {
  const album = store.findAlbum(body && body.albumId);
  if (!album) throw Object.assign(new Error('专辑不存在或已被删除'), { status: 404 });
  const asked = Array.isArray(body.paths) ? body.paths.slice(0, 2000) : [];

  const posMap = new Map(watchlater.scan(WL_DIR).map((e) => [e.key, e]));
  const progress = {};
  const probeWanted = [];
  for (const raw of asked) {
    const rel = normalizeRel(raw);
    if (rel === '/') continue;
    const key = watchlater.keyFor(streamUrl(album.id, rel));
    const found = watchlater.progressFor(posMap.get(key), durations[key]);
    if (!found) continue;
    progress[rel] = found;
    if (!found.dur) probeWanted.push({ albumId: album.id, path: rel });
  }
  if (probeWanted.length) queueDurationProbe(probeWanted);

  return { ok: true, albumId: album.id, progress };
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
  const wantSeries = body.mode === 'series';     // 从这一集开始，连播本目录剩余
  let subtitles = [];
  let context = null;
  if (body.loadSubs !== false || wantSeries) {
    try {
      const dir = rel.replace(/[^/]*$/, '') || '/';
      context = await subtitleContext(client, settings, dir);   // 一次列目录，剧集里每集复用
      subtitles = subtitlesFor(context, settings, name);
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

  // 连播：同目录同类型、自然排序（第2集 在 第10集 前面），从这一集开始到目录末尾，
  // 整段一次性交给 mpv —— 之后的"下一集"由 mpv 自己推进，我们不再同步队列。
  let items = [item];
  let series = null;
  if (wantSeries && context) {
    const list = media.buildSeries(context.entries, name, kind, settings);
    if (list.length > 1) {
      items = list.map((e) => {
        const subs = body.loadSubs === false ? [] : subtitlesFor(context, settings, e.name);
        const it = {
          albumId: album.id,
          path: e.path,
          name: e.name,
          title: e.name,
          url: streamUrl(album.id, e.path),
          subUrls: subs.map((s) => streamUrl(album.id, s.path)),
          subNames: subs.map((s) => s.name),
        };
        if (e.name === name && forceStart != null) it.start = forceStart;
        return it;
      });
      series = { total: items.length, from: name, to: items[items.length - 1].name };
      mpv.emit('log', {
        level: 'info',
        message: `连播：从「${name}」开始，共 ${items.length} 集（到「${series.to}」）`,
      });
    }
  }

  const mode = body.mode === 'append' ? 'append' : 'replace';
  if (entry) {
    mpv.emit('log', { level: 'info', message: `从上次位置继续：${watchlater.describe(entry, name)}` });
  }
  // 记下"这个专辑上次播的是哪个文件"（界面用它在该行打个「上次」标记；浏览目录仍以界面为准）
  store.setView(album.id, { file: rel });
  const player = await mpv.play(items, { mode });

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
    series,
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

  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
  const clientRange = req.headers.range || null;
  // streaming：拿到响应头之后不要再做 socket 空闲超时（见 server/webdav.js）。
  const upstream = await client.open(rel, {
    method,
    range: clientRange,
    ifRange: req.headers['if-range'] || null,
    streaming: method === 'GET',
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
  if (method === 'HEAD') {
    if (upstream.stream) upstream.stream.destroy();
    return res.end();
  }

  // 从这里开始是「真的在搬字节」：断了就断点续传，别让 mpv 看到提前结束的流。
  const name = decodeURIComponent((rel.split('/').pop() || rel));
  const span = responseSpan(status, upstream.headers, clientRange);
  const stallMs = album.streamStallMs === undefined ? STREAM_STALL_MS : album.streamStallMs;
  const resumeMax = album.streamResumeMax === undefined ? STREAM_RESUME_MAX : album.streamResumeMax;
  // 上游换了文件时（ETag/Last-Modified 变了）续传会拿到 200 而不是 206，我们据此放弃，而不是拼错字节
  const validator = upstream.headers['etag'] || upstream.headers['last-modified'] || null;

  let current = upstream;
  let sent = 0;        // 这一条响应已经写给 mpv 的字节数
  let attempts = 0;    // 已经续传过几次
  let clientClosed = false;
  // mpv 断开（换集、退出、拖动进度条）时写 res 会报 EPIPE/ECONNRESET：
  // 没有监听者的话 Node 会把它当未捕获错误，直接把整个服务干掉。
  // （以前这里是 upstream.pipe(res)，pipe 自己带了这个监听；现在是自己写，得自己加。）
  res.on('error', () => { clientClosed = true; });
  res.on('close', () => {
    clientClosed = true;
    try { if (current.stream) current.stream.destroy(); } catch { /* ignore */ }
  });

  try {
    for (;;) {
      try {
        await pumpUpstream(current.stream, res, { stallMs, onBytes: (n) => { sent += n; } });
        break;                                  // 上游把这段字节发完了
      } catch (err) {
        // mpv 自己关的（换集、退出、拖动进度条）：正常，不续传
        if (clientClosed || res.writableEnded || res.destroyed) return;
        if (!span || attempts >= resumeMax) throw err;
        const from = span.start + sent;
        if (span.end != null && from > span.end) break;   // 客户端要的那一段已经发完
        attempts++;
        const wait = Math.min(3000, 300 * attempts);
        const text = `上游数据流中断（${name}：已传 ${sent} 字节 / ${err.message}），`
          + `${wait}ms 后从第 ${from} 字节续传（第 ${attempts}/${resumeMax} 次）`;
        mpv.emit('log', { level: 'warn', message: text });
        console.warn('[stream] ' + text);
        await sleepMs(wait);
        if (clientClosed) return;
        const next = await client.open(rel, {
          method: 'GET',
          range: `bytes=${from}-${span.end != null ? span.end : ''}`,
          ifRange: validator,
          streaming: true,
        });
        if (next.status === 416) {              // 已经到文件末尾
          if (next.stream) next.stream.destroy();
          break;
        }
        const nextSpan = responseSpan(next.status, next.headers, `bytes=${from}-`);
        if (!nextSpan || nextSpan.start !== from) {
          if (next.stream) next.stream.destroy();
          throw new Error(`上游不支持从断点续传（返回 HTTP ${next.status}）`);
        }
        current = next;
      }
    }
    if (!clientClosed && !res.writableEnded) res.end();
  } catch (err) {
    if (clientClosed) return;
    const text = `上游数据流中断且无法续传（${name}，已传 ${sent} 字节）：${err.message}`;
    mpv.emit('log', { level: 'error', message: text });
    console.error('[stream] ' + text);
    try { if (current.stream) current.stream.destroy(); } catch { /* ignore */ }
    try { res.destroy(); } catch { /* ignore */ }
  }
}

// ---- 断点续传所需的小工具 -------------------------------------------------
//
// 背景（真机对照实测）：mpv 把「上游字节流被提前切断」当成正常的文件结尾
// （end-file reason=eof、error=none，连 -v 日志都不报），于是静默跳到播放列表的
// 下一集 —— 用户看到的就是「看到一半突然跳到下一集」。而这类切断最常见的来源恰好
// 是「本该没事的空闲」：mpv 暂停 / 缓存写满时停止读取 → 代理背压 → 上游 socket
// 空闲 → WebDAV 服务器、反向代理或我们自己的超时把长连接掐掉。
//
// 所以这里做两件事：① 空闲不再算故障（见 pumpUpstream 的背压处理）；
// ② 真断了就接着传：mpv 读的是一条连续字节流，在断点重发 Range、把剩余字节写进
// 同一个响应，它完全无感（最多觉得这一段慢了一点）。
const STREAM_STALL_MS = 30000;   // 客户端在正常收、上游却这么久没吐字节 → 认定卡死
const STREAM_RESUME_MAX = 5;     // 最多续传几次

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// 这次响应覆盖的是文件里的哪一段？（续传要按绝对偏移重发 Range）
// 返回 null 表示这个上游不能按字节续传（忽略了 Range，或者没给长度）。
function responseSpan(status, headers, clientRange) {
  const len = parseInt(headers['content-length'] || '0', 10);
  if (status === 206) {
    const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(String(headers['content-range'] || ''));
    if (!m) return null;
    return {
      start: parseInt(m[1], 10),
      end: parseInt(m[2], 10),
      total: m[3] === '*' ? null : parseInt(m[3], 10),
    };
  }
  if (status === 200) {
    // 200 = 服务器忽略了 Range：只有「本来就从头开始要」时才能自己算断点
    const m = /bytes=(\d*)-/i.exec(String(clientRange || ''));
    const asked = m && m[1] ? parseInt(m[1], 10) : 0;
    if (asked > 0 || !(len > 0)) return null;
    return { start: 0, end: len - 1, total: len };
  }
  return null;
}

// 把上游的一段字节写给 mpv，直到 end / 出错 / 卡死。
//   · 带背压：mpv 不读就暂停上游。「上游没数据」这时是正常的（暂停播放/缓存写满），
//     stallMs 计时会一起停掉，所以暂停播放不会被误判成卡死。
//   · stallMs > 0 时开看门狗：客户端在正常消耗、上游却 stallMs 没吐一个字节 → 认为断了。
function pumpUpstream(src, res, { stallMs, onBytes }) {
  return new Promise((resolve, reject) => {
    let done = false;
    let idle = null;
    let backpressure = false;
    const clearIdle = () => { if (idle) { clearTimeout(idle); idle = null; } };
    const finish = (err) => {
      if (done) return;
      done = true;
      clearIdle();
      src.off('data', onData);
      src.off('end', onEnd);
      src.off('error', onError);
      src.off('aborted', onAborted);
      src.off('close', onClose);
      if (err) reject(err); else resolve();
    };
    const armIdle = () => {
      clearIdle();
      if (!stallMs || done || backpressure) return;
      idle = setTimeout(() => {
        const err = new Error(`上游 ${Math.round(stallMs / 1000)}s 没有数据`);
        try { src.destroy(err); } catch { /* ignore */ }
        finish(err);
      }, stallMs);
    };
    const onData = (chunk) => {
      onBytes(chunk.length);
      if (res.destroyed || res.writableEnded) { finish(new Error('客户端已断开')); return; }
      if (res.write(chunk)) { armIdle(); return; }
      backpressure = true;                 // 下游来不及收：别把「等 mpv」算成上游卡死
      clearIdle();
      src.pause();
      res.once('drain', () => {
        if (done) return;
        backpressure = false;
        armIdle();
        src.resume();
      });
    };
    const onEnd = () => finish(null);
    const onError = (err) => finish(err || new Error('上游流错误'));
    const onAborted = () => finish(new Error('上游连接被中断'));
    const onClose = () => { if (!done) finish(new Error('上游连接提前关闭')); };

    src.on('data', onData);
    src.on('end', onEnd);
    src.on('error', onError);
    src.on('aborted', onAborted);
    src.on('close', onClose);
    armIdle();     // 拿到响应头之后、第一个字节到达之前，同样算「在等上游」
  });
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
  const publicRoot = path.resolve(PUBLIC_DIR);
  const target = path.resolve(publicRoot, rel);
  // 用 path.relative 判越界：startsWith 会把同前缀的兄弟目录（如 public-old）误判成"在目录内"
  const relToRoot = path.relative(publicRoot, target);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
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

  // 所有入口（含 mpv 抓取的 /stream）都先过一遍本机来源校验，见 localRequestProblem()
  const rejected = localRequestProblem(req);
  if (rejected) return sendJson(res, 403, { ok: false, error: rejected });

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

  // ---- 每个专辑"上次浏览到哪"（界面切目录时上报；播放时由服务端补记"上次播的文件"）
  if (pathname === '/api/views' && method === 'GET') {
    return sendJson(res, 200, { ok: true, views: store.getViews() });
  }
  const viewMatch = /^\/api\/views\/([^/]+)$/.exec(pathname);
  if (viewMatch && method === 'PUT') {
    const id = decodeURIComponent(viewMatch[1]);
    if (!store.findAlbum(id)) return sendJson(res, 404, { ok: false, error: '专辑不存在' });
    const body = await readBody(req);
    const saved = store.setView(id, body && typeof body === 'object' ? body : {});
    return sendJson(res, 200, { ok: true, view: saved });
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

  // ---- progress（只读本机缓存，不碰 WebDAV）
  if (pathname === '/api/progress' && method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, await handleProgress(body));
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
