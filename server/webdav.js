'use strict';
// WebDAV client: PROPFIND listing, auth (basic / digest / none), TLS options,
// redirects and a Range-capable streaming GET used by the /stream proxy that mpv reads.

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const { parseXml, findAll, first, childrenOf, textOf } = require('./xml');

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<D:propfind xmlns:D="DAV:"><D:prop>' +
  '<D:displayname/><D:resourcetype/><D:getcontentlength/>' +
  '<D:getlastmodified/><D:getcontenttype/><D:creationdate/>' +
  '</D:prop></D:propfind>';

class WebDAVError extends Error {
  constructor(message, status = 0, detail = null) {
    super(message);
    this.name = 'WebDAVError';
    this.status = status;
    this.detail = detail;
  }
}

function normalizeRel(p) {
  let s = String(p == null ? '' : p).replace(/\\/g, '/').trim();
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/{2,}/g, '/');
  // Drop "." / ".." segments so a crafted path cannot escape the album root.
  const parts = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return '/' + parts.join('/');
}

function encodePath(p) {
  return normalizeRel(p).split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

function decodeSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function md5hex(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

function parseChallenge(header) {
  if (!header) return null;
  const m = /^\s*(\w+)\s+(.*)$/s.exec(header);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const params = {};
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;
  let x;
  while ((x = re.exec(m[2]))) params[x[1].toLowerCase()] = x[2] !== undefined ? x[2] : x[3];
  return { scheme, params };
}

function buildDigestHeader({ username, password, method, uri, challenge, nc, cnonce }) {
  const p = challenge.params || {};
  const realm = p.realm || '';
  const nonce = p.nonce || '';
  const qopRaw = (p.qop || '').split(',').map((s) => s.trim()).filter(Boolean);
  const qop = qopRaw.includes('auth') || qopRaw.length === 0 ? 'auth' : qopRaw[0];
  const algorithm = (p.algorithm || 'MD5').toUpperCase();
  const ncHex = nc.toString(16).padStart(8, '0');

  let ha1 = md5hex(`${username}:${realm}:${password}`);
  if (algorithm === 'MD5-SESS') ha1 = md5hex(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = md5hex(`${method.toUpperCase()}:${uri}`);
  const response = qop
    ? md5hex(`${ha1}:${nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`)
    : md5hex(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (p.algorithm) parts.push(`algorithm=${p.algorithm}`);
  if (p.opaque) parts.push(`opaque="${p.opaque}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${ncHex}`, `cnonce="${cnonce}"`);
  return 'Digest ' + parts.join(', ');
}

class WebDAVClient {
  constructor(album) {
    this.album = album;
    let base;
    try {
      base = new URL(album.url);
    } catch {
      throw new WebDAVError('服务器地址不是合法 URL：' + album.url, 0);
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      throw new WebDAVError('只支持 http/https 地址：' + album.url, 0);
    }
    this.baseUrl = base;
    this.basePath = base.pathname.replace(/\/+$/, '');
    this.rootPath = normalizeRel(album.root || '/').replace(/\/+$/, '');
    this.authType = ['basic', 'digest', 'none'].includes(album.auth) ? album.auth : 'basic';
    this.challenge = null;
    this.nc = 0;
    this.cnonce = crypto.randomBytes(8).toString('hex');
  }

  // Full URL path (before percent-encoding) for a path relative to the album root.
  fullPath(rel) {
    const r = normalizeRel(rel);
    return (this.basePath + this.rootPath + (r === '/' ? '' : r)) || '/';
  }

  urlFor(rel) {
    return this.baseUrl.origin + encodePath(this.fullPath(rel));
  }

  // Decoded album-relative path for a href coming back from the server.
  hrefToRel(href) {
    if (!href) return null;
    let pathname = href;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(href)) {
      try { pathname = new URL(href).pathname; } catch { return null; }
    }
    pathname = decodeSafe(pathname).replace(/\/+$/, '');
    const prefix = (this.basePath + this.rootPath).replace(/\/+$/, '');
    let rel;
    if (pathname.toLowerCase().startsWith(prefix.toLowerCase())) {
      rel = pathname.slice(prefix.length);
    } else {
      return null; // outside of this album
    }
    return normalizeRel(rel);
  }

  authHeader(method, uriPath) {
    const { username = '', password = '' } = this.album;
    if (this.authType === 'none') return null;
    if (this.authType === 'basic') {
      if (!username && !password) return null;
      const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
      return 'Basic ' + token;
    }
    // digest: only after a challenge is known (avoids leaking the password)
    if (!this.challenge) return null;
    this.nc += 1;
    return buildDigestHeader({
      username, password, method, uri: uriPath,
      challenge: this.challenge, nc: this.nc, cnonce: this.cnonce,
    });
  }

  headerFields() {
    const extra = this.album.headers && typeof this.album.headers === 'object' ? this.album.headers : {};
    const out = {};
    for (const [k, v] of Object.entries(extra)) {
      if (k && v != null) out[k] = String(v);
    }
    return out;
  }

  // One HTTP round trip. Returns the raw response (body already collected when wantBuffer).
  send(method, url, { headers = {}, body = null, wantBuffer = true } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      const reqHeaders = Object.assign({}, this.headerFields(), headers);
      const auth = this.authHeader(method, u.pathname);
      if (auth && !reqHeaders.Authorization && !reqHeaders.authorization) reqHeaders.Authorization = auth;

      const opts = {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: reqHeaders,
        rejectUnauthorized: this.album.verifyTLS === false ? false : undefined,
      };

      const req = mod.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          rawHeaders: res.rawHeaders,
          body: wantBuffer ? Buffer.concat(chunks) : null,
          stream: null,
        }));
        res.on('error', reject);
      });
      req.setTimeout(this.album.timeoutMs || 20000, () => {
        req.destroy(new WebDAVError('请求超时（' + (this.album.timeoutMs || 20000) + 'ms）', 0));
      });
      req.on('error', (err) => {
        const msg = err && err.code === 'ENOTFOUND'
          ? '无法解析主机名：' + u.hostname
          : err && err.code === 'ECONNREFUSED'
            ? '连接被拒绝：' + u.host
            : err && /certificate|self.signed|unable to verify/i.test(String(err.message))
              ? 'TLS 证书校验失败（可在专辑里勾选“忽略证书校验”）'
              : `网络错误：${err && err.message ? err.message : err}`;
        reject(err instanceof WebDAVError ? err : new WebDAVError(msg, 0, err));
      });
      if (body) req.write(body);
      req.end();
    });
  }

  // Like send(), but follows redirects, answers digest challenges and (optionally)
  // hands back a live stream instead of a buffered body.
  async perform(method, url, opts = {}) {
    const { body = null, headers = {}, streamed = false, redirects = 5 } = opts;
    let currentUrl = url;
    let triedDigest = false;

    for (let attempt = 0; attempt <= redirects + 1; attempt++) {
      const res = streamed
        ? await this.sendStreamed(method, currentUrl, { headers, body })
        : await this.send(method, currentUrl, { headers, body, wantBuffer: true });

      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
        if (streamed && res.stream) res.stream.destroy();
        currentUrl = new URL(res.headers.location, currentUrl).toString();
        continue;
      }

      if (res.status === 401) {
        const challengeHeader = res.headers['www-authenticate'];
        const parsed = parseChallenge(challengeHeader);
        if (parsed && parsed.scheme === 'digest' && this.authType === 'digest' && !triedDigest) {
          this.challenge = parsed;
          this.nc = 0;
          triedDigest = true;
          if (streamed && res.stream) res.stream.destroy();
          continue;
        }
        if (streamed && res.stream) res.stream.destroy();
        throw new WebDAVError('认证失败（401）。请检查用户名/密码与认证方式。', 401);
      }

      if (res.status === 403) {
        if (streamed && res.stream) res.stream.destroy();
        throw new WebDAVError('服务器拒绝访问（403）：无权限访问该路径。', 403);
      }

      return res;
    }
    throw new WebDAVError('重定向次数过多或认证重试失败', 0);
  }

  // Streaming variant of send(): resolves once the response headers are available.
  sendStreamed(method, url, { headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      const reqHeaders = Object.assign({}, this.headerFields(), headers);
      const auth = this.authHeader(method, u.pathname);
      if (auth && !reqHeaders.Authorization && !reqHeaders.authorization) reqHeaders.Authorization = auth;

      const req = mod.request({
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: reqHeaders,
        rejectUnauthorized: this.album.verifyTLS === false ? false : undefined,
      }, (res) => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          stream: res,
          abort: () => req.destroy(),
        });
      });
      req.setTimeout(this.album.timeoutMs || 20000, () => {
        req.destroy(new WebDAVError('请求超时', 0));
      });
      req.on('error', (err) => {
        reject(err instanceof WebDAVError ? err : new WebDAVError(`网络错误：${err.message}`, 0, err));
      });
      if (body) req.write(body);
      req.end();
    });
  }

  async propfind(rel, depth = 1) {
    const url = this.urlFor(rel);
    const res = await this.perform('PROPFIND', url, {
      headers: {
        Depth: String(depth),
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(PROPFIND_BODY),
        Accept: 'application/xml, text/xml, */*',
      },
      body: PROPFIND_BODY,
    });

    if (res.status === 404) throw new WebDAVError('路径不存在（404）', 404);
    if (res.status === 405) throw new WebDAVError('服务器不支持 WebDAV PROPFIND（405）', 405);
    if (res.status === 409) throw new WebDAVError('路径冲突（409）', 409);
    if (res.status !== 207 && res.status !== 200) {
      throw new WebDAVError(`PROPFIND 失败：HTTP ${res.status}`, res.status);
    }

    const text = res.body ? res.body.toString('utf8') : '';
    if (!text.trim()) {
      if (depth === 0) return { self: null, entries: [] };
      throw new WebDAVError('服务器返回了空的 PROPFIND 响应', res.status);
    }
    const doc = parseXml(text);
    const responses = findAll(doc, 'response');
    const selfPath = normalizeRel(rel);
    const entries = [];
    let selfEntry = null;

    for (const r of responses) {
      const href = textOf(first(r, 'href'));
      const relPath = this.hrefToRel(href);
      if (relPath == null) continue;

      const propstats = findAll(r, 'propstat');
      let prop = null;
      for (const ps of propstats) {
        const status = textOf(first(ps, 'status')) || '';
        if (/2\d\d/.test(status)) { prop = first(ps, 'prop'); break; }
      }
      if (!prop) prop = first(r, 'prop');

      const rt = first(prop, 'resourcetype');
      const isDir = !!rt && childrenOf(rt, 'collection').length > 0;
      const sizeRaw = textOf(first(prop, 'getcontentlength'));
      const mtimeRaw = textOf(first(prop, 'getlastmodified')) || textOf(first(prop, 'creationdate'));
      const displayName = textOf(first(prop, 'displayname'));
      const contentType = textOf(first(prop, 'getcontenttype'));

      const mtime = mtimeRaw ? new Date(mtimeRaw) : null;
      const name = relPath === '/' ? '' : decodeSafe(relPath.split('/').filter(Boolean).pop() || '');

      const entry = {
        path: relPath,
        name: displayName && displayName.trim() ? displayName.trim() : name,
        isDir,
        size: sizeRaw ? parseInt(sizeRaw, 10) || 0 : 0,
        mtime: mtime && !Number.isNaN(mtime.getTime()) ? mtime.toISOString() : null,
        contentType: contentType || '',
      };

      if (relPath === selfPath || (isDir && selfPath !== '/' && relPath === selfPath)) {
        selfEntry = entry;
        continue;
      }
      if (isDir && selfPath === '/' && relPath === '/') { selfEntry = entry; continue; }
      if (name === '') { selfEntry = entry; continue; }
      entries.push(entry);
    }

    return { self: selfEntry, entries };
  }

  async list(rel) {
    const { entries } = await this.propfind(rel, 1);
    return entries;
  }

  // Range-capable GET (or HEAD) for the local stream proxy.
  async open(rel, { method = 'GET', range = null, ifRange = null } = {}) {
    const headers = { Accept: '*/*', Connection: 'keep-alive' };
    if (range) headers.Range = range;
    if (ifRange) headers['If-Range'] = ifRange;
    const res = await this.perform(method, this.urlFor(rel), { headers, streamed: true });
    return res;
  }
}

module.exports = { WebDAVClient, WebDAVError, normalizeRel, encodePath, parseChallenge };
