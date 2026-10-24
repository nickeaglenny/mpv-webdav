'use strict';
// 字幕编码检测 / 转码单元测试（不联网、不需要 mpv）。
// 用法：node tools/encoding-test.js

const { detectAndDecode, toUtf8Buffer } = require('../server/text-encoding');
const media = require('../server/media');

const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}

// 手工构造字节，避免依赖“编码器”（Node 只能解码这些编码）
// GBK: 中=D6D0 文=CEC4 字=D7D6 幕=C4BB
const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xd7, 0xd6, 0xc4, 0xbb]);
// BIG5: 中=A4A4 文=A4E5
const big5 = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]);
const utf8 = Buffer.from('中文字幕', 'utf8');
const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]);
const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文字幕', 'utf16le')]);
const ascii = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello world\n', 'utf8');

const g = detectAndDecode(gbk);
check('GBK 被识别为 gbk/gb18030', ['gbk', 'gb18030'].includes(g.encoding), g.encoding);
check('GBK 解码内容正确', g.text === '中文字幕', JSON.stringify(g.text));

const b = detectAndDecode(big5);
check('BIG5 被识别为 big5', b.encoding === 'big5', b.encoding);
check('BIG5 解码内容正确', b.text === '中文', JSON.stringify(b.text));

const u = detectAndDecode(utf8);
check('合法 UTF-8 不会被误判', u.encoding === 'utf-8' && u.text === '中文字幕', u.encoding);

const ub = detectAndDecode(utf8Bom);
check('带 BOM 的 UTF-8 正确去 BOM', ub.encoding === 'utf-8' && ub.text === '中文字幕', JSON.stringify(ub.text));

const u16 = detectAndDecode(utf16le);
check('UTF-16LE BOM 被识别', u16.encoding === 'utf-16le' && u16.text === '中文字幕', `${u16.encoding} / ${JSON.stringify(u16.text)}`);

const a = detectAndDecode(ascii);
check('纯 ASCII 视为 UTF-8', a.encoding === 'utf-8' && a.text.includes('Hello world'), a.encoding);

const conv = toUtf8Buffer(gbk);
check('GBK 转 UTF-8 结果正确', conv.changed === true && conv.buffer.equals(utf8), conv.buffer.toString('hex'));

const same = toUtf8Buffer(utf8);
check('已是 UTF-8 时不改动内容', same.changed === false && same.buffer.equals(utf8));

const forced = toUtf8Buffer(big5, { force: 'big5' });
check('可强制指定编码（BIG5）', forced.buffer.equals(Buffer.from('中文', 'utf8')), forced.encoding);

// 真实场景：GBK 的 ASS 文件头 + 中文对白
const assGbk = Buffer.concat([
  Buffer.from('[Script Info]\nTitle: ', 'utf8'),
  Buffer.from([0xb2, 0xe2, 0xca, 0xd4]),                    // “测试”的 GBK 字节
  Buffer.from('\n[Events]\nDialogue: 0,0:00:00.20,0:00:03.00,Default,,0,0,0,,', 'utf8'),
  Buffer.from([0xd5, 0xe2, 0xbe, 0xe4, 0xd7, 0xd6, 0xc4, 0xbb]), // “这句字幕”
]);
const assConv = toUtf8Buffer(assGbk);
check('GBK 的 ASS 文件可整体转成 UTF-8',
  assConv.changed && assConv.buffer.toString('utf8').includes('测试') && assConv.buffer.toString('utf8').includes('这句字幕'),
  assConv.buffer.toString('utf8').split('\n')[1]);

// ---------- 内嵌字幕轨的自动选择（无语言标记时也要能挑到中文） ----------
const noLang = [
  { id: 1, type: 'video' },
  { id: 1, type: 'sub', title: '简体中文' },
  { id: 2, type: 'sub', title: '繁體中文' },
  { id: 3, type: 'sub', title: 'English', default: true },
];
check('无语言标记时按标题挑到简体中文', media.pickSubtitleTrack(noLang) === 1, String(media.pickSubtitleTrack(noLang)));
check('有语言标记时按 chi 挑',
  media.pickSubtitleTrack([{ id: 1, type: 'sub', lang: 'chi' }, { id: 2, type: 'sub', lang: 'eng', default: true }]) === 1);
check('完全没元数据时选第一条',
  media.pickSubtitleTrack([{ id: 7, type: 'sub' }, { id: 8, type: 'sub', default: true }]) === 7);
check('没有字幕轨返回 null', media.pickSubtitleTrack([{ id: 1, type: 'video' }]) === null);
check('外挂中文字幕优先于英文',
  media.pickSubtitleTrack([{ id: 1, type: 'sub', title: 'movie.eng.srt' }, { id: 2, type: 'sub', title: 'movie.chs.srt' }]) === 2);
check('忽略 dependent 轨（forced/封面等）',
  media.pickSubtitleTrack([{ id: 1, type: 'sub', title: 'English', dependent: true }, { id: 2, type: 'sub', title: '中文' }]) === 2);
check('default 标记不能盖过中文优先（正是要修的那个 bug）',
  media.pickSubtitleTrack([{ id: 1, type: 'sub', title: '简体中文' }, { id: 3, type: 'sub', title: 'English', default: true }]) === 1);

console.log('');
console.log(`结果: ${results.filter((r) => r.ok).length}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log('  失败: ' + r.name + (r.detail ? ' :: ' + r.detail : ''));
process.exit(failed ? 1 : 0);
