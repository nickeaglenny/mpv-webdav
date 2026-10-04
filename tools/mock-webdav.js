'use strict';
// Minimal WebDAV server used only for local end-to-end testing of mpv-webdav.
// Serves a filesystem folder with PROPFIND / GET(Range) / HEAD / OPTIONS and a
// choice of basic, digest or no authentication.
//
// Usage: node tools/mock-webdav.js --root tools/testdata --port 8899
//          [--base /dav] [--auth basic|digest|none] [--user u --pass p]

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i === -1 ? def : argv[i + 1];
}

const ROOT = path.resolve(arg('root', path.join(__dirname, 'testdata')));
const PORT = parseInt(arg('port', '8899'), 10);
const BASE = arg('base', '/dav').replace(/\/+$/, '');
const AUTH = arg('auth', 'basic');
const USER = arg('user', 'tester');
const PASS = arg('pass', 'secret');
const REALM = 'mockdav';
const NONCE = crypto.randomBytes(8).toString('hex');

const MIME = {
  '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.avi': 'video/x-msvideo',
  '.srt': 'application/x-subrip', '.ass': 'text/x-ssa', '.vtt': 'text/vtt',
  '.txt': 'text/plain; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png',
};

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}

function authOk(req) {
  if (AUTH === 'none') return true;
  const header = req.headers.authorization || '';
  if (AUTH === 'basic') {
    if (!header.startsWith('Basic ')) return false;
    const [u, p] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
    return u === USER && p === PASS;
  }
  if (AUTH === 'digest') {
    if (!header.startsWith('Digest ')) return false;
    const params = {};
    const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;
    let m;
    while ((m = re.exec(header.slice(7)))) params[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
    if (params.nonce !== NONCE) return false;
    const ha1 = md5(`${USER}:${REALM}:${PASS}`);
    const ha2 = md5(`${req.method}:${params.uri}`);
    const expect = params.qop
      ? md5(`${ha1}:${params.nonce}:${params.nc}:${params.cnonce}:${params.qop}:${ha2}`)
      : md5(`${ha1}:${params.nonce}:${ha2}`);
    return expect === params.response;
  }
  return false;
}

function challenge(res) {
  if (AUTH === 'digest') {
    res.setHeader('WWW-Authenticate',
      `Digest realm="${REALM}", nonce="${NONCE}", qop="auth", algorithm=MD5`);
  } else if (AUTH === 'basic') {
    res.setHeader('WWW-Authenticate', `Basic realm="${REALM}"`);
  }
  res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('401 Unauthorized');
}

// Map a request pathname onto the local filesystem (no traversal outside ROOT).
function localPath(pathname) {
  let rel = pathname;
  if (rel.toLowerCase().startsWith(BASE.toLowerCase())) rel = rel.slice(BASE.length);
  rel = decodeURIComponent(rel);
  const clean = path.posix.normalize('/' + rel.replace(/\\/g, '/'));
  const abs = path.join(ROOT, clean);
  if (!path.resolve(abs).toLowerCase().startsWith(path.resolve(ROOT).toLowerCase())) return null;
  return abs;
}

function hrefFor(localAbs, isDir) {
  const rel = path.relative(ROOT, localAbs).split(path.sep).join('/');
  const enc = rel.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return BASE + '/' + enc + (isDir ? '/' : '');
}

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function statToResponse(localAbs) {
  const st = fs.statSync(localAbs);
  const isDir = st.isDirectory();
  return (
    '<D:response>' +
    `<D:href>${xmlEscape(hrefFor(localAbs, isDir))}</D:href>` +
    '<D:propstat><D:prop>' +
    `<D:displayname>${xmlEscape(path.basename(localAbs) || '')}</D:displayname>` +
    (isDir ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>') +
    (isDir ? '' : `<D:getcontentlength>${st.size}</D:getcontentlength>`) +
    `<D:getlastmodified>${st.mtime.toUTCString()}</D:getlastmodified>` +
    (isDir ? '' : `<D:getcontenttype>${MIME[path.extname(localAbs).toLowerCase()] || 'application/octet-stream'}</D:getcontenttype>`) +
    '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>' +
    '</D:response>'
  );
}

function propfind(req, res) {
  const local = localPath(new URL(req.url, 'http://x').pathname);
  if (!local || !fs.existsSync(local)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  const depth = String(req.headers.depth || '1');
  const parts = [statToResponse(local)];
  if (depth !== '0' && fs.statSync(local).isDirectory()) {
    for (const name of fs.readdirSync(local)) {
      parts.push(statToResponse(path.join(local, name)));
    }
  }
  const body =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<D:multistatus xmlns:D="DAV:">' + parts.join('') + '</D:multistatus>';
  res.writeHead(207, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveFile(req, res, local) {
  const st = fs.statSync(local);
  const type = MIME[path.extname(local).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  log(`${req.method} ${decodeURIComponent(req.url)} ${range ? 'Range=' + range : ''}`);

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : null;
      let end = m[2] ? parseInt(m[2], 10) : null;
      if (start === null && end !== null) { start = Math.max(0, st.size - end); end = st.size - 1; }
      if (start !== null && end === null) end = st.size - 1;
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(local, { start, end }).pipe(res);
    }
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Accept-Ranges': 'bytes',
  });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(local).pipe(res);
}

const server = http.createServer((req, res) => {
  if (!fs.existsSync(ROOT)) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('测试目录不存在：' + ROOT);
  }
  if (!authOk(req)) {
    log(`401 ${req.method} ${decodeURIComponent(req.url)} auth="${req.headers.authorization || '(none)'}"`);
    return challenge(res);
  }

  const pathname = new URL(req.url, 'http://x').pathname;
  if (!pathname.toLowerCase().startsWith(BASE.toLowerCase())) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 outside base');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(200, { DAV: '1,2', Allow: 'OPTIONS,GET,HEAD,PROPFIND' });
    return res.end();
  }
  if (req.method === 'PROPFIND') {
    log(`PROPFIND ${decodeURIComponent(req.url)} depth=${req.headers.depth}`);
    return propfind(req, res);
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const local = localPath(pathname);
    if (!local || !fs.existsSync(local) || fs.statSync(local).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    return serveFile(req, res, local);
  }
  res.writeHead(405, { Allow: 'OPTIONS,GET,HEAD,PROPFIND' });
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  log(`mock WebDAV on http://127.0.0.1:${PORT}${BASE} root=${ROOT} auth=${AUTH}`);
});

process.on('SIGINT', () => { server.close(() => process.exit(0)); });
