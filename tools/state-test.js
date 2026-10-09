'use strict';
// data/ 目录结构、旧文件搬迁、固定令牌、进度上限设置的离线测试（不需要网络 / mpv）。
// 用法：node tools/state-test.js

const fs = require('fs');
const path = require('path');
const { Store } = require('../server/store');

const ROOT = path.join(__dirname, '.statetest');
const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}
function reset() { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); }

// ---------- 目录结构 ----------
reset();
const s0 = new Store(ROOT, 'mpv.exe');
check('自动创建 state/ 目录', fs.existsSync(path.join(ROOT, 'state')));
check('自动创建 cache/ 目录', fs.existsSync(path.join(ROOT, 'cache')));
check('watch-later 目录路径在 cache/ 下',
  s0.watchLaterDir === path.join(ROOT, 'cache', 'watch-later'), s0.watchLaterDir);
s0.saveAlbums();
s0.saveSettings();
check('配置仍在 data 根目录（albums.json / settings.json）',
  fs.existsSync(path.join(ROOT, 'albums.json')) && fs.existsSync(path.join(ROOT, 'settings.json')));
check('配置没有被挪进 state/',
  !fs.existsSync(path.join(ROOT, 'state', 'albums.json')) && !fs.existsSync(path.join(ROOT, 'state', 'settings.json')));
check('不再产生自管的进度快照 recent.json', !fs.existsSync(path.join(ROOT, 'state', 'recent.json')));
check('进度相关的旧设置项已消失（改由 mpv 记账）',
  s0.settings.resumeMinSeconds === undefined && s0.settings.watchLaterMaxEntries === 200,
  `maxEntries=${s0.settings.watchLaterMaxEntries} maxDays=${s0.settings.watchLaterMaxDays}`);

// ---------- 旧进度快照搬迁（只搬不改，转换交给 index.js） ----------
reset();
const legacy = {
  albumId: 'alb_legacy', path: '/剧集/第03集.mp4', name: '第03集.mp4',
  pos: 733.5, dur: 1440, size: 123456, updatedAt: 1790000000000,
};
fs.writeFileSync(path.join(ROOT, 'last-played.json'), JSON.stringify(legacy, null, 2), 'utf8');
fs.writeFileSync(path.join(ROOT, 'last-played.json.bak'), '{"pos":1}', 'utf8');
const s1 = new Store(ROOT, 'mpv.exe');
const moved = s1.migrateLegacySnapshot();
check('旧快照被挪到 state/recent.json', fs.existsSync(path.join(ROOT, 'state', 'recent.json')));
check('搬迁后旧文件与旧 .bak 都已清走（根目录不留零散文件）',
  !fs.existsSync(path.join(ROOT, 'last-played.json')) && !fs.existsSync(path.join(ROOT, 'last-played.json.bak')));
check('旧 .bak 也保留下来了', fs.existsSync(path.join(ROOT, 'state', 'recent.json.bak')));
check('内容未被改动（原样搬运）',
  JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'recent.json'), 'utf8')).pos === 733.5);
check('返回已搬迁的文件列表', Array.isArray(moved) && moved.length >= 1);
const s2 = new Store(ROOT, 'mpv.exe');
check('再次启动不会重复搬迁或报错', s2.migrateLegacySnapshot().length === 0);

// 旧快照是坏的：搬迁不做解析，所以照搬不误，也不该崩
reset();
fs.writeFileSync(path.join(ROOT, 'last-played.json'), '{ 这不是合法 JSON', 'utf8');
let threw = null;
try { new Store(ROOT, 'mpv.exe').migrateLegacySnapshot(); } catch (err) { threw = err; }
check('旧快照损坏也不影响启动（原样搬到 state/）',
  !threw && fs.existsSync(path.join(ROOT, 'state', 'recent.json')), threw ? threw.message : '');

// ---------- 固定令牌 ----------
reset();
const a = new Store(ROOT, 'mpv.exe').getOrCreateInstance();
const b = new Store(ROOT, 'mpv.exe').getOrCreateInstance();
check('令牌是 32 位十六进制', /^[0-9a-f]{32}$/.test(a.streamToken || ''), a.streamToken);
check('重启后令牌不变（mpv 的进度键才稳定）', a.streamToken === b.streamToken);
check('令牌写在 state/instance.json', fs.existsSync(path.join(ROOT, 'state', 'instance.json')));
const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'instance.json'), 'utf8'));
check('落盘的令牌与内存一致', onDisk.streamToken === a.streamToken);

reset();
fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'state', 'instance.json'), '{ 坏掉的', 'utf8');
let c = null;
try { c = new Store(ROOT, 'mpv.exe').getOrCreateInstance(); } catch (err) { /* 记在下面 */ }
check('instance.json 损坏时能重新生成', !!c && /^[0-9a-f]{32}$/.test(c.streamToken || ''), c ? c.streamToken : '抛异常');

const d = new Store(ROOT, 'mpv.exe');
d.setLastPort(8787);
const inst = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'instance.json'), 'utf8'));
check('记录监听端口（供"换端口会让旧进度失联"提示用）', inst.lastPort === 8787, 'lastPort=' + inst.lastPort);
check('记录端口不会改掉令牌', inst.streamToken === c.streamToken);

// ---------- 进度上限设置 ----------
reset();
const e1 = new Store(ROOT, 'mpv.exe');
const st1 = e1.updateSettings({ watchLaterMaxEntries: 50, watchLaterMaxDays: 7 });
check('能设置进度上限', st1.watchLaterMaxEntries === 50 && st1.watchLaterMaxDays === 7);
const st2 = e1.updateSettings({ watchLaterMaxEntries: 0 });
check('0 表示不限制（允许）', st2.watchLaterMaxEntries === 0);
const st3 = e1.updateSettings({ watchLaterMaxEntries: 'abc', watchLaterMaxDays: -5 });
check('非法值不会破坏设置', st3.watchLaterMaxEntries === 0 && st3.watchLaterMaxDays === 7,
  `maxEntries=${st3.watchLaterMaxEntries} maxDays=${st3.watchLaterMaxDays}`);
const e2 = new Store(ROOT, 'mpv.exe');
check('设置已落盘并可读回', e2.settings.watchLaterMaxEntries === 0);

// ---------- data/ 只出现三类文件 ----------
reset();
const f = new Store(ROOT, 'mpv.exe');
f.saveAlbums(); f.saveSettings(); f.getOrCreateInstance();
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else files.push(path.relative(ROOT, p).replace(/\\/g, '/'));
  }
})(ROOT);
const allowed = files.every((x) => /^(albums|settings)\.json(\.bak)?$/.test(x)
  || /^state\/(instance|views|recent)\.json(\.bak|\.corrupt)?$/.test(x)
  || /^cache\//.test(x));
check('data 下只出现三类文件（配置 / state / cache）', allowed, files.join(', '));

fs.rmSync(ROOT, { recursive: true, force: true });

console.log('');
console.log(`结果: ${results.filter((r) => r.ok).length}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log('  失败: ' + r.name + (r.detail ? ' :: ' + r.detail : ''));
process.exit(failed ? 1 : 0);
