'use strict';
// 用 mpv 自己的 watch-later 记录播放进度。
//
// 我们不再自己维护进度状态机，只做三件事：
//   1. 告诉 mpv 把进度写到我们指定的目录（见 mpv.js 的 watchLaterArgs()）
//   2. 读：把 "最近有进度的那一条" 映射回专辑 + 文件，供界面显示
//   3. 删/清：从头播放时删掉某一条；按条数与天数做 LRU 清理，避免无限增长
//
// mpv 的命名规则（本机实测）：文件名 = MD5(UTF-8 路径或 URL)，32 位大写十六进制；
// 内容形如：
//     # http://127.0.0.1:8787/stream/<token>/<albumId>/<path>
//     start=123.456000
// 目录条目（"# redirect entry"）没有 start=，扫描时忽略。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// mpv 用的键：MD5(路径或 URL) 的大写十六进制
function keyFor(target) {
  return crypto.createHash('md5').update(String(target), 'utf8').digest('hex').toUpperCase();
}

function entryFile(dir, target) {
  return path.join(dir, keyFor(target));
}

function parseEntryText(text) {
  const lines = String(text).split(/\r?\n/);
  let pos = null;
  let source = '';
  for (const line of lines) {
    if (/^start=/.test(line)) {
      const v = parseFloat(line.slice(6));
      if (Number.isFinite(v)) pos = v;
    } else if (/^#/.test(line) && !/redirect entry/i.test(line)) {
      source = line.replace(/^#\s*/, '').trim();
    }
  }
  if (pos == null || pos <= 0) return null;
  return { pos, source };
}

// 读某个地址的进度；没有就返回 null
function readEntry(dir, target) {
  try {
    const file = entryFile(dir, target);
    const parsed = parseEntryText(fs.readFileSync(file, 'utf8'));
    if (!parsed) return null;
    const stat = fs.statSync(file);
    return { pos: parsed.pos, file, target: String(target), updatedAt: stat.mtimeMs };
  } catch {
    return null;
  }
}

// 写一条进度（用于把旧版本自己记的进度搬进 mpv 的格式）
function writeEntry(dir, target, pos) {
  ensureDir(dir);
  const body = `# ${target}\nstart=${Number(pos).toFixed(6)}\n`;
  fs.writeFileSync(entryFile(dir, target), body, 'utf8');
  return entryFile(dir, target);
}

// 删掉某地址的进度（「从头播放」用）
function removeEntry(dir, target) {
  try {
    fs.rmSync(entryFile(dir, target), { force: true });
    return true;
  } catch {
    return false;
  }
}

// 扫描目录里所有"有进度"的条目（忽略只有 redirect 注释的目录条目）
function scan(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let parsed;
    try {
      parsed = parseEntryText(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!parsed) continue;
    out.push({ key: name, file, pos: parsed.pos, target: parsed.source, updatedAt: stat.mtimeMs });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

// 清理：按条数上限 + 天数上限做 LRU，顺带删掉过期的目录条目（redirect entry）
function prune(dir, { maxEntries = 200, maxAgeDays = 90, now = Date.now() } = {}) {
  const all = [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { removed: 0, kept: 0, dir };
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    all.push({ key: name, file, updatedAt: stat.mtimeMs });
  }
  all.sort((a, b) => b.updatedAt - a.updatedAt);

  const withProgress = [];
  const redirects = [];
  for (const item of all) {
    let parsed = null;
    try {
      parsed = parseEntryText(fs.readFileSync(item.file, 'utf8'));
    } catch { /* 读不了就当目录条目处理 */ }
    if (parsed) withProgress.push(item); else redirects.push(item);
  }

  const ageLimit = now - Math.max(0, maxAgeDays) * 24 * 3600 * 1000;
  const maxKeep = Math.max(0, maxEntries);
  const removedFiles = [];

  withProgress.forEach((item, index) => {
    const tooMany = index >= maxKeep;
    const tooOld = maxAgeDays > 0 && item.updatedAt < ageLimit;
    if (tooMany || tooOld) removedFiles.push(item.file);
  });
  // 目录条目：只按天数清（它们很小，但也不该永远留着）
  if (maxAgeDays > 0) {
    for (const item of redirects) {
      if (item.updatedAt < ageLimit) removedFiles.push(item.file);
    }
  }

  let removed = 0;
  for (const file of removedFiles) {
    try {
      fs.rmSync(file, { force: true });
      removed++;
    } catch { /* 删不掉就算了，下次再试 */ }
  }
  return { removed, kept: withProgress.length - removed, dir };
}

// ---- 流地址 <-> 专辑/文件 --------------------------------------------------
// 地址形如 http://host:port/stream/<token>/<albumId>/<相对路径>
// （构造地址统一由 server/index.js 的 streamUrl() 负责，这里只负责解析回来）

function parseStreamUrl(target, token) {
  if (!target) return null;
  let u;
  try {
    u = new URL(target);
  } catch {
    return null;
  }
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'stream') return null;
  if (token && parts[1] !== token) return null;
  const albumId = decodeURIComponent(parts[2] || '');
  const rel = '/' + parts.slice(3).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  }).join('/');
  if (!albumId || rel === '/') return null;
  return { albumId, path: rel };
}

// 把旧版本自己记的进度搬成 mpv 的条目（target 由调用方用 streamUrl() 生成）
function migrateLegacyRecord(dir, target, pos) {
  if (!target) return null;
  const value = Number(pos);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (readEntry(dir, target)) return { target, skipped: true };   // 已有 mpv 记录，别覆盖
  writeEntry(dir, target, value);
  return { target, pos: value };
}

// 把秒数格式化成人看的时间
function formatClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

function describe(entry, name) {
  if (!entry) return '';
  return `${name || path.basename(entry.target || '')} · ${formatClock(entry.pos)}`;
}

module.exports = {
  ensureDir, keyFor, entryFile, parseEntryText,
  readEntry, writeEntry, removeEntry, scan, prune,
  parseStreamUrl, migrateLegacyRecord,
  formatClock, describe,
};
