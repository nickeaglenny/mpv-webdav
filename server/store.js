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
  // 「只记最近一次」的播放进度阈值（见 server/resume.js）
  resumeMinSeconds: 30,
  resumeMinPercent: 5,
  resumeEndGuardSeconds: 60,
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
    this.albumsFile = path.join(dataDir, 'albums.json');
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.resumeFile = path.join(dataDir, 'last-played.json');
    ensureDir(dataDir);

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

    // 「只记最近一次」的播放进度：只有一个文件、一条记录
    const resumeRead = readJsonWithBackup(this.resumeFile);
    this.resume = resumeRead.value && typeof resumeRead.value === 'object' ? resumeRead.value : null;
  }

  saveAlbums(opts) { writeJsonAtomic(this.albumsFile, this.albums, opts); }
  saveSettings(opts) { writeJsonAtomic(this.settingsFile, this.settings, opts); }
  saveResume(opts) { writeJsonAtomic(this.resumeFile, this.resume, opts); }

  // ---- 最近一次播放进度 ---------------------------------------------------
  getResume() { return this.resume; }

  setResume(record) {
    this.resume = record;
    this.saveResume();
    return this.resume;
  }

  clearResume() {
    if (this.resume === null) return null;
    this.resume = null;
    this.saveResume();
    return null;
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
    for (const key of ['resumeMinSeconds', 'resumeMinPercent', 'resumeEndGuardSeconds']) {
      if (src[key] === undefined) continue;
      const v = parseInt(src[key], 10);
      next[key] = Number.isFinite(v) && v >= 0 ? v : next[key];
    }
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
