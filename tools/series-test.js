'use strict';
// 剧集连播的离线单测：自然排序 + "从这一集开始"的播放列表组装（不需要 mpv / 网络）。
// 用法：node tools/series-test.js

const media = require('../server/media');

const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}

const settings = {
  videoExts: media.DEFAULT_VIDEO_EXTS,
  audioExts: media.DEFAULT_AUDIO_EXTS,
  imageExts: media.DEFAULT_IMAGE_EXTS,
  subExts: media.DEFAULT_SUB_EXTS,
};

// ---------- 自然排序 ----------
const sorted = ['剧 第10集.mp4', '剧 第2集.mp4', '剧 第1集.mp4', '剧 第20集.mp4']
  .sort(media.naturalCompare);
check('数字段按数值排序（第1 < 第2 < 第10 < 第20）',
  sorted.join('|') === '剧 第1集.mp4|剧 第2集.mp4|剧 第10集.mp4|剧 第20集.mp4', sorted.join(' | '));
check('普通字符串排序确实是反的（说明这个函数有意义）',
  ['剧 第10集.mp4', '剧 第2集.mp4'].sort().join('|') === '剧 第10集.mp4|剧 第2集.mp4');
check('S01E02 形式也能正确排',
  ['S01E10.mkv', 'S01E2.mkv', 'S01E1.mkv'].sort(media.naturalCompare).join('|') === 'S01E1.mkv|S01E2.mkv|S01E10.mkv');
check('带前导零与不带前导零混排（01 与 1 视为同段数值）',
  media.naturalCompare('EP01.mp4', 'EP1.mp4') === 0 || media.naturalCompare('EP01.mp4', 'EP1.mp4') < 0);
check('没有数字时退化为本地化文本比较',
  media.naturalCompare('阿凡达.mp4', '蝙蝠侠.mp4') < 0);
check('完全相同的名字返回 0', media.naturalCompare('a.mp4', 'a.mp4') === 0);

// ---------- 连播列表 ----------
const dir = [
  { name: '剧 第1集.mp4', path: '/剧/剧 第1集.mp4', isDir: false },
  { name: '剧 第2集.mp4', path: '/剧/剧 第2集.mp4', isDir: false },
  { name: '剧 第10集.mp4', path: '/剧/剧 第10集.mp4', isDir: false },
  { name: '海报.jpg', path: '/剧/海报.jpg', isDir: false },
  { name: 'ost.mp3', path: '/剧/ost.mp3', isDir: false },
  { name: 'subs', path: '/剧/subs', isDir: true },
  { name: '剧 第2集.chs.srt', path: '/剧/剧 第2集.chs.srt', isDir: false },
];

const fromEp2 = media.buildSeries(dir, '剧 第2集.mp4', 'video', settings);
check('从第2集开始：返回 [第2集, 第10集]',
  fromEp2.map((e) => e.name).join('|') === '剧 第2集.mp4|剧 第10集.mp4', fromEp2.map((e) => e.name).join(' | '));
check('只包含同类型（视频），排除音频/图片/字幕/目录',
  fromEp2.every((e) => /\.mp4$/.test(e.name)), fromEp2.map((e) => e.path).join(' | '));
check('每一项都带完整路径（供服务端拼流地址）',
  fromEp2[0].path === '/剧/剧 第2集.mp4');

const fromEp1 = media.buildSeries(dir, '剧 第1集.mp4', 'video', settings);
check('从第1集开始：后面还有 2 集', fromEp1.length === 3, String(fromEp1.length));
const fromLast = media.buildSeries(dir, '剧 第10集.mp4', 'video', settings);
check('从最后一集开始：只有它自己', fromLast.length === 1 && fromLast[0].name === '剧 第10集.mp4');

const audio = media.buildSeries(dir, 'ost.mp3', 'audio', settings);
check('点音频文件时只连播音频', audio.length === 1 && audio[0].name === 'ost.mp3', audio.map((e) => e.name).join(' | '));

const missing = media.buildSeries(dir, '不存在.mp4', 'video', settings);
check('当前文件不在列表里时退化为整个目录（不返回空）', missing.length === 3, String(missing.length));
check('空目录安全返回空数组', media.buildSeries([], 'x.mp4', 'video', settings).length === 0);
check('参数异常也不抛异常', media.buildSeries(null, 'x.mp4', 'video', settings).length === 0);

console.log('');
console.log(`结果: ${results.filter((r) => r.ok).length}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log('  失败: ' + r.name + (r.detail ? ' :: ' + r.detail : ''));
process.exit(failed ? 1 : 0);
