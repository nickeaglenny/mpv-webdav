'use strict';
// 外挂字幕的编码检测与转码：中文影视库里大量 .srt/.ass 是 GBK/GB18030 或 BIG5，
// mpv 默认按 UTF-8 解码就会显示成 ÎÒh»á¹yz 这种乱码。
// 这里把字幕统一转成 UTF-8 再交给 mpv，就不需要用户手动调 --sub-codepage。

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// 候选编码按「先严格解码、再打分」挑选
const CANDIDATES = ['gbk', 'big5', 'gb18030', 'shift_jis', 'euc-kr', 'windows-1252'];

function decodeStrict(buf, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

function decodeLoose(buf, encoding) {
  try {
    return new TextDecoder(encoding).decode(buf);
  } catch {
    return null;
  }
}

// 文本「像不像正常中文字幕」的粗略打分：
// 汉字/中文标点/全角字符给高分；假名（汉字被按 GBK 误判成日文假名时的典型产物）
// 只给很低的分；控制字符与替换字符扣分。
function scoreText(text) {
  let score = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c === 0xfffd) { score -= 20; continue; }
    if (c === 0x09 || c === 0x0a || c === 0x0d) { score += 2; continue; }
    if (c < 0x20) { score -= 10; continue; }
    if (c < 0x7f) { score += 2; continue; }
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff)) { score += 10; continue; }
    if (c >= 0x3000 && c <= 0x303f) { score += 6; continue; }   // 中文标点
    if (c >= 0xff01 && c <= 0xff60) { score += 6; continue; }   // 全角 ASCII
    if (c >= 0xff61 && c <= 0xff9f) { score += 1; continue; }   // 半角片假名（错判信号）
    if (c >= 0x3040 && c <= 0x30ff) { score += 2; continue; }   // 平假名 / 片假名
    if (c >= 0xac00 && c <= 0xd7af) { score += 3; continue; }   // 韩文
    score += 1;
  }
  return score;
}

// 返回 { encoding, text, bom }
function detectAndDecode(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);

  // 1) BOM 优先
  if (buf.length >= 3 && buf.subarray(0, 3).equals(UTF8_BOM)) {
    return { encoding: 'utf-8', text: buf.subarray(3).toString('utf8'), bom: true };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: 'utf-16le', text: decodeLoose(buf.subarray(2), 'utf-16le') || '', bom: true };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: 'utf-16be', text: decodeLoose(buf.subarray(2), 'utf-16be') || '', bom: true };
  }

  // 2) 合法 UTF-8 就直接用
  const utf8 = decodeStrict(buf, 'utf-8');
  if (utf8 !== null) return { encoding: 'utf-8', text: utf8, bom: false };

  // 3) 逐个候选严格解码并打分，取最高分（同分时按候选顺序优先，GBK 排最前）
  let best = null;
  for (let i = 0; i < CANDIDATES.length; i++) {
    const enc = CANDIDATES[i];
    const text = decodeStrict(buf, enc);
    if (text === null) continue;
    const score = scoreText(text) + (CANDIDATES.length - i) * 0.5;
    if (!best || score > best.score) best = { encoding: enc, text, score };
  }
  if (best) return { encoding: best.encoding, text: best.text, bom: false };

  // 4) 兜底：windows-1252 不会失败
  return { encoding: 'windows-1252', text: decodeLoose(buf, 'windows-1252') || buf.toString('latin1'), bom: false };
}

// 把任意编码的字幕转成 UTF-8 Buffer；已经是 UTF-8 时 changed=false
function toUtf8Buffer(buf, { force = null } = {}) {
  if (force && force !== 'auto') {
    const text = decodeStrict(buf, force) ?? decodeLoose(buf, force);
    if (text === null) throw new Error('无法用 ' + force + ' 解码该字幕');
    return { buffer: Buffer.from(text, 'utf8'), encoding: force, changed: force !== 'utf-8' };
  }
  const { encoding, text, bom } = detectAndDecode(buf);
  const changed = encoding !== 'utf-8' || bom;
  if (!changed) return { buffer: buf, encoding, changed: false };
  return { buffer: Buffer.from(text, 'utf8'), encoding, changed: true };
}

function isSubtitleEncodingUsable(enc) {
  const list = ['auto', 'off', 'utf-8', 'utf8', 'gbk', 'gb18030', 'gb2312', 'big5', 'shift_jis', 'euc-kr', 'windows-1252', 'utf-16le', 'utf-16be'];
  return list.includes(String(enc || '').toLowerCase());
}

module.exports = { detectAndDecode, toUtf8Buffer, scoreText, isSubtitleEncodingUsable, CANDIDATES };
