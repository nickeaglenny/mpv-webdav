'use strict';
/* ==========================================================================
 * mpv WebDAV 专辑 —— 前端逻辑（原生 JS，经典脚本，无构建步骤，无外部依赖）
 *
 * 章节：
 *   1. 常量与图标        2. 运行时状态        3. 通用工具（esc / el / 格式化）
 *   4. API 层            5. Toast 与状态栏     6. 专辑侧边栏
 *   7. 播放列表侧边栏    8. 目录浏览区        9. 播放器条
 *  10. SSE 与轮询       11. 专辑对话框       12. 设置对话框
 *  13. 右键/行操作菜单  14. 键盘快捷键       15. 启动引导
 *
 * 所有远端字符串在插入 innerHTML 前必须经过 esc()。
 * ========================================================================== */

/* ============================ 1. 常量与图标 ============================ */

var API = {
  state:    '/api/state',
  albums:   '/api/albums',
  browse:   '/api/browse',
  play:     '/api/play',
  player:   '/api/player',
  events:   '/api/events',
  settings: '/api/settings',
  resume:   '/api/resume'
};

var STORAGE_KEY  = 'mpvwebdav.ui';
var TOAST_MS     = 3500;
var POLL_MS      = 2000;

/* 图标（内联 SVG，使用 currentColor 着色） */
var ICONS = {
  dir:      '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8L10 4z"/></svg>',
  video:    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5h18v14H3V5z" opacity=".3"/><path d="M10 8.4l6 3.6-6 3.6V8.4z"/><path d="M3 5h18v2H3z" opacity=".55"/></svg>',
  audio:    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3l8-2v13.6a3.6 3.6 0 1 1-2-3.2V6.2L14 7v9.6A3.6 3.6 0 1 1 12 13.4V3z"/></svg>',
  subtitle: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5h18v14H3V5z" opacity=".3"/><path d="M6 12h6v2H6zm8 0h4v2h-4zM6 15.5h4v1.5H6zm6 0h6v1.5h-6z"/></svg>',
  image:    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5h18v14H3V5z" opacity=".3"/><path d="M7 17l4-5 3 3.4L16.5 13l3 4H7z"/><circle cx="8.5" cy="9" r="1.6"/></svg>',
  other:    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 2h8l4 4v16H6V2z" opacity=".35"/><path d="M14 2l4 4h-4V2z"/></svg>'
};

var KIND_LABEL = {
  dir: '文件夹', video: '视频', audio: '音频',
  subtitle: '字幕', image: '图片', other: '其他'
};

/* ============================ 2. 运行时状态 ============================ */

var state = {
  booted: false,
  app: null,                 /* GET /api/state 的原始响应 */
  settings: null,
  player: null,
  albums: [],
  selectedAlbumId: null,
  browse: {
    albumId: null,
    path: '/',
    loading: false,
    error: null,
    entries: [],
    parent: null,
    token: 0                 /* 防止过期请求覆盖新结果 */
  },
  ui: { view: 'list', sortKey: 'name', sortDir: 'asc' },
  search: '',
  selIndex: -1,
  subCache: {},              /* path -> [字幕文件名] */
  resume: null,              /* 最近一次播放进度（只记一条） */
  sse: null,
  sseOpen: false,
  polling: false,
  pollTimer: null,
  ctxMenu: null,
  bootError: null
};

/* ============================ 3. 通用工具 ============================ */

function $(sel, root) { return (root || document).querySelector(sel); }

/** 转义所有插入 HTML 的远端 / 用户字符串。 */
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 极简 DOM 构造器。 */
function el(tag, props, children) {
  var node = document.createElement(tag);
  if (props) {
    for (var k in props) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
      var v = props[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'dataset') { for (var d in v) node.dataset[d] = v[d]; }
      else if (k === 'style' && typeof v === 'object') { for (var s in v) node.style[s] = v[s]; }
      else if (k === 'on') { for (var ev in v) node.addEventListener(ev, v[ev]); }
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  appendAll(node, children);
  return node;
}

function appendAll(node, children) {
  if (children === null || children === undefined) return;
  if (!Array.isArray(children)) children = [children];
  for (var i = 0; i < children.length; i++) {
    var c = children[i];
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

function setText(node, text) { if (node) node.textContent = text == null ? '' : String(text); }
function val(sel) { var n = $(sel); return n ? n.value : ''; }
function isChecked(sel) { var n = $(sel); return !!(n && n.checked); }

function fmtSize(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  n = Number(n);
  if (n < 1024) return n + ' B';
  var units = ['KB', 'MB', 'GB', 'TB', 'PB'], v = n, i = -1;
  do { v = v / 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
}

function fmtDate(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  function p(x) { return (x < 10 ? '0' : '') + x; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
         ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 中间省略：超长路径只保留首尾。 */
function middleEllipsize(text, maxChars) {
  text = String(text || '');
  if (maxChars < 8) maxChars = 8;
  if (text.length <= maxChars) return text;
  var keep = maxChars - 1;
  var head = Math.ceil(keep / 2), tail = Math.floor(keep / 2);
  return text.slice(0, head) + '…' + text.slice(text.length - tail);
}

/** 按容器像素宽度估算可显示字符数并做中间省略。 */

function basename(p) {
  if (!p) return '';
  var s = String(p).replace(/[\\/]+$/, '');
  var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

function joinPath(base, seg) {
  var b = String(base || '/');
  if (b === '' ) b = '/';
  b = b.replace(/\/+$/, '');
  return (b === '' ? '' : b) + '/' + String(seg).replace(/^\/+/, '');
}

function parseHeaders(text) {
  var out = {};
  String(text || '').split(/\r?\n/).forEach(function (line) {
    var t = line.trim();
    if (!t || t.charAt(0) === '#') return;
    var i = t.indexOf(':');
    if (i <= 0) return;
    var k = t.slice(0, i).trim(), v = t.slice(i + 1).trim();
    if (k) out[k] = v;
  });
  return out;
}

function headersToText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return Object.keys(obj).map(function (k) { return k + ': ' + obj[k]; }).join('\n');
}

function parseList(text) {
  return String(text || '').split(/[,，]/).map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}

function listToText(arr) {
  return Array.isArray(arr) ? arr.join(', ') : '';
}

function isTypingTarget(node) {
  if (!node || !node.tagName) return false;
  var t = node.tagName.toLowerCase();
  return t === 'input' || t === 'textarea' || t === 'select' || node.isContentEditable === true;
}

/* ---------- localStorage 偏好 ---------- */

function loadUiPrefs() {
  try {
    var raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    var obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return;
    if (obj.albumId) state.selectedAlbumId = String(obj.albumId);
    if (obj.view === 'grid' || obj.view === 'list') state.ui.view = obj.view;
    if (obj.sortKey === 'name' || obj.sortKey === 'size' || obj.sortKey === 'mtime') state.ui.sortKey = obj.sortKey;
    if (obj.sortDir === 'asc' || obj.sortDir === 'desc') state.ui.sortDir = obj.sortDir;
  } catch (e) {
    console.warn('读取本地界面偏好失败：', e && e.message);
  }
}

function saveUiPrefs() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      albumId: state.selectedAlbumId || null,
      view: state.ui.view,
      sortKey: state.ui.sortKey,
      sortDir: state.ui.sortDir
    }));
  } catch (e) {
    console.warn('保存本地界面偏好失败：', e && e.message);
  }
}

/* ============================ 4. API 层 ============================ */

function ApiError(message, status, payload) {
  this.name = 'ApiError';
  this.message = message;
  this.status = status || 0;
  this.payload = payload || null;
}
ApiError.prototype = Object.create(Error.prototype);

/**
 * 统一请求封装：同源相对路径，非 2xx 或 {ok:false} 一律抛出 ApiError，
 * payload.error（中文错误信息）优先作为 message 向上冒泡。
 */
function api(method, url, body) {
  var opts = { method: method, headers: { 'Accept': 'application/json' } };
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(url, opts).then(function (res) {
    return res.text().then(function (text) {
      var data = null;
      if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
      if (!res.ok || (data && data.ok === false)) {
        /* 失败信息优先取 error；部分端点（如测试连接）用 message 承载中文原因 */
        var msg = (data && (data.error || data.message)) ? (data.error || data.message)
                                                        : ('请求失败（HTTP ' + res.status + '）');
        throw new ApiError(msg, res.status, data);
      }
      return data === null ? {} : data;
    });
  }, function (err) {
    throw new ApiError('网络请求失败：' + ((err && err.message) || '未知错误'), 0, null);
  });
}

/* 契约端点封装 */
var apiGet = {
  state:    function () { return api('GET', API.state); },
  player:   function () { return api('GET', API.player); },
  settings: function () { return api('GET', API.settings); }
};
function apiBrowse(albumId, path) {
  return api('GET', API.browse + '?albumId=' + encodeURIComponent(albumId) +
                     '&path=' + encodeURIComponent(path));
}
function apiCreateAlbum(payload) { return api('POST', API.albums, payload); }
function apiUpdateAlbum(id, payload) { return api('PUT', API.albums + '/' + encodeURIComponent(id), payload); }
function apiDeleteAlbum(id) { return api('DELETE', API.albums + '/' + encodeURIComponent(id)); }
function apiTestAlbum(payload) { return api('POST', API.albums + '/test', payload); }
function apiPlay(payload) { return api('POST', API.play, payload); }
function apiSaveSettings(partial) { return api('PUT', API.settings, partial); }
function apiGetResume() { return api('GET', API.resume); }

/** 重新读取「最近一次播放进度」（quiet=true 时不弹错误提示）。 */
function refreshResume(quiet) {
  return apiGetResume().then(function (res) {
    state.resume = (res && res.resume) || null;
    renderListing();
    return state.resume;
  }).catch(function (err) {
    if (!quiet) toast('error', '读取续播记录失败：' + err.message);
    return null;
  });
}

/* ============================ 5. Toast 与状态栏 ============================ */

function toast(kind, message, ms) {
  var box = $('#toasts');
  if (!box) return;
  var glyph = kind === 'success' ? '✔' : (kind === 'error' ? '⚠' : 'ℹ');
  var node = el('div', { class: 'toast toast-' + (kind || 'info') }, [
    el('span', { class: 'toast-icon', text: glyph }),
    el('span', { class: 'toast-msg', text: String(message == null ? '' : message) }),
    el('button', {
      class: 'toast-close', type: 'button', title: '关闭', text: '✕',
      on: { click: function () { dismiss(); } }
    })
  ]);
  box.appendChild(node);

  var done = false;
  function dismiss() {
    if (done) return;
    done = true;
    node.classList.add('is-out');
    window.setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 200);
  }
  window.setTimeout(dismiss, ms || TOAST_MS);
  return node;
}

function setStatus(message, kind) {
  var node = $('#status-left');
  if (!node) return;
  node.textContent = message == null ? '' : String(message);
  node.className = 'status-left' + (kind ? ' is-' + kind : '');
}

function setStatusRight(message) {
  var node = $('#status-right');
  if (node) node.textContent = message == null ? '' : String(message);
}

/* ============================ 6. 专辑侧边栏 ============================ */

function albumById(id) {
  for (var i = 0; i < state.albums.length; i++) {
    if (state.albums[i].id === id) return state.albums[i];
  }
  return null;
}

function currentAlbum() { return albumById(state.browse.albumId); }

function albumRoot() {
  var a = currentAlbum();
  var r = a && a.root ? String(a.root) : '/';
  if (!r) r = '/';
  if (r.charAt(0) !== '/') r = '/' + r;
  return r.replace(/\/+$/, '') || '/';
}

function renderAlbums() {
  var box = $('#album-list');
  if (!box) return;
  box.innerHTML = '';

  if (!state.albums.length) {
    box.appendChild(el('div', { class: 'pane-hint', text: '还没有专辑，点击「+ 新建专辑」添加一个 WebDAV 源。' }));
    return;
  }

  state.albums.forEach(function (album) {
    var selected = album.id === state.selectedAlbumId;
    var item = el('div', {
      class: 'album-item' + (selected ? ' is-selected' : ''),
      dataset: { albumId: album.id },
      title: (album.name || '') + '\n' + (album.url || ''),
      tabindex: '0'
    }, [
      el('span', { class: 'album-badge', text: String(album.type || 'webdav').toUpperCase() }),
      el('span', { class: 'album-main' }, [
        el('span', { class: 'album-name', text: album.name || '(未命名)' }),
        el('span', { class: 'album-sub', text: (album.username ? album.username + '@' : '') + (album.url || '') })
      ]),
      el('span', { class: 'album-actions' }, [
        el('button', { class: 'btn btn-sm', type: 'button', dataset: { act: 'edit' }, text: '编辑', title: '编辑专辑' }),
        el('button', { class: 'btn btn-sm', type: 'button', dataset: { act: 'test' }, text: '测试连接' }),
        el('button', { class: 'btn btn-sm btn-danger', type: 'button', dataset: { act: 'delete' }, text: '删除' })
      ])
    ]);
    box.appendChild(item);
  });
}

function bindAlbumList() {
  var box = $('#album-list');
  if (!box) return;

  box.addEventListener('click', function (ev) {
    var item = ev.target.closest ? ev.target.closest('.album-item') : null;
    if (!item) return;
    var id = item.dataset.albumId;
    var actBtn = ev.target.closest ? ev.target.closest('[data-act]') : null;
    var act = actBtn ? actBtn.dataset.act : null;

    if (act === 'edit') { ev.stopPropagation(); openAlbumDialog(albumById(id)); return; }
    if (act === 'test') { ev.stopPropagation(); quickTestAlbum(albumById(id), actBtn); return; }
    if (act === 'delete') { ev.stopPropagation(); confirmDeleteAlbum(albumById(id)); return; }
    selectAlbum(id);
  });

  box.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var item = ev.target.closest ? ev.target.closest('.album-item') : null;
    if (!item) return;
    ev.preventDefault();
    selectAlbum(item.dataset.albumId);
  });
}

function selectAlbum(id) {
  if (!id) return;
  var album = albumById(id);
  if (!album) return;
  state.selectedAlbumId = id;
  saveUiPrefs();
  renderAlbums();
  var startPath = album.root ? album.root : '/';
  if (!startPath || startPath.charAt(0) !== '/') startPath = '/' + startPath;
  loadBrowse(id, startPath);
}

/** 侧边栏「测试连接」：直接调用 /api/albums/test。 */
function quickTestAlbum(album, btn) {
  if (!album) return;
  if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
  setStatus('正在测试「' + album.name + '」…');
  apiTestAlbum(albumPayload(album, false)).then(function (res) {
    toast(res.ok ? 'success' : 'error',
      (res.ok ? '连接成功' : '连接失败') + '：' + (res.message || '') +
      '（HTTP ' + res.status + '，' + (res.entries || 0) + ' 个条目，' + (res.elapsedMs || 0) + ' ms）');
    setStatus(res.ok ? '连接成功：' + album.name : '连接失败：' + album.name, res.ok ? 'ok' : 'error');
  }).catch(function (err) {
    toast('error', '测试连接失败：' + err.message);
    setStatus('测试连接失败：' + err.message, 'error');
  }).then(function () {
    if (btn) { btn.disabled = false; btn.textContent = '测试连接'; }
  });
}

function confirmDeleteAlbum(album) {
  if (!album) return;
  var ok = window.confirm('确定删除专辑「' + album.name + '」吗？\n该操作只移除本地配置，不会影响服务器上的文件。');
  if (!ok) return;
  apiDeleteAlbum(album.id).then(function () {
    toast('success', '已删除专辑：' + album.name);
    if (state.selectedAlbumId === album.id) {
      state.selectedAlbumId = null;
      state.browse.albumId = null;
      state.browse.entries = [];
      state.browse.path = '/';
      saveUiPrefs();
    }
    return refreshState();
  }).catch(function (err) {
    toast('error', '删除失败：' + err.message);
  });
}

/** 由 AlbumOut 生成可提交的 AlbumIn。 */
function albumPayload(album, includePassword) {
  var base = {
    name: album.name || '',
    type: album.type || 'webdav',
    url: album.url || '',
    root: album.root || '/',
    username: album.username || '',
    auth: album.auth || 'basic',
    verifyTLS: album.verifyTLS !== false,
    headers: album.headers || {}
  };
  if (album.id) base.id = album.id;
  if (includePassword) base.password = album.password || '';
  return base;
}

/* ============================ 7. 目录浏览区 ============================ */

function visibleEntries() {
  var q = state.search.trim().toLowerCase();
  var list = state.browse.entries.slice();
  if (q) {
    list = list.filter(function (e) { return String(e.name || '').toLowerCase().indexOf(q) >= 0; });
  }
  var dir = state.ui.sortDir === 'desc' ? -1 : 1;
  var key = state.ui.sortKey;
  list.sort(function (a, b) {
    /* 文件夹始终排在文件前面 */
    if (!!a.isDir !== !!b.isDir) return a.isDir ? -1 : 1;
    var r = 0;
    if (key === 'size') r = (Number(a.size) || 0) - (Number(b.size) || 0);
    else if (key === 'mtime') {
      var ta = a.mtime ? Date.parse(a.mtime) : 0, tb = b.mtime ? Date.parse(b.mtime) : 0;
      r = (isNaN(ta) ? 0 : ta) - (isNaN(tb) ? 0 : tb);
    } else {
      r = String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
    }
    if (r === 0) r = String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN', { numeric: true });
    return r * dir;
  });
  return list;
}

function entryIconHtml(entry) {
  var kind = entry.isDir ? 'dir' : (entry.kind || 'other');
  var svg = ICONS[kind] || ICONS.other;
  return '<span class="entry-icon ic-' + esc(kind) + '">' + svg + '</span>';
}

function kindBadgeHtml(entry) {
  var kind = entry.isDir ? 'dir' : (entry.kind || 'other');
  return '<span class="kind-badge kind-' + esc(kind) + '">' + esc(KIND_LABEL[kind] || kind) + '</span>';
}

function subBadgeHtml(entry) {
  if (entry.isDir || entry.kind !== 'video') return '';
  var n = Number(entry.subtitleCount || 0);
  if (!(n > 0)) return '';
  var names = state.subCache[entry.path];
  var tip = (names && names.length)
    ? ('已检测字幕：\n' + names.join('\n'))
    : ('检测到 ' + n + ' 个字幕文件，播放后显示具体文件名');
  return '<span class="sub-badge" data-act="subs" title="' + esc(tip) + '">字幕 ×' + esc(n) + '</span>';
}

function canPlay(entry) { return entry && !entry.isDir && (entry.kind === 'video' || entry.kind === 'audio'); }

function renderListing() {
  var box = $('#listing');
  if (!box) return;

  /* --- 加载态 --- */
  if (state.browse.loading) {
    var sk = '<div class="skeleton-row"></div>';
    box.innerHTML = '<div class="state-box"><div class="spinner"></div>' +
      '<div class="state-title">加载中…</div></div>' + sk + sk + sk + sk + sk;
    return;
  }

  /* --- 错误态 --- */
  if (state.browse.error) {
    box.innerHTML = '<div class="state-box">' +
      '<div class="state-title">目录加载失败</div>' +
      '<div class="state-msg">' + esc(state.browse.error) + '</div>' +
      '<button class="btn btn-accent" data-act="retry" type="button">重试</button></div>';
    return;
  }

  /* --- 无选中专辑 --- */
  if (!state.browse.albumId) {
    box.innerHTML = '<div class="state-box">' +
      '<div class="state-title">请选择左侧的一个专辑</div>' +
      '<div class="state-msg">选择专辑后会在这里显示其 WebDAV 目录内容。</div></div>';
    return;
  }

  var list = visibleEntries();

  /* --- 空态 --- */
  if (!list.length) {
    var msg = state.search.trim() ? '没有匹配「' + state.search.trim() + '」的条目' : '此目录为空';
    box.innerHTML = '<div class="state-box"><div class="state-title">' + esc(msg) + '</div></div>';
    return;
  }

  /* --- 网格视图 --- */
  if (state.ui.view === 'grid') {
    var cards = list.map(function (e, i) {
      var kind = e.isDir ? 'dir' : (e.kind || 'other');
      return '<div class="card' + (e.isDir ? ' is-dir' : '') + (i === state.selIndex ? ' is-selected' : '') + '"' +
        ' data-i="' + i + '" data-path="' + esc(e.path) + '" data-kind="' + esc(kind) + '"' +
        ' title="' + esc(e.name) + '">' +
        '<div class="card-icon ic-' + esc(kind) + '">' + (ICONS[kind] || ICONS.other) + '</div>' +
        '<div class="card-name">' + esc(e.name) + '</div>' +
        '<div class="card-meta">' + (e.isDir ? '<span class="kind-badge kind-dir">文件夹</span>'
                                              : esc(fmtSize(e.size))) + subBadgeHtml(e) + '</div>' +
        '</div>';
    }).join('');
    box.innerHTML = '<div class="grid">' + cards + '</div>';
    return;
  }

  /* --- 列表视图 --- */
  var rows = list.map(function (e, i) {
    var kind = e.isDir ? 'dir' : (e.kind || 'other');
    var actions = '';
    if (e.isDir) actions += '<button class="row-act is-primary" data-act="enter" type="button" title="进入该目录">进入</button>';
    if (!e.isDir) actions += '<button class="row-act" data-act="menu" type="button" title="更多操作">⋯</button>';
    return '<div class="row' + (e.isDir ? ' is-dir' : '') + (i === state.selIndex ? ' is-selected' : '') + '"' +
      ' data-i="' + i + '" data-path="' + esc(e.path) + '" data-kind="' + esc(kind) + '" title="' + esc(e.name) + '">' +
      '<div class="col-name">' + entryIconHtml(e) +
        '<span class="entry-name">' + esc(e.name) + '</span>' + subBadgeHtml(e) + '</div>' +
      '<div class="col-size">' + (e.isDir ? '—' : esc(fmtSize(e.size))) + '</div>' +
      '<div class="col-mtime">' + esc(fmtDate(e.mtime)) + '</div>' +
      '<div>' + kindBadgeHtml(e) + '</div>' +
      '<div class="col-actions">' + actions + '</div>' +
      '</div>';
  }).join('');

  box.innerHTML =
    '<div class="list-head">' +
      '<div class="col-name">名称</div><div>大小</div><div class="col-mtime">修改时间</div>' +
      '<div>类型</div><div class="col-actions">操作</div>' +
    '</div>' + rows;
}

function renderBreadcrumb() {
  var nav = $('#breadcrumb');
  if (!nav) return;
  nav.innerHTML = '';

  var album = currentAlbum();
  if (!album || !state.browse.albumId) {
    nav.appendChild(el('span', { class: 'crumb is-current', text: '未选择专辑' }));
    return;
  }

  var root = albumRoot();
  var path = state.browse.path || root;
  var rel = path;
  if (root !== '/' && rel.indexOf(root) === 0) rel = rel.slice(root.length);
  var parts = rel.split('/').filter(function (s) { return s.length > 0; });

  function crumb(label, target, isCurrent) {
    return el('button', {
      class: 'crumb' + (isCurrent ? ' is-current' : ''),
      type: 'button',
      title: target,
      text: label,
      on: { click: function () { if (!isCurrent) loadBrowse(album.id, target); } }
    });
  }

  nav.appendChild(crumb(album.name || '(未命名专辑)', root, parts.length === 0));
  var acc = root;
  parts.forEach(function (seg, i) {
    nav.appendChild(el('span', { class: 'crumb-sep', text: '›' }));
    acc = joinPath(acc, seg);
    nav.appendChild(crumb(seg, acc, i === parts.length - 1));
  });
}

function renderToolbar() {
  var up = $('#btn-up');
  if (up) up.disabled = !state.browse.parent;
  var keySel = $('#sort-key');
  if (keySel) keySel.value = state.ui.sortKey;
  var dirBtn = $('#sort-dir');
  if (dirBtn) dirBtn.textContent = state.ui.sortDir === 'asc' ? '↑ 升序' : '↓ 降序';
  var search = $('#search-input');
  if (search && search.value !== state.search) search.value = state.search;
  var l = $('#btn-view-list'), g = $('#btn-view-grid');
  if (l) l.classList.toggle('is-active', state.ui.view === 'list');
  if (g) g.classList.toggle('is-active', state.ui.view === 'grid');
}

function renderBrowser() {
  renderToolbar();
  renderBreadcrumb();
  renderListing();
  if (state.browse.albumId && !state.browse.loading && !state.browse.error) {
    setStatusRight(visibleEntries().length + ' / ' + state.browse.entries.length + ' 项');
  }
}

/* ---------- 目录加载 ---------- */

function loadBrowse(albumId, path) {
  if (!albumId) return;
  state.browse.albumId = albumId;
  state.browse.path = path || '/';
  state.browse.loading = true;
  state.browse.error = null;
  state.selIndex = -1;
  state.search = '';
  var searchNode = $('#search-input');
  if (searchNode) searchNode.value = '';
  renderBrowser();
  setStatus('正在读取 ' + state.browse.path + ' …');

  var token = ++state.browse.token;
  apiBrowse(albumId, state.browse.path).then(function (res) {
    if (token !== state.browse.token) return;       /* 过期响应丢弃 */
    state.browse.loading = false;
    state.browse.error = null;
    state.browse.entries = Array.isArray(res.entries) ? res.entries : [];
    state.browse.parent = res.parent === undefined ? null : res.parent;
    if (typeof res.path === 'string' && res.path) state.browse.path = res.path;
    setStatus('已加载 ' + state.browse.entries.length + ' 个条目', 'ok');
    renderBrowser();
  }).catch(function (err) {
    if (token !== state.browse.token) return;
    state.browse.loading = false;
    state.browse.error = err.message;
    state.browse.entries = [];
    setStatus('目录加载失败：' + err.message, 'error');
    renderBrowser();
  });
}

function reloadBrowse() {
  if (!state.browse.albumId) { toast('info', '请先选择一个专辑'); return; }
  loadBrowse(state.browse.albumId, state.browse.path);
}

function goUp() {
  if (!state.browse.parent) return;
  loadBrowse(state.browse.albumId, state.browse.parent);
}

function enterEntry(entry) {
  if (!entry) return;
  if (entry.isDir) {
    /* 已经在（或正在）这个目录里就别重复加载：单击 + 双击会连发两次 click，
       而 loadBrowse 会同步把 state.browse.path 置为目录本身。
       出错状态下允许再点一次重试。 */
    if (state.browse.path === entry.path && !state.browse.error) return;
    loadBrowse(state.browse.albumId, entry.path);
    return;
  }
  if (canPlay(entry)) { playEntry(entry, 'replace'); return; }
  toast('info', '该类型暂不支持播放：' + (entry.name || '') + '（' + (KIND_LABEL[entry.kind] || entry.kind || '未知') + '）');
}

/** 只切换选中高亮，不重建列表（重建会把节点换掉，浏览器就不再派发 dblclick）。 */
function markSelected(node, index) {
  state.selIndex = typeof index === 'number' ? index : state.selIndex;
  var box = $('#listing');
  if (!box) return;
  var prev = box.querySelector('.is-selected');
  if (prev && prev !== node) prev.classList.remove('is-selected');
  if (node && node.classList) node.classList.add('is-selected');
}

/* ---------- 最近一次播放进度（只记一条） ---------- */

function fmtClock(sec) {
  var s = Math.max(0, Math.floor(Number(sec) || 0));
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var ss = s % 60;
  function p(x) { return (x < 10 ? '0' : '') + x; }
  return h > 0 ? h + ':' + p(m) + ':' + p(ss) : m + ':' + p(ss);
}

function resumeEntry() {
  var rec = state.resume;
  if (!rec) return null;
  return {
    path: rec.path,
    name: rec.name || basename(rec.path),
    kind: 'video'
  };
}

// 记录现在由 mpv 按"流地址"保存，界面这边只比对专辑 + 路径
function isResumeFor(entry) {
  var rec = state.resume;
  if (!rec || !entry || entry.isDir) return false;
  return rec.albumId === state.browse.albumId && rec.path === entry.path;
}

/* ---------- 播放 ---------- */

function playEntry(entry, mode, opts) {
  if (!state.browse.albumId) { toast('error', '没有选中的专辑'); return Promise.resolve(); }
  var options = opts || {};
  return apiPlay({
    albumId: state.browse.albumId,
    path: entry.path,
    mode: mode,
    loadSubs: true,
    // 进度由 mpv 按流地址自动续播；只有「从头播放」需要服务端先删掉那条进度
    resume: options.resume === false ? false : undefined
  }).then(function (res) {
    if (res.player) applyPlayer(res.player);
    var subs = Array.isArray(res.subtitles) ? res.subtitles : [];
    state.subCache[entry.path] = subs;
    renderListing();
    if (res.resumed) {
      setStatus('已从上次位置继续播放：' + (res.resumedText || ''), 'ok');
      toast('success', '继续上次播放：' + (res.resumedText || ''), 4000);
    } else if (mode !== 'replace' && res.player) {
      setStatus('已追加到播放列表：' + (entry.name || ''), 'ok');
    } else {
      setStatus('正在播放：' + (entry.name || ''), 'ok');
    }
    if (subs.length) {
      toast('success', '已加载 ' + subs.length + ' 个字幕：\n' + subs.map(basename).join('\n'), 5000);
    }
    return res;
  }).catch(function (err) {
    toast('error', '播放失败：' + err.message);
    setStatus('播放失败：' + err.message, 'error');
  });
}

/* ---------- 浏览区事件绑定 ---------- */

function entryFromEvent(ev) {
  var row = ev.target.closest ? ev.target.closest('[data-path]') : null;
  if (!row) return null;
  var i = Number(row.dataset.i);
  var list = visibleEntries();
  if (!(i >= 0 && i < list.length)) return null;
  return { entry: list[i], index: i, node: row };
}

function bindListing() {
  var box = $('#listing');
  if (!box) return;

  box.addEventListener('click', function (ev) {
    var actNode = ev.target.closest ? ev.target.closest('[data-act]') : null;
    var act = actNode ? actNode.dataset.act : null;
    var found = entryFromEvent(ev);

    if (act === 'retry') { reloadBrowse(); return; }
    if (!found) return;

    if (act === 'enter') { ev.stopPropagation(); enterEntry(found.entry); return; }
    if (act === 'play') { ev.stopPropagation(); blurSelf(actNode); playEntry(found.entry, 'replace'); return; }
    if (act === 'menu') {
      ev.stopPropagation();
      var r = actNode.getBoundingClientRect();
      openEntryMenu(found.entry, r.left, r.bottom + 4);
      return;
    }
    if (act === 'subs') {
      ev.stopPropagation();
      var names = state.subCache[found.entry.path];
      if (names && names.length) toast('info', '字幕文件：\n' + names.map(basename).join('\n'), 5000);
      else toast('info', '该视频检测到 ' + (found.entry.subtitleCount || 0) + ' 个字幕，播放后将显示具体文件名');
      return;
    }

    /* 单击只选中；双击才进入目录 / 播放文件。
       这里绝不重建列表，否则节点被替换会让浏览器不派发 dblclick。 */
    markSelected(found.node, found.index);
    box.focus();
  });

  box.addEventListener('dblclick', function (ev) {
    var found = entryFromEvent(ev);
    if (!found) return;
    enterEntry(found.entry);
  });

}

function scrollSelectionIntoView() {
  var node = $('#listing .is-selected');
  if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
}

function openEntryMenu(entry, x, y) {
  var items = [];
  if (canPlay(entry)) {
    var hasResume = isResumeFor(entry);
    items.push({ label: '▶ 播放（替换当前）', run: function () { playEntry(entry, 'replace'); } });
    if (hasResume) {
      items.push({ label: '↺ 从头播放', run: function () { playEntry(entry, 'replace', { resume: false }); } });
    }
    items.push({ label: '＋ 追加到播放列表', run: function () { playEntry(entry, 'append'); } });
    items.push({ sep: true });
  }
  items.push({ label: '复制路径', run: function () { copyText(entry.path); } });
  items.push({ label: '复制名称', run: function () { copyText(entry.name); } });
  if (!canPlay(entry) && !entry.isDir) {
    items.push({ sep: true });
    items.push({ label: '该类型暂不支持播放', run: function () { toast('info', '该类型暂不支持播放：' + entry.name); } });
  }
  showCtxMenu(x, y, items);
}

function copyText(text) {
  var s = String(text == null ? '' : text);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(s).then(function () { toast('success', '已复制：' + s); },
      function () { toast('info', '复制失败，请手动选择：' + s); });
  } else {
    toast('info', s);
  }
}

/* ---------- 通用弹出菜单 ---------- */

function closeCtxMenu() {
  if (state.ctxMenu && state.ctxMenu.parentNode) state.ctxMenu.parentNode.removeChild(state.ctxMenu);
  state.ctxMenu = null;
}

function showCtxMenu(x, y, items) {
  closeCtxMenu();
  var menu = el('div', { class: 'ctx-menu' });
  items.forEach(function (it) {
    if (it.sep) { menu.appendChild(el('div', { class: 'ctx-sep' })); return; }
    menu.appendChild(el('button', {
      class: 'ctx-item' + (it.danger ? ' is-danger' : ''),
      type: 'button',
      text: it.label,
      on: { click: function () { closeCtxMenu(); it.run(); } }
    }));
  });
  document.body.appendChild(menu);
  var r = menu.getBoundingClientRect();
  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
  menu.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
  state.ctxMenu = menu;
}

/* ---------- 工具栏事件 ---------- */

/* 播放类按钮点完就取消焦点：避免空格/回车"又点了一次"
   （典型症状：鼠标点过「继续观看/播放全部」后按空格想暂停，却把这一集重新加载了） */
function blurSelf(node) {
  if (node && typeof node.blur === 'function') node.blur();
}

function bindToolbar() {
  $('#btn-up').addEventListener('click', goUp);
  $('#btn-refresh').addEventListener('click', reloadBrowse);


  var search = $('#search-input');
  search.addEventListener('input', function () {
    state.search = search.value;
    state.selIndex = -1;
    renderListing();
    setStatusRight(visibleEntries().length + ' / ' + state.browse.entries.length + ' 项');
  });
  search.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { search.value = ''; state.search = ''; renderListing(); search.blur(); }
  });

  $('#sort-key').addEventListener('change', function () {
    state.ui.sortKey = this.value; saveUiPrefs(); renderListing();
  });
  $('#sort-dir').addEventListener('click', function () {
    state.ui.sortDir = state.ui.sortDir === 'asc' ? 'desc' : 'asc';
    saveUiPrefs(); renderToolbar(); renderListing();
  });
  $('#btn-view-list').addEventListener('click', function () { setView('list'); });
  $('#btn-view-grid').addEventListener('click', function () { setView('grid'); });

  $('#btn-new-album').addEventListener('click', function () { openAlbumDialog(null); });
  $('#btn-settings').addEventListener('click', openSettingsDialog);
}

function setView(view) {
  state.ui.view = view === 'grid' ? 'grid' : 'list';
  saveUiPrefs();
  renderToolbar();
  renderListing();
}

/* ============================ 8. 播放器状态（仅用于标签页标题） ============================ */

function emptyPlayer() {
  return {
    running: false, idle: true, paused: false, position: 0, duration: 0,
    volume: 100, mute: false, mediaTitle: '', albumId: null, path: null,
    playlist: [], playlistPos: -1, subtitleCount: 0, subtitles: [],
    error: null, updatedAt: 0
  };
}

function isPlayerActive() {
  var p = state.player;
  return !!(p && p.running && !p.idle);
}

function applyPlayer(ps) {
  if (!ps || typeof ps !== 'object') return;
  /* 兼容两种形状：裸 PlayerState，以及 {ok:true, player:PlayerState} 信封 */
  if (ps.running === undefined && ps.player && typeof ps.player === 'object') ps = ps.player;
  var wasActive = isPlayerActive();
  state.player = ps;
  /* 界面上不再有播放控制（播放/暂停/进度都在 mpv 里），这里只做两件事：
     ① 标签页标题显示进度 ② 播放结束后稍等片刻再拉一次「继续观看」 */
  renderTabTitle();
  if (wasActive && !isPlayerActive()) {
    window.setTimeout(function () { refreshResume(true); }, 1200);
  }
  if (ps.error) setStatus('播放器错误：' + ps.error, 'error');
}

/** 浏览器标签页标题显示播放进度：切到别的标签也能看到播到哪了。 */
function renderTabTitle() {
  var p = state.player || emptyPlayer();
  var base = 'mpv WebDAV 专辑';
  var hasMedia = !!(p.mediaTitle || p.path) && (p.running || !p.idle);
  if (!hasMedia) {
    if (document.title !== base) document.title = base;
    return;
  }
  var mark = p.paused ? '⏸' : '▶';
  var name = p.mediaTitle || basename(p.path || '');
  if (name.length > 40) name = name.slice(0, 39) + '…';
  var time = fmtClock(p.position) + (p.duration > 0 ? ' / ' + fmtClock(p.duration) : '');
  var next = mark + ' ' + time + ' · ' + name;
  if (document.title !== next) document.title = next;
}

/* 网页不再有任何"控制 mpv"的入口：暂停/进度/音量/切集都在 mpv 窗口里。
   前端只从 SSE/Poll 读取播放状态，用于标签页标题显示。 */


/* ============================ 9. SSE 与轮询 ============================ */

function startEvents() {
  if (state.sse || state.polling) return;          /* 幂等：重复调用不重建连接 */
  if (typeof window.EventSource !== 'function') {
    startPolling('已切换轮询模式');
    return;
  }
  var es;
  try {
    es = new window.EventSource(API.events);
  } catch (e) {
    console.warn('无法创建 EventSource：', e && e.message);
    startPolling('已切换轮询模式');
    return;
  }
  state.sse = es;

  es.addEventListener('open', function () {
    state.sseOpen = true;
    if (state.polling) {
      stopPolling();
      setStatus('实时连接已恢复', 'ok');
    }
  });

  es.addEventListener('player', function (ev) {
    var data = safeJson(ev.data);
    if (data) applyPlayer(data);
  });

  es.addEventListener('log', function (ev) {
    var data = safeJson(ev.data);
    if (!data) return;
    if (data.level === 'error') toast('error', data.message || '服务端错误');
    else if (data.level === 'warn') toast('info', data.message || '');
    setStatus(String(data.message || ''));
  });

  es.addEventListener('bye', function () {
    setStatus('服务端已关闭事件流');
  });

  es.onerror = function () {
    state.sseOpen = false;
    if (!state.polling) startPolling('已切换轮询模式');
  };
}

function safeJson(text) {
  try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
}

function startPolling(hint) {
  if (state.polling) return;
  state.polling = true;
  if (hint) setStatus(hint, 'warn');
  pollOnce();
  state.pollTimer = window.setInterval(pollOnce, POLL_MS);
}

function stopPolling() {
  state.polling = false;
  if (state.pollTimer) { window.clearInterval(state.pollTimer); state.pollTimer = null; }
}

function pollOnce() {
  apiGet.player().then(function (ps) {
    applyPlayer(ps);
  }).catch(function (err) {
    console.warn('轮询播放器状态失败：', err && err.message);
  });
}

/* ============================ 10. 专辑对话框 ============================ */

var albumDialogMode = 'create';   /* 'create' | 'edit' */
var albumDialogId = null;

function openAlbumDialog(album) {
  albumDialogMode = album ? 'edit' : 'create';
  albumDialogId = album ? album.id : null;

  setText($('#dlg-album-title'), album ? '编辑专辑' : '新建专辑');
  $('#al-name').value = album ? (album.name || '') : '';
  $('#al-type').value = 'webdav';
  $('#al-url').value = album ? (album.url || '') : '';
  $('#al-root').value = album ? (album.root || '/') : '/';
  $('#al-username').value = album ? (album.username || '') : '';
  var pwd = $('#al-password');
  pwd.value = '';
  pwd.placeholder = album ? '留空表示不修改' : '';
  $('#al-auth').value = album && album.auth ? album.auth : 'basic';
  $('#al-verify-tls').checked = album ? album.verifyTLS === false : false;
  $('#al-headers').value = album ? headersToText(album.headers) : '';
  $('#al-adv').open = false;

  var res = $('#al-test-result');
  res.className = 'test-result hidden';
  res.textContent = '';

  $('#dlg-album').classList.remove('hidden');
  state.albumFormSig = albumFormSignature();
  window.setTimeout(function () { $('#al-name').focus(); }, 0);
}

function closeAlbumDialog() {
  $('#dlg-album').classList.add('hidden');
  state.albumFormSig = null;
}

/** Esc / 取消 时的保护：填了一半的专辑表单别一下就没了。 */
function requestCloseAlbumDialog() {
  if (isAlbumFormDirty() && !window.confirm('专辑还没保存，确定放弃并关闭吗？')) return false;
  closeAlbumDialog();
  return true;
}

function showTestResult(kind, message) {
  var res = $('#al-test-result');
  res.className = 'test-result ' + (kind === 'ok' ? 'is-ok' : kind === 'busy' ? 'is-busy' : 'is-bad');
  res.textContent = message;
}

function readAlbumForm() {
  var album = {
    name: $('#al-name').value.trim(),
    type: 'webdav',
    url: $('#al-url').value.trim(),
    root: $('#al-root').value.trim() || '/',
    username: $('#al-username').value.trim(),
    password: $('#al-password').value,
    auth: $('#al-auth').value,
    verifyTLS: !$('#al-verify-tls').checked,
    headers: parseHeaders($('#al-headers').value)
  };
  if (albumDialogMode === 'edit' && albumDialogId) album.id = albumDialogId;
  return album;
}

/** 表单当前内容的指纹，用于判断「改了没保存」。 */
function albumFormSignature() {
  var f = readAlbumForm();
  return JSON.stringify([f.name, f.url, f.root, f.username, f.password, f.auth, f.verifyTLS, f.headers]);
}

function isAlbumFormDirty() {
  return typeof state.albumFormSig === 'string' && albumFormSignature() !== state.albumFormSig;
}

function runAlbumTest() {
  var album = readAlbumForm();
  if (!album.name) { showTestResult('bad', '请先填写名称'); $('#al-name').focus(); return; }
  if (!album.url) { showTestResult('bad', '请先填写服务器地址'); $('#al-url').focus(); return; }

  var btn = $('#al-btn-test');
  var oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '测试中…';
  showTestResult('busy', '正在连接服务器…');

  apiTestAlbum(album).then(function (res) {
    if (res.ok) {
      showTestResult('ok', '连接成功，发现 ' + (res.entries || 0) + ' 个条目，耗时 ' + (res.elapsedMs || 0) + ' ms');
    } else {
      showTestResult('bad', '连接失败：' + (res.message || '未知错误') +
        '（HTTP ' + res.status + '，耗时 ' + (res.elapsedMs || 0) + ' ms）');
    }
  }).catch(function (err) {
    /* 失败可能来自 HTTP 4xx/5xx，也可能是 HTTP 200 + {ok:false, message} */
    var p = err.payload || {};
    var extra = (typeof p.elapsedMs === 'number' && p.status)
      ? '（HTTP ' + p.status + '，耗时 ' + p.elapsedMs + ' ms）' : '';
    showTestResult('bad', '连接失败：' + err.message + extra);
  }).then(function () {
    btn.disabled = false;
    btn.textContent = oldText;
  });
}

function saveAlbumFromDialog() {
  var album = readAlbumForm();
  if (!album.name) { toast('error', '名称不能为空'); $('#al-name').focus(); return; }
  if (!album.url) { toast('error', '服务器地址不能为空'); $('#al-url').focus(); return; }

  var btn = $('#al-btn-save');
  btn.disabled = true;
  var req = albumDialogMode === 'edit'
    ? apiUpdateAlbum(albumDialogId, album)
    : apiCreateAlbum(album);

  req.then(function (res) {
    var saved = res.album || album;
    closeAlbumDialog();
    toast('success', (albumDialogMode === 'edit' ? '已保存专辑：' : '已创建专辑：') + (saved.name || album.name));
    if (albumDialogMode === 'create' && saved && saved.id) state.selectedAlbumId = saved.id;
    saveUiPrefs();
    return refreshState().then(function () {
      if (albumDialogMode === 'edit' && state.selectedAlbumId === albumDialogId) {
        loadBrowse(albumDialogId, state.browse.path);
      }
    });
  }).catch(function (err) {
    toast('error', '保存失败：' + err.message);
    showTestResult('bad', '保存失败：' + err.message);
  }).then(function () {
    btn.disabled = false;
  });
}

function bindAlbumDialog() {
  $('#al-btn-test').addEventListener('click', runAlbumTest);
  $('#al-btn-save').addEventListener('click', saveAlbumFromDialog);
  $('#dlg-album').addEventListener('click', function (ev) {
    if (ev.target.dataset && ev.target.dataset.close) closeAlbumDialog();
  });
  /* 文本字段内回车不会提交任何内容（对话框不是 form） */
  $('#dlg-album').addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    var t = ev.target;
    if (t && t.tagName && t.tagName.toLowerCase() === 'textarea') return;
    if (isTypingTarget(t)) ev.preventDefault();
  });
}

/* ============================ 11. 设置对话框 ============================ */

function openSettingsDialog() {
  var st = state.settings || (state.app && state.app.settings) || {};
  var mpv = (state.app && state.app.mpv) || {};

  $('#st-mpv-path').value = st.mpvPath || mpv.path || '';
  setText($('#st-mpv-help'), mpv.found
    ? ('已检测到 mpv：' + (mpv.version || '版本未知') + (mpv.path ? '（' + mpv.path + '）' : ''))
    : '未检测到 mpv，请填写 mpv.exe 的完整路径。');

  $('#st-video-exts').value = listToText(st.videoExts);
  $('#st-audio-exts').value = listToText(st.audioExts);
  $('#st-sub-exts').value = listToText(st.subExts);
  $('#st-sub-dirs').value = listToText(st.subDirs);
  $('#st-sub-fallback').checked = st.subFallbackSingleVideo !== false;
  $('#st-sub-encoding').value = st.subEncoding || 'auto';
  $('#st-mpv-ontop').checked = st.mpvOntop !== false;
  $('#st-mpv-fullscreen').checked = st.mpvAutoFullscreen === true;
  $('#st-wl-max').value = String(typeof st.watchLaterMaxEntries === 'number' ? st.watchLaterMaxEntries : 200);
  $('#st-wl-days').value = String(typeof st.watchLaterMaxDays === 'number' ? st.watchLaterMaxDays : 90);
  $('#st-alang').value = st.alang || '';
  $('#st-slang').value = st.slang || '';
  $('#st-extra-args').value = Array.isArray(st.extraMpvArgs) ? st.extraMpvArgs.join('\n') : '';
  $('#st-volume').value = String(typeof st.volume === 'number' ? st.volume : 100);

  $('#dlg-settings').classList.remove('hidden');
  window.setTimeout(function () { $('#st-mpv-path').focus(); }, 0);
}

function closeSettingsDialog() {
  $('#dlg-settings').classList.add('hidden');
}

function saveSettingsFromDialog() {
  var vol = Number($('#st-volume').value);
  if (!isFinite(vol)) vol = 100;
  vol = Math.max(0, Math.min(100, Math.round(vol)));

  var partial = {
    mpvPath: $('#st-mpv-path').value.trim(),
    videoExts: parseList($('#st-video-exts').value),
    audioExts: parseList($('#st-audio-exts').value),
    subExts: parseList($('#st-sub-exts').value),
    subDirs: parseList($('#st-sub-dirs').value),
    subFallbackSingleVideo: !!$('#st-sub-fallback').checked,
    subEncoding: $('#st-sub-encoding').value,
    mpvOntop: !!$('#st-mpv-ontop').checked,
    mpvAutoFullscreen: !!$('#st-mpv-fullscreen').checked,
    watchLaterMaxEntries: Math.max(0, parseInt($('#st-wl-max').value, 10) || 0),
    watchLaterMaxDays: Math.max(0, parseInt($('#st-wl-days').value, 10) || 0),
    alang: $('#st-alang').value.trim(),
    slang: $('#st-slang').value.trim(),
    extraMpvArgs: String($('#st-extra-args').value || '').split(/\r?\n/)
      .map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; }),
    volume: vol
  };

  var btn = $('#st-btn-save');
  btn.disabled = true;
  apiSaveSettings(partial).then(function (res) {
    if (res.settings) state.settings = res.settings;
    closeSettingsDialog();
    toast('success', '设置已保存');
    return refreshState();
  }).catch(function (err) {
    toast('error', '设置保存失败：' + err.message);
  }).then(function () {
    btn.disabled = false;
  });
}

function bindSettingsDialog() {
  $('#st-btn-save').addEventListener('click', saveSettingsFromDialog);
  $('#dlg-settings').addEventListener('click', function (ev) {
    if (ev.target.dataset && ev.target.dataset.close) closeSettingsDialog();
  });
  var pruneBtn = $('#st-wl-prune');
  if (pruneBtn) {
    pruneBtn.addEventListener('click', function () {
      pruneBtn.disabled = true;
      api('POST', API.resume + '/prune', {}).then(function (res) {
        var removed = res && res.result ? res.result.removed : 0;
        toast('success', '已清理 ' + removed + ' 条过期进度');
        return refreshResume(true);
      }).catch(function (err) {
        toast('error', '清理失败：' + err.message);
      }).then(function () { pruneBtn.disabled = false; });
    });
  }
}

/* ============================ 12. 顶部状态 / 全局刷新 ============================ */

function renderHeader() {
  var app = state.app || {};
  var mpv = app.mpv || {};
  var pill = $('#mpv-pill');
  var dot = $('#mpv-pill-dot');
  var text = $('#mpv-pill-text');

  if (mpv.found) {
    pill.className = 'pill is-ok';
    setText(text, 'mpv ' + (mpv.version || '已就绪'));
    pill.title = 'mpv 可执行文件：' + (mpv.path || '未知路径');
  } else {
    pill.className = 'pill is-bad';
    setText(text, '未找到 mpv');
    pill.title = '未找到 mpv.exe，请在设置中指定路径';
  }
  if (dot) dot.className = 'pill-dot';

  var right = 'mpv WebDAV 专辑' + (app.version ? ' v' + app.version : '');
  if (!isPlayerActive() && !state.polling) right += ' · 实时连接';
  if (state.polling) right += ' · 轮询模式';
  setStatusRight(right);
}

function refreshState() {
  return apiGet.state().then(function (data) {
    state.app = data;
    state.albums = Array.isArray(data.albums) ? data.albums : [];
    state.settings = data.settings || state.settings;
    state.resume = data.resume || null;
    state.bootError = null;
    $('#boot-error').classList.add('hidden');
    $('#app').classList.remove('hidden');

    if (data.player) applyPlayer(data.player);

    /* 恢复上次选中的专辑；失效的 id 直接丢弃（不自动选择，避免打扰） */
    if (state.selectedAlbumId && !albumById(state.selectedAlbumId)) state.selectedAlbumId = null;
    renderAlbums();
    renderHeader();
    renderToolbar();

    if (state.selectedAlbumId && state.browse.albumId !== state.selectedAlbumId) {
      var album = albumById(state.selectedAlbumId);
      var p = album && album.root ? album.root : '/';
      if (p.charAt(0) !== '/') p = '/' + p;
      loadBrowse(state.selectedAlbumId, p);
    } else if (!state.browse.albumId) {
      renderBrowser();
    }
    setStatus('就绪', 'ok');
    return data;
  });
}

function showBootError(message) {
  state.bootError = message;
  setText($('#boot-error-msg'), message || '未知错误');
  $('#boot-error').classList.remove('hidden');
  $('#app').classList.add('hidden');
}

/* ============================ 13. 键盘快捷键 ============================ */

function bindKeyboard() {
  document.addEventListener('keydown', function (ev) {
    /* Esc：关闭对话框与弹出菜单 */
    if (ev.key === 'Escape') {
      closeCtxMenu();
      if (!$('#dlg-album').classList.contains('hidden')) { requestCloseAlbumDialog(); return; }
      if (!$('#dlg-settings').classList.contains('hidden')) { closeSettingsDialog(); return; }
      return;
    }

    /* F5 一律不拦截（永不 preventDefault） */

    if (isTypingTarget(ev.target)) return;

    /* 网页不做播放遥控：暂停 / 进度 / 音量都在 mpv 窗口里操作。
       这里只保留"浏览"相关的快捷键（/ 搜索、回车进入、上下选择）。 */

    /* 焦点在按钮 / 链接上时交给浏览器原生行为（空格点击、回车激活） */
    var tag = ev.target && ev.target.tagName ? ev.target.tagName.toLowerCase() : '';
    if (tag === 'button' || tag === 'a') return;

    /* 对话框打开时不再处理下面的全局快捷键 */
    if (!$('#dlg-album').classList.contains('hidden') || !$('#dlg-settings').classList.contains('hidden')) return;

    if (ev.key === '/') {
      ev.preventDefault();
      $('#search-input').focus();
      $('#search-input').select();
      return;
    }

    if (ev.key === 'Enter') {
      var list = visibleEntries();
      if (state.selIndex >= 0 && state.selIndex < list.length) {
        ev.preventDefault();
        enterEntry(list[state.selIndex]);
      }
      return;
    }

    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      var items = visibleEntries();
      if (!items.length) return;
      ev.preventDefault();
      if (ev.key === 'ArrowDown') state.selIndex = Math.min(items.length - 1, state.selIndex + 1);
      else state.selIndex = Math.max(0, state.selIndex - 1);
      renderListing();
      scrollSelectionIntoView();
    }
  });

  document.addEventListener('click', function (ev) {
    if (!state.ctxMenu) return;
    if (ev.target && ev.target.closest && ev.target.closest('.ctx-menu')) return;
    closeCtxMenu();
  });
  window.addEventListener('blur', closeCtxMenu);
}

/* ============================ 14. 启动引导 ============================ */

function boot() {
  loadUiPrefs();
  renderToolbar();
  renderListing();
  renderTabTitle();
  renderHeader();

  bindToolbar();
  bindAlbumList();
  bindListing();
  bindAlbumDialog();
  bindSettingsDialog();
  bindKeyboard();

  $('#boot-error-retry').addEventListener('click', function () {
    $('#boot-error').classList.add('hidden');
    $('#app').classList.remove('hidden');
    refreshState().catch(function (err) { showBootError(err.message); });
  });

  refreshState().then(function () {
    state.booted = true;
    startEvents();
  }).catch(function (err) {
    console.error('初始化失败：', err && err.message);
    showBootError(err.message);
    /* 即使 /api/state 失败也尝试事件流，方便后端稍后恢复 */
    startEvents();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
