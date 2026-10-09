'use strict';
// Persistence for albums and settings (plain JSON files under ./data).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeRel } = require('./webdav');
const media = require('./media');
const textEncoding = require('./text-encoding');

const DEFAULT_SETTINGS = {
  mpvPath: '',
  extraMpvArgs: [],
  alang: 'zh,chi,zho,eng',
  slang: 'zh,chi,zho,eng',
  volume: 100,
  videoExts: media.DEFAULT_VIDEO_EXTS,
  audioExts: media.DEFAULT_AUDIO_EXTS,
  subExts: media.DEFAULT_SUB_EXTS,
  subDirs: media.DEFAULT_SUB_DIRS,
  subFallbackSingleVideo: true,
  // auto = 自动检测编码并转成 UTF-8；off = 原样转发交给 mpv；也可强制某个编码
  subEncoding: 'auto',
  subTranscodeMaxBytes: 8 * 1024 * 1024,
  // 播放进度由 mpv 自己记（watch-later），这里只定它的清理上限
  watchLaterMaxEntries: 200,  // 最多保留多少条进度
  watchLaterMaxDays: 90,      // 超过多少天没动过的进度自动清掉（0 = 不按天数清）
  // 播放时的 mpv 窗口行为
  mpvOntop: true,             // 播放中把 mpv 窗口置顶（空闲时自动取消，避免挡住桌面）
  mpvAutoFullscreen: false,   // 播放中自动全屏（默认关闭）
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
// 读主文件；主文件缺失/损坏时回退到同目录的 .bak（上一次保存前的版本），
// 这样即使文件被误删或写坏，专辑配置也不会凭空消失。
function readJsonWithBackup(file) {
  let primaryError = null;
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')), recovered: false };
  } catch (err) {
    primaryError = err;
  }
  try {
    const backup = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
    return { value: backup, recovered: true, reason: primaryError.message };
  } catch {
    return { value: undefined, recovered: false, reason: primaryError.message };
  }
}

// 每次覆盖写之前，先把现有内容另存为 <file>.bak
function writeJsonAtomic(file, value, { backup = true } = {}) {
  if (backup) {
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
    } catch {
      /* 备份失败不能影响正常保存 */
    }
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

class Store {
  constructor(dataDir, defaultMpvPath) {
    this.dataDir = dataDir;
    // data/ 分三类，避免越用越乱：
    //   根目录        ：配置（albums.json / settings.json），要备份、别手改坏
    //   state/        ：运行状态（instance.json 固定令牌 / views.json 浏览位置），有界
    //   cache/        ：缓存（watch-later 播放进度等 mpv 自己的文件），整个目录可随手删
    this.stateDir = path.join(dataDir, 'state');
    this.cacheDir = path.join(dataDir, 'cache');
    this.watchLaterDir = path.join(this.cacheDir, 'watch-later');
    this.albumsFile = path.join(dataDir, 'albums.json');
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.viewsFile = path.join(this.stateDir, 'views.json');
    this.instanceFile = path.join(this.stateDir, 'instance.json');
    ensureDir(dataDir);
    ensureDir(this.stateDir);
    ensureDir(this.cacheDir);

    const albumsRead = readJsonWithBackup(this.albumsFile);
    this.albums = Array.isArray(albumsRead.value) ? albumsRead.value : [];
    if (albumsRead.recovered) {
      console.warn('[store] albums.json 无法读取（' + albumsRead.reason + '），已从 albums.json.bak 恢复');
      this.saveAlbums({ backup: false });
    }

    const settingsRead = readJsonWithBackup(this.settingsFile);
    const settingsValue = settingsRead.value && typeof settingsRead.value === 'object' ? settingsRead.value : {};
    if (settingsRead.recovered) {
      console.warn('[store] settings.json 无法读取（' + settingsRead.reason + '），已从 settings.json.bak 恢复');
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settingsValue);
    if (!this.settings.mpvPath) this.settings.mpvPath = defaultMpvPath;
    if (settingsRead.recovered) this.saveSettings({ backup: false });

    // 每个专辑"上次浏览到哪"：体积有界（条数 = 专辑数）；坏了就当空的，不影响启动
    const viewsRead = readJson(this.viewsFile, null);
    this.views = viewsRead && typeof viewsRead === 'object' && !Array.isArray(viewsRead) ? viewsRead : {};
    this.pruneViews();

    this.instance = null;
  }

  // 旧版本把「自管的进度快照」写在 data/last-played.json（后来是 data/state/recent.json）。
  // 现在进度交给 mpv 了，这里只负责把旧快照搬到 state/ 下（不改内容、不解析），
  // 由 index.js 在启动时转成 mpv 的条目后删除。老文件坏掉也不会影响启动。
  migrateLegacySnapshot() {
    const legacy = path.join(this.dataDir, 'last-played.json');
    const target = path.join(this.stateDir, 'recent.json');
    const moved = [];
    try {
      if (!fs.existsSync(legacy)) return moved;
      if (!fs.existsSync(target)) fs.renameSync(legacy, target);
      else fs.rmSync(legacy, { force: true });
      moved.push(target);
      const legacyBak = legacy + '.bak';
      const targetBak = target + '.bak';
      if (fs.existsSync(legacyBak)) {
        if (!fs.existsSync(targetBak)) fs.renameSync(legacyBak, targetBak);
        else fs.rmSync(legacyBak, { force: true });
      }
      console.log('[store] 发现旧版进度快照，已挪到 data/state/recent.json（稍后转成 mpv 的进度）');
      return moved;
    } catch (err) {
      console.warn('[store] 迁移旧进度快照失败（保留原文件）：' + err.message);
      return moved;
    }
  }

  // 固定的一次性令牌：写进 state/instance.json，重启不再变化。
  // 这是「让 mpv 自己记进度」的前提——mpv 的进度文件是以流地址为键的，
  // 地址一变，旧进度就找不回来了。
  getOrCreateInstance() {
    if (this.instance) return this.instance;
    const read = readJsonWithBackup(this.instanceFile);
    const saved = read.value && typeof read.value === 'object' ? read.value : {};
    const valid = typeof saved.streamToken === 'string' && /^[0-9a-f]{32}$/.test(saved.streamToken);
    if (valid) {
      this.instance = Object.assign({}, saved);
    } else {
      this.instance = {
        streamToken: crypto.randomBytes(16).toString('hex'),
        createdAt: new Date().toISOString(),
        lastPort: null,
      };
      try {
        writeJsonAtomic(this.instanceFile, this.instance, { backup: false });
        console.log('[store] 已生成固定的流地址令牌：data/state/instance.json（重启不再变化）');
      } catch (err) {
        console.warn('[store] 写入 instance.json 失败（令牌仅本次有效）：' + err.message);
      }
    }
    return this.instance;
  }

  // 记录本次监听端口：端口变了，mpv 的进度键也会变，将来据此提示
  setLastPort(port) {
    const inst = this.getOrCreateInstance();
    if (inst.lastPort === port) return;
    inst.lastPort = port;
    try { writeJsonAtomic(this.instanceFile, inst, { backup: false }); } catch { /* 非关键 */ }
  }

  saveAlbums(opts) { writeJsonAtomic(this.albumsFile, this.albums, opts); }
  saveSettings(opts) { writeJsonAtomic(this.settingsFile, this.settings, opts); }
  saveViews(opts) { writeJsonAtomic(this.viewsFile, this.views, opts); }

  // ---- 每个专辑"上次浏览到哪 / 上次播了哪个文件" --------------------------
  // 有界：条数 = 专辑数；专辑删掉时顺手清掉它的条目（启动时也会清一次孤儿条目）
  getViews() {
    const out = {};
    for (const [id, v] of Object.entries(this.views || {})) {
      if (!v || typeof v !== 'object') continue;
      if (!this.findAlbum(id)) continue;                 // 专辑没了就不对外暴露
      out[id] = {
        path: typeof v.path === 'string' && v.path ? v.path : '/',
        file: typeof v.file === 'string' && v.file ? v.file : null,
        updatedAt: Number(v.updatedAt) || 0,
      };
    }
    return out;
  }

  setView(albumId, patch = {}) {
    if (!albumId || !this.findAlbum(albumId)) return null;
    const prev = this.views[albumId] && typeof this.views[albumId] === 'object' ? this.views[albumId] : {};
    const next = {
      path: typeof patch.path === 'string' && patch.path ? patch.path : (prev.path || '/'),
      file: patch.file === undefined ? (prev.file || null)
        : (typeof patch.file === 'string' && patch.file ? patch.file : null),
      updatedAt: Date.now(),
    };
    // 没有实质变化就别写盘（目录切换很频繁）
    if (prev.path === next.path && (prev.file || null) === next.file && prev.updatedAt) return next;
    this.views[albumId] = next;
    this.saveViews();
    return next;
  }

  clearView(albumId) {
    if (!albumId || !this.views[albumId]) return false;
    delete this.views[albumId];
    this.saveViews();
    return true;
  }

  // 清掉"专辑已经不存在"的孤儿条目（专辑被手工删过 / 从备份恢复过）
  pruneViews() {
    let removed = 0;
    for (const id of Object.keys(this.views || {})) {
      if (!this.findAlbum(id)) { delete this.views[id]; removed++; }
    }
    if (removed > 0) this.saveViews();
    return removed;
  }

  // ---- albums -------------------------------------------------------------
  static sanitize(input, existing) {
    const src = input && typeof input === 'object' ? input : {};
    const url = String(src.url || '').trim();
    if (!url) throw Object.assign(new Error('服务器地址不能为空'), { status: 400 });
    if (!/^https?:\/\//i.test(url)) {
      throw Object.assign(new Error('服务器地址必须以 http:// 或 https:// 开头'), { status: 400 });
    }
    const name = String(src.name || '').trim() || '未命名专辑';
    const auth = ['basic', 'digest', 'none'].includes(src.auth) ? src.auth : 'basic';

    let headers = {};
    if (src.headers && typeof src.headers === 'object' && !Array.isArray(src.headers)) {
      for (const [k, v] of Object.entries(src.headers)) {
        if (k && String(k).trim()) headers[String(k).trim()] = String(v == null ? '' : v);
      }
    }

    // On update an empty/omitted password keeps the stored one.
    let password;
    if (src.password === undefined || src.password === null) password = existing ? existing.password : '';
    else if (String(src.password) === '' && existing) password = existing.password;
    else password = String(src.password);

    const out = {
      id: existing ? existing.id : 'alb_' + crypto.randomBytes(6).toString('hex'),
      name,
      type: 'webdav',
      url,
      root: normalizeRel(src.root || '/'),
      username: String(src.username == null ? '' : src.username),
      password,
      auth,
      verifyTLS: src.verifyTLS === undefined ? true : !!src.verifyTLS,
      timeoutMs: Math.min(120000, Math.max(3000, parseInt(src.timeoutMs, 10) || 20000)),
      headers,
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
    };
    return out;
  }

  publicAlbum(album) {
    const { password, ...rest } = album;
    return Object.assign({}, rest, { hasPassword: !!password });
  }

  listAlbums() { return this.albums.map((a) => this.publicAlbum(a)); }
  findAlbum(id) { return this.albums.find((a) => a.id === id) || null; }

  createAlbum(input) {
    const album = Store.sanitize(input, null);
    this.albums.push(album);
    this.saveAlbums();
    return this.publicAlbum(album);
  }

  updateAlbum(id, input) {
    const idx = this.albums.findIndex((a) => a.id === id);
    if (idx === -1) throw Object.assign(new Error('专辑不存在：' + id), { status: 404 });
    const album = Store.sanitize(input, this.albums[idx]);
    this.albums[idx] = album;
    this.saveAlbums();
    return this.publicAlbum(album);
  }

  deleteAlbum(id) {
    const idx = this.albums.findIndex((a) => a.id === id);
    if (idx === -1) throw Object.assign(new Error('专辑不存在：' + id), { status: 404 });
    this.albums.splice(idx, 1);
    this.saveAlbums();
    this.clearView(id);          // 顺手清掉"上次浏览到哪"，不留孤儿条目
    return true;
  }

  // ---- settings -----------------------------------------------------------
  publicSettings() { return this.settings; }

  updateSettings(patch) {
    const src = patch && typeof patch === 'object' ? patch : {};
    const next = Object.assign({}, this.settings);
    if (src.mpvPath !== undefined) next.mpvPath = String(src.mpvPath || '');
    if (src.alang !== undefined) next.alang = String(src.alang || '');
    if (src.slang !== undefined) next.slang = String(src.slang || '');
    if (src.volume !== undefined) next.volume = Math.min(150, Math.max(0, parseInt(src.volume, 10) || 0));
    if (src.subFallbackSingleVideo !== undefined) next.subFallbackSingleVideo = !!src.subFallbackSingleVideo;
    if (src.subEncoding !== undefined) {
      const enc = String(src.subEncoding || 'auto').toLowerCase();
      next.subEncoding = textEncoding.isSubtitleEncodingUsable(enc) ? enc : 'auto';
    }
    if (src.subTranscodeMaxBytes !== undefined) {
      next.subTranscodeMaxBytes = Math.min(64 * 1024 * 1024, Math.max(64 * 1024, parseInt(src.subTranscodeMaxBytes, 10) || 8 * 1024 * 1024));
    }
    // watch-later 清理上限（进度由 mpv 记，这里只管"留多少、留多久"）
    if (src.watchLaterMaxEntries !== undefined) {
      const v = parseInt(src.watchLaterMaxEntries, 10);
      next.watchLaterMaxEntries = Number.isFinite(v) && v >= 0 ? Math.min(100000, v) : next.watchLaterMaxEntries;
    }
    if (src.watchLaterMaxDays !== undefined) {
      const v = parseInt(src.watchLaterMaxDays, 10);
      next.watchLaterMaxDays = Number.isFinite(v) && v >= 0 ? Math.min(3650, v) : next.watchLaterMaxDays;
    }
    if (src.mpvOntop !== undefined) next.mpvOntop = !!src.mpvOntop;
    if (src.mpvAutoFullscreen !== undefined) next.mpvAutoFullscreen = !!src.mpvAutoFullscreen;
    for (const key of ['videoExts', 'audioExts', 'subExts', 'subDirs', 'extraMpvArgs']) {
      if (src[key] === undefined) continue;
      const value = src[key];
      if (Array.isArray(value)) {
        next[key] = value.map((v) => String(v).trim()).filter(Boolean);
      } else if (typeof value === 'string') {
        next[key] = value.split(/[,\n]/).map((v) => v.trim().replace(/^\./, '')).filter(Boolean);
      }
    }
    this.settings = next;
    this.saveSettings();
    return this.settings;
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
