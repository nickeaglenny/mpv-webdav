'use strict';
// 播放进度（mpv 的 watch-later）离线测试：不需要 mpv / 浏览器 / 网络。
// 用法：node tools/resume-test.js

const fs = require('fs');
const path = require('path');
const wl = require('../server/watchlater');

const WORK = path.join(__dirname, '.resumetest');
const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}
function reset() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
}

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const URL1 = `http://127.0.0.1:8787/stream/${TOKEN}/alb_x/%E5%89%A7%E9%9B%86/%E7%AC%AC01%E9%9B%86.mp4`;
const URL2 = `http://127.0.0.1:8787/stream/${TOKEN}/alb_x/%E5%89%A7%E9%9B%86/%E7%AC%AC02%E9%9B%86.mp4`;

// ---------- mpv 的键规则（文件名 = MD5(URL) 大写十六进制） ----------
check('keyFor 是 32 位大写十六进制', /^[0-9A-F]{32}$/.test(wl.keyFor(URL1)), wl.keyFor(URL1));
check('keyFor 与标准 MD5 一致（"hello" 的已知值）',
  wl.keyFor('hello') === '5D41402ABC4B2A76B9719D911017C592', wl.keyFor('hello'));
check('中文/百分号编码的地址也能稳定得到同一个键', wl.keyFor(URL1) === wl.keyFor(URL1));

// ---------- 读 / 写 / 删 ----------
reset();
check('没有条目时读出 null', wl.readEntry(WORK, URL1) === null);
wl.writeEntry(WORK, URL1, 733.5);
const e1 = wl.readEntry(WORK, URL1);
check('写入后能读出位置', !!e1 && Math.abs(e1.pos - 733.5) < 0.001, e1 ? String(e1.pos) : 'null');
check('文件名就是 MD5 键', fs.existsSync(path.join(WORK, wl.keyFor(URL1))));
check('条目内容含路径注释与 start=', (() => {
  const t = fs.readFileSync(path.join(WORK, wl.keyFor(URL1)), 'utf8');
  return t.includes('# ' + URL1) && /start=733\.5/.test(t);
})());
wl.removeEntry(WORK, URL1);
check('删除后读出 null', wl.readEntry(WORK, URL1) === null);

// 解析：目录条目（redirect entry）要忽略，start=0 视为没有进度
check('忽略 redirect 条目', wl.parseEntryText('# redirect entry\n') === null);
check('start=0 视为没有进度', wl.parseEntryText('# x\nstart=0.000000\n') === null);
check('损坏内容返回 null', wl.parseEntryText('乱七八糟') === null);

// ---------- 扫描：按更新时间倒序，且只看有进度的 ----------
reset();
wl.writeEntry(WORK, URL1, 10);
wl.writeEntry(WORK, URL2, 20);
fs.writeFileSync(path.join(WORK, 'DEADBEEFDEADBEEFDEADBEEFDEADBEEF'), '# redirect entry\n', 'utf8');
const now = Date.now();
fs.utimesSync(path.join(WORK, wl.keyFor(URL1)), new Date(now - 5000), new Date(now - 5000));
fs.utimesSync(path.join(WORK, wl.keyFor(URL2)), new Date(now - 1000), new Date(now - 1000));
const scanned = wl.scan(WORK);
check('扫描只返回有进度的条目', scanned.length === 2, String(scanned.length));
check('扫描按最近更新排在最前', scanned[0] && scanned[0].target === URL2, scanned[0] && scanned[0].target);
check('扫描结果带位置与时间', !!scanned[0] && scanned[0].pos === 20 && scanned[0].updatedAt > 0);

// ---------- 清理：条数上限 + 天数上限 ----------
reset();
for (let i = 1; i <= 5; i++) {
  const u = URL1.replace('%E7%AC%AC01%E9%9B%86', 'EP' + i);
  wl.writeEntry(WORK, u, i * 10);
  const t = new Date(now - (6 - i) * 24 * 3600 * 1000);   // i 越大越新
  fs.utimesSync(path.join(WORK, wl.keyFor(u)), t, t);
}
let pruned = wl.prune(WORK, { maxEntries: 3, maxAgeDays: 90 });
check('按条数上限清理（5 条 → 留 3 条）', wl.scan(WORK).length === 3, `removed=${pruned.removed}`);
check('留下的是最新那几条', (() => {
  const kept = wl.scan(WORK).map((e) => e.pos).sort((a, b) => a - b);
  return kept.join(',') === '30,40,50';
})(), wl.scan(WORK).map((e) => e.pos).join(','));
check('最新的一条没被删', !!wl.readEntry(WORK, URL1.replace('%E7%AC%AC01%E9%9B%86', 'EP5')));

reset();
wl.writeEntry(WORK, URL1, 100);
wl.writeEntry(WORK, URL2, 200);
const old = new Date(now - 200 * 24 * 3600 * 1000);
fs.utimesSync(path.join(WORK, wl.keyFor(URL1)), old, old);
pruned = wl.prune(WORK, { maxEntries: 100, maxAgeDays: 90 });
check('按天数上限清理（200 天前的删掉）', !wl.readEntry(WORK, URL1) && !!wl.readEntry(WORK, URL2), `removed=${pruned.removed}`);
check('maxAgeDays=0 表示不按天数清', (() => {
  const r = wl.prune(WORK, { maxEntries: 100, maxAgeDays: 0 });
  return r.removed === 0;
})());
check('空目录清理不报错', wl.prune(path.join(WORK, '不存在'), { maxEntries: 5, maxAgeDays: 5 }).removed === 0);

// ---------- 流地址 → 专辑/文件 ----------
const parsed = wl.parseStreamUrl(URL1, TOKEN);
check('能从流地址解析出专辑与文件', !!parsed && parsed.albumId === 'alb_x' && parsed.path === '/剧集/第01集.mp4',
  parsed ? `${parsed.albumId} ${parsed.path}` : 'null');
check('token 不匹配时不认（换过 token 的旧进度会自然失效）', wl.parseStreamUrl(URL1, 'ffff') === null);
check('非本应用的地址返回 null', wl.parseStreamUrl('https://example.com/foo.mp4', TOKEN) === null);
check('本地路径返回 null', wl.parseStreamUrl('G:\\movies\\a.mkv', TOKEN) === null);

// ---------- 旧快照 → mpv 条目（迁移） ----------
reset();
const migrated = wl.migrateLegacyRecord(WORK, URL1, 480.25);
check('旧进度能迁移成 mpv 条目', !!migrated && !migrated.skipped && !!wl.readEntry(WORK, URL1));
check('迁移后的位置正确', Math.abs((wl.readEntry(WORK, URL1) || {}).pos - 480.25) < 0.01);
check('已有 mpv 记录时不覆盖', (() => {
  const again = wl.migrateLegacyRecord(WORK, URL1, 999);
  return again && again.skipped === true && Math.abs(wl.readEntry(WORK, URL1).pos - 480.25) < 0.01;
})());
check('没有位置可迁移时返回 null', wl.migrateLegacyRecord(WORK, URL2, 0) === null);

// ---------- 显示 ----------
check('formatClock 短时长', wl.formatClock(754) === '12:34', wl.formatClock(754));
check('formatClock 超过一小时', wl.formatClock(3725) === '1:02:05', wl.formatClock(3725));
check('describe 输出「文件名 · 时间」', wl.describe({ pos: 754, target: URL1 }, '第01集.mp4') === '第01集.mp4 · 12:34',
  wl.describe({ pos: 754, target: URL1 }, '第01集.mp4'));

// ---------- 时长缓存与进度形状（列表里的进度条靠它） ----------
reset();
const DUR = path.join(WORK, 'durations.json');
check('时长缓存初始为空', Object.keys(wl.loadDurations(DUR)).length === 0);
wl.saveDurations(DUR, { AAA: { dur: 100, updatedAt: 1 }, BBB: { dur: 0, updatedAt: 2 } });
const durs = wl.loadDurations(DUR);
check('时长缓存能读回', durs.AAA && durs.AAA.dur === 100 && durs.BBB.dur === 0);

const pKnown = wl.progressFor({ pos: 50, updatedAt: 10 }, durs.AAA);
check('知道总时长时给出比例与百分比', !!pKnown && pKnown.ratio === 0.5 && pKnown.percent === 50, JSON.stringify(pKnown));
check('已看超过总时长时比例封顶 1', wl.progressFor({ pos: 200 }, { dur: 100 }).ratio === 1);
check('不知道总时长时不给假比例（ratio=null）',
  (() => { const p = wl.progressFor({ pos: 50 }, durs.BBB); return p && p.ratio === null && p.dur === null; })());
check('没有进度就没有进度对象', wl.progressFor(null, durs.AAA) === null && wl.progressFor({ pos: 0 }, durs.AAA) === null);

const durPruned = wl.pruneDurations(DUR, new Set(['AAA']));
const left = wl.loadDurations(DUR);
check('时长缓存跟着进度条目一起清理', durPruned.removed === 1 && !!left.AAA && !left.BBB, JSON.stringify(durPruned));

check('parseClock 解析 HH:MM:SS', wl.parseClock('00:20:35') === 1235, String(wl.parseClock('00:20:35')));
check('parseClock 解析 MM:SS', wl.parseClock('12:34') === 754, String(wl.parseClock('12:34')));
check('parseClock 解析带小数的秒', Math.abs(wl.parseClock('00:01:02.5') - 62.5) < 0.01);
check('parseClock 解析不了就返回 null', wl.parseClock('(error)') === null && wl.parseClock('') === null);

fs.rmSync(WORK, { recursive: true, force: true });
console.log('');
console.log(`结果: ${results.filter((r) => r.ok).length}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log('  失败: ' + r.name + (r.detail ? ' :: ' + r.detail : ''));
process.exit(failed ? 1 : 0);
