'use strict';
// Minimal, non-validating XML parser — just enough for WebDAV <multistatus>.
// Produces { name, local, attrs, children, text } nodes. Namespace prefixes are
// kept in `name` (e.g. "D:href") and stripped in `local` (e.g. "href").

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m;
  });
}

function parseXml(input) {
  const src = String(input == null ? '' : input);
  const root = { name: '#document', local: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;

  const top = () => stack[stack.length - 1];
  const pushText = (raw) => {
    if (!raw) return;
    const text = decodeEntities(raw);
    const node = top();
    node.text += text;
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { pushText(src.slice(i)); break; }
    if (lt > i) pushText(src.slice(i, lt));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const raw = end === -1 ? src.slice(lt + 9) : src.slice(lt + 9, end);
      top().text += raw;
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }

    const gt = findTagEnd(src, lt);
    if (gt === -1) { pushText(src.slice(lt)); break; }
    const rawTag = src.slice(lt + 1, gt);
    i = gt + 1;

    if (rawTag[0] === '/') {
      const name = rawTag.slice(1).trim();
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].name === name) { stack.length = d; break; }
      }
      continue;
    }

    const selfClosing = rawTag.endsWith('/');
    const body = selfClosing ? rawTag.slice(0, -1) : rawTag;
    const spaceIdx = body.search(/[\s]/);
    const name = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).trim();
    const attrText = spaceIdx === -1 ? '' : body.slice(spaceIdx);
    const colon = name.indexOf(':');
    const node = {
      name,
      local: colon === -1 ? name : name.slice(colon + 1),
      attrs: parseAttrs(attrText),
      children: [],
      text: '',
    };
    top().children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

function findTagEnd(src, start) {
  let quote = null;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}

function parseAttrs(text) {
  const attrs = {};
  const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(text))) {
    attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
  }
  return attrs;
}

// All descendant elements whose local name matches (case-insensitive).
function findAll(node, localName, out = []) {
  const want = localName.toLowerCase();
  for (const child of node.children || []) {
    if (child.local.toLowerCase() === want) out.push(child);
    findAll(child, want, out);
  }
  return out;
}

// Direct children only.
function childrenOf(node, localName) {
  const want = localName.toLowerCase();
  return (node.children || []).filter((c) => c.local.toLowerCase() === want);
}

function first(node, localName) {
  const want = localName.toLowerCase();
  for (const child of node.children || []) {
    if (child.local.toLowerCase() === want) return child;
  }
  return null;
}

function textOf(node) {
  if (!node) return '';
  let out = node.text || '';
  for (const child of node.children || []) out += textOf(child);
  return out;
}

module.exports = { parseXml, findAll, childrenOf, first, textOf, decodeEntities };
