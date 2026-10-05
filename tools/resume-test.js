'use strict';
// 「只记最近一次」播放进度的离线单元测试（不需要 mpv / 浏览器 / 网络）。
// 用法：node tools/resume-test.js

const fs = require('fs');
const path = require('path');
const resume = require('../server/resume');
const { Store } = require('../server/store');

const WORK = path.join(__dirname, '.resumetest');
const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}

// ---------- 阈值判定 ----------
const rules = { resumeMinSeconds: 30, resumeMinPercent: 5, resumeEndGuardSeconds: 60 };

check('刚开播（10 秒 / 2700 秒）→ 不记',
  resume.decide(10, 2700, rules) === 'clear', resume.decide(10, 2700, rules));
check('看到 20%（540 秒）→ 记',
  resume.decide(540, 2700, rules) === 'remember', resume.decide(540, 2700, rules));
check('短视频只看 40 秒但已达 5%（800 秒的 5% = 40）→ 记',
  resume.decide(45, 800, rules) === 'remember', resume.decide(45, 800, rules));
check('距结尾不足 60 秒（2650 / 2700）→ 视为看完，清掉',
  resume.decide(2650, 2700, rules) === 'clear', resume.decide(2650, 2700, rules));
check('恰好停在结尾保护线之前（2600 / 2700）→ 记',
  resume.decide(2600, 2700, rules) === 'remember', resume.decide(2600, 2700, rules));
check('时长未知 → 不动',
  resume.decide(500, 0, rules) === 'skip', resume.decide(500, 0, rules));
check('位置为 0 → 不动',
  resume.decide(0, 2700, rules) === 'skip', resume.decide(0, 2700, rules));
check('可配置阈值生效（minSeconds=600）',
  resume.decide(300, 2700, { resumeMinSeconds: 600, resumeMinPercent: 5, resumeEndGuardSeconds: 60 }) === 'clear');

// ---------- 记录构造 / 匹配 ----------
const rec = resume.buildRecord({
  albumId: 'alb_x', path: '/影视/电影/01.mp4', name: '01.mp4',
  pos: 754.26, dur: 2700.4, size: 647468265, mtime: '2026-06-21T23:30:00Z',
}, 1780000000000);
check('buildRecord 保留关键字段', rec.albumId === 'alb_x' && rec.pos === 754.3 && rec.dur === 2700.4, JSON.stringify(rec));
check('describe 输出「文件名 · 时间」', resume.describe(rec) === '01.mp4 · 12:34', resume.describe(rec));

check('同一个文件（size/mtime 一致）→ 匹配',
  resume.matches(rec, { albumId: 'alb_x', path: '/影视/电影/01.mp4', size: 647468265, mtime: '2026-06-21T23:30:00Z' }) === true);
check('文件被替换（size 不同）→ 不匹配',
  resume.matches(rec, { albumId: 'alb_x', path: '/影视/电影/01.mp4', size: 111 }) === false);
check('mtime 变了 → 不匹配',
  resume.matches(rec, { albumId: 'alb_x', path: '/影视/电影/01.mp4', mtime: '2027-01-01T00:00:00Z' }) === false);
check('另一个专辑的同名路径 → 不匹配',
  resume.matches(rec, { albumId: 'alb_y', path: '/影视/电影/01.mp4' }) === false);
check('前端没带 size/mtime 时只比对专辑+路径 → 匹配',
  resume.matches(rec, { albumId: 'alb_x', path: '/影视/电影/01.mp4' }) === true);

// ---------- Store 落盘 / 恢复 / 清除（复用原子写 + 备份） ----------
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

const s1 = new Store(WORK, 'mpv.exe');
check('初始没有续播记录', s1.getResume() === null);
s1.setResume(rec);
check('写入后生成 last-played.json', fs.existsSync(path.join(WORK, 'last-played.json')));
const size1 = fs.statSync(path.join(WORK, 'last-played.json')).size;
check('记录体积很小（< 400 字节）', size1 < 400, size1 + ' 字节');

const s2 = new Store(WORK, 'mpv.exe');
check('重启后能读回记录', !!s2.getResume() && s2.getResume().pos === 754.3 && s2.getResume().path === '/影视/电影/01.mp4');

// 覆盖写入应产生备份（复用 store 的写前备份机制）
const rec2 = Object.assign({}, rec, { pos: 800, updatedAt: 1780000001000 });
s2.setResume(rec2);
check('覆盖写入产生 .bak', fs.existsSync(path.join(WORK, 'last-played.json.bak')));
check('文件恒定只有一处记录（不随观看次数增长）',
  (() => { const j = JSON.parse(fs.readFileSync(path.join(WORK, 'last-played.json'), 'utf8')); return !Array.isArray(j) && j.pos === 800; })());

s2.clearResume();
check('清除后记录为 null', s2.getResume() === null);
const s3 = new Store(WORK, 'mpv.exe');
check('重启后依然是 null（清除已落盘）', s3.getResume() === null);

// 损坏恢复：主文件写坏时应能从 .bak 恢复
fs.writeFileSync(path.join(WORK, 'last-played.json'), '{ 坏掉的 JSON', 'utf8');
const s4 = new Store(WORK, 'mpv.exe');
check('记录文件损坏时能从 .bak 恢复', !!s4.getResume(), JSON.stringify(s4.getResume()));

fs.rmSync(WORK, { recursive: true, force: true });

console.log('');
console.log(`结果: ${results.filter((r) => r.ok).length}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log('  失败: ' + r.name + (r.detail ? ' :: ' + r.detail : ''));
process.exit(failed ? 1 : 0);
