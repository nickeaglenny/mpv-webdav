'use strict';
// data/ 目录结构、旧文件迁移、固定令牌的离线测试（不需要网络 / mpv）。
// 用法：node tools/state-test.js

const fs = require('fs');
const path = require('path');
const os = require('os');
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
s0.saveAlbums();
s0.saveSettings();
check('配置仍在 data 根目录（albums.json）', fs.existsSync(path.join(ROOT, 'albums.json')));
check('配置仍在 data 根目录（settings.json）', fs.existsSync(path.join(ROOT, 'settings.json')));
check('配置没有被挪进 state/', !fs.existsSync(path.join(ROOT, 'state', 'albums.json'))
  && !fs.existsSync(path.join(ROOT, 'state', 'settings.json')));
check('进度不再写到 data 根目录', !fs.existsSync(path.join(ROOT, 'last-played.json')));

// ---------- 旧文件迁移 ----------
reset();
const legacy = {
  albumId: 'alb_legacy', path: '/剧集/第03集.mp4', name: '第03集.mp4',
  pos: 733.5, dur: 1440, size: 123456, mtime: '2026-10-01T00:00:00.000Z', updatedAt: 1790000000000,
};
fs.writeFileSync(path.join(ROOT, 'last-played.json'), JSON.stringify(legacy, null, 2), 'utf8');
fs.writeFileSync(path.join(ROOT, 'last-played.json.bak'), '{}', 'utf8');

const s1 = new Store(ROOT, 'mpv.exe');
check('旧进度被迁移到 state/recent.json', fs.existsSync(path.join(ROOT, 'state', 'recent.json')));
check('迁移后内容完整（位置/路径）',
  !!s1.getResume() && s1.getResume().pos === 733.5 && s1.getResume().path === '/剧集/第03集.mp4',
  JSON.stringify(s1.getResume()));
check('迁移后旧文件已删除（不留垃圾）', !fs.existsSync(path.join(ROOT, 'last-played.json')));
check('旧的 .bak 不删除，挪到 state/ 下保留',
  !fs.existsSync(path.join(ROOT, 'last-played.json.bak')) && fs.existsSync(path.join(ROOT, 'state', 'recent.json.bak')));

// 再启动一次不应出错，且不重复迁移
const s2 = new Store(ROOT, 'mpv.exe');
check('再次启动仍能读到迁移后的进度', !!s2.getResume() && s2.getResume().pos === 733.5);
check('再次启动不会再产生旧文件', !fs.existsSync(path.join(ROOT, 'last-played.json')));

// 旧文件损坏时不应影响启动，也不该每次启动都报警
reset();
fs.writeFileSync(path.join(ROOT, 'last-played.json'), '{ 这不是合法 JSON', 'utf8');
let threw = null;
try { new Store(ROOT, 'mpv.exe'); } catch (err) { threw = err; }
check('旧文件损坏时不影响启动', !threw, threw ? threw.message : '');
check('损坏的旧文件被挪进 state/（内容保留）',
  fs.existsSync(path.join(ROOT, 'state', 'recent.json.corrupt')) && !fs.existsSync(path.join(ROOT, 'last-played.json')));
check('损坏内容原样保留（没有丢数据）',
  fs.readFileSync(path.join(ROOT, 'state', 'recent.json.corrupt'), 'utf8').includes('这不是合法 JSON'));

// 旧文件是 null（没有进度）但 .bak 里还留着旧记录时：迁移后必须是"没有进度"，
// 绝不能从 .bak 里把一个已经失效的位置复活出来
reset();
fs.writeFileSync(path.join(ROOT, 'last-played.json'), 'null', 'utf8');
fs.writeFileSync(path.join(ROOT, 'last-played.json.bak'), JSON.stringify(legacy), 'utf8');
const sNull = new Store(ROOT, 'mpv.exe');
check('旧文件为 null 时不会被 .bak 复活进度', sNull.getResume() === null, JSON.stringify(sNull.getResume()));
check('旧文件为 null 时也会写下明确的"没有进度"',
  fs.existsSync(path.join(ROOT, 'state', 'recent.json')) && fs.readFileSync(path.join(ROOT, 'state', 'recent.json'), 'utf8').trim() === 'null');
check('旧 .bak 仍被保留（挪到 state/ 下）', fs.existsSync(path.join(ROOT, 'state', 'recent.json.bak')));

// ---------- 固定令牌 ----------
reset();
const a = new Store(ROOT, 'mpv.exe').getOrCreateInstance();
const b = new Store(ROOT, 'mpv.exe').getOrCreateInstance();
check('令牌是 32 位十六进制', /^[0-9a-f]{32}$/.test(a.streamToken || ''), a.streamToken);
check('重启后令牌不变（mpv 进度键才稳定）', a.streamToken === b.streamToken);
check('令牌写在 state/instance.json', fs.existsSync(path.join(ROOT, 'state', 'instance.json')));
const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'instance.json'), 'utf8'));
check('落盘的令牌与内存一致', onDisk.streamToken === a.streamToken);

// 损坏的 instance.json 应重新生成，而不是崩溃
reset();
fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'state', 'instance.json'), '{ 坏掉的', 'utf8');
let c = null;
try { c = new Store(ROOT, 'mpv.exe').getOrCreateInstance(); } catch (err) { /* 记在下面 */ }
check('instance.json 损坏时能重新生成', !!c && /^[0-9a-f]{32}$/.test(c.streamToken || ''), c ? c.streamToken : '抛异常');

// 端口记录
const d = new Store(ROOT, 'mpv.exe');
d.setLastPort(8787);
const inst = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'instance.json'), 'utf8'));
check('记录监听端口（供"换端口会让旧进度失联"提示用）', inst.lastPort === 8787, 'lastPort=' + inst.lastPort);
check('记录端口不会改掉令牌', inst.streamToken === c.streamToken);

// ---------- data/ 不会随使用增长（除缓存） ----------
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else files.push(path.relative(ROOT, p).replace(/\\/g, '/'));
  }
})(ROOT);
const allowed = files.every((f) => /^(albums|settings)\.json(\.bak)?$/.test(f)
  || /^state\/(recent|instance|views)\.json(\.bak|\.corrupt)?$/.test(f)
  || /^cache\//.test(f));
check('data 下只出现三类文件（配置 / state / cache）', allowed, files.join(', '));

fs.rmSync(ROOT, { recursive: true, force: true });

console.log('');
console.log(`结果: ${results.filter((r) => r.ok).length}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log('  失败: ' + r.name + (r.detail ? ' :: ' + r.detail : ''));
process.exit(failed ? 1 : 0);
