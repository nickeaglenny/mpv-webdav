'use strict';
// Media type helpers: extension classification and external-subtitle discovery.

const DEFAULT_VIDEO_EXTS = [
  'mkv', 'mp4', 'm4v', 'avi', 'mov', 'wmv', 'flv', 'webm', 'ts', 'm2ts', 'mts', 'mpg',
  'mpeg', 'vob', 'rmvb', 'rm', '3gp', 'ogv', 'asf', 'divx', 'f4v', 'm2v', 'mxf', 'iso',
];
const DEFAULT_AUDIO_EXTS = [
  'mp3', 'flac', 'aac', 'm4a', 'wav', 'ogg', 'oga', 'opus', 'wma', 'ape', 'dts', 'ac3', 'mka', 'alac',
];
const DEFAULT_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'avif'];
const DEFAULT_SUB_EXTS = [
  'srt', 'ass', 'ssa', 'sub', 'idx', 'sup', 'vtt', 'smi', 'sami', 'mks', 'pgs', 'rt', 'lrc',
  'sbv', 'scc', 'srv3', 'utf', 'utf8', 'ytt', 'txt',
];
const DEFAULT_SUB_DIRS = ['subs', 'sub', 'subtitle', 'subtitles', '字幕', '子字幕'];

// Language tags commonly found in release names, mapped onto mpv's language codes.
const LANG_ALIASES = {
  zh: ['zh', 'chi', 'zho', 'chs', 'cht', 'cn', 'sc', 'tc', '简体', '繁体', '中文', '中字', '国语', '双语'],
  eng: ['en', 'eng', 'english', '英文'],
  jpn: ['ja', 'jp', 'jpn', 'japanese', '日文', '日语'],
  kor: ['ko', 'kor', 'korean', '韩文', '韩语'],
};

function extOf(name) {
  const m = /\.([^.\/\\]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

function stripExt(name) {
  return String(name || '').replace(/\.[^.\/\\]+$/, '');
}

function kindOf(name, isDir, settings = {}) {
  if (isDir) return 'dir';
  const ext = extOf(name);
  const video = settings.videoExts || DEFAULT_VIDEO_EXTS;
  const audio = settings.audioExts || DEFAULT_AUDIO_EXTS;
  const subs = settings.subExts || DEFAULT_SUB_EXTS;
  const images = settings.imageExts || DEFAULT_IMAGE_EXTS;
  if (video.includes(ext)) return 'video';
  if (audio.includes(ext)) return 'audio';
  if (subs.includes(ext)) return 'subtitle';
  if (images.includes(ext)) return 'image';
  return 'other';
}

function isPlayable(kind) {
  return kind === 'video' || kind === 'audio';
}

// Language hint contained in the "extra" part of a subtitle name, e.g. "movie.zh-CN.srt".
function langHint(extra, alang = '') {
  const tokens = String(extra || '').toLowerCase().split(/[.\-_\[\]() ]+/).filter(Boolean);
  const order = String(alang || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  for (const canon of order) {
    const aliases = LANG_ALIASES[canon] || [canon];
    for (const token of tokens) {
      if (aliases.includes(token)) return canon;
    }
  }
  for (const [canon, aliases] of Object.entries(LANG_ALIASES)) {
    for (const token of tokens) if (aliases.includes(token)) return canon;
  }
  return null;
}

// Rate how well `subName` matches `videoName`. null = no match.
// 200 exact same basename, 150 "<video>.<lang>", 100 "<video> <anything>",
//   60  loose prefix ("movie" matches "movie-cd1"), and a small bonus for
//   preferred language so the best track ends up first for mpv.
function subtitleScore(subName, videoName, alang = '') {
  const subExt = extOf(subName);
  const videoBase = stripExt(videoName).toLowerCase();
  const subBase = stripExt(subName).toLowerCase();
  if (!videoBase || !subBase) return null;
  if (subExt && stripExt(subName).toLowerCase() === videoBase) return 200;

  let base = null;
  if (subBase.startsWith(videoBase + '.')) base = 150;
  else if (subBase.startsWith(videoBase + ' ') || subBase.startsWith(videoBase + '_') || subBase.startsWith(videoBase + '-')) base = 150;
  else if (subBase.startsWith(videoBase)) base = 60;
  if (base == null) return null;

  const extra = subBase.slice(videoBase.length);
  const lang = langHint(extra, alang);
  const order = String(alang || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  let bonus = 0;
  if (lang && order.includes(lang)) bonus = 20 - Math.min(19, order.indexOf(lang) * 4);
  return base + bonus;
}

// entries: [{ name, path, isDir }] from a directory listing.
function findSubtitlesIn(entries, videoName, subExts, alang) {
  const subs = subExts || DEFAULT_SUB_EXTS;
  const out = [];
  for (const e of entries) {
    if (!e || e.isDir) continue;
    if (!subs.includes(extOf(e.name))) continue;
    const score = subtitleScore(e.name, videoName, alang);
    if (score == null) continue;
    out.push({ name: e.name, path: e.path, score });
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return out;
}

// Real libraries often name the subtitle after the *Chinese* title while the
// video keeps the original release name (e.g. "某部电影 2012.Chs.ass" next to
// "Some.Movie.2012.1080p.BluRay.x264.mkv"), so no name rule can match.
// When a folder holds exactly one video, its subtitles belong to it: pair them.
function singleVideoFallback(entries, settings = {}) {
  const videoExts = settings.videoExts || DEFAULT_VIDEO_EXTS;
  const subExts = settings.subExts || DEFAULT_SUB_EXTS;
  const videos = entries.filter((e) => e && !e.isDir && videoExts.includes(extOf(e.name)));
  if (videos.length !== 1) return null;
  const subs = entries.filter((e) => e && !e.isDir && subExts.includes(extOf(e.name)));
  if (!subs.length) return null;
  return { video: videos[0], subs };
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
}

module.exports = {
  DEFAULT_VIDEO_EXTS, DEFAULT_AUDIO_EXTS, DEFAULT_IMAGE_EXTS, DEFAULT_SUB_EXTS, DEFAULT_SUB_DIRS,
  extOf, stripExt, kindOf, isPlayable, subtitleScore, findSubtitlesIn, singleVideoFallback, humanSize, langHint,
};
