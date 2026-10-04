'use strict';
// 验证专辑配置的「写前备份 + 损坏/丢失自动恢复」。
// 只在 tools/.storetest 里操作，绝不碰 data/。
//
// 用法：node tools/store-test.js

const fs = require('fs');
const path = require('path');
const { Store } = require('../server/store');

const WORK = path.join(__dirname, '.storetest');
const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

const albumsFile = path.join(WORK, 'albums.json');
const bakFile = albumsFile + '.bak';

// 1) 首次保存：写入主文件，不产生 .bak
const s1 = new Store(WORK, 'mpv.exe');
s1.createAlbum({ name: '演示专辑', url: 'https://nas.example.com:5006/dav', username: 'demo', password: 'demo-pass', auth: 'basic' });
check('首次保存写出 albums.json', fs.existsSync(albumsFile));
check('首次保存不会无中生有 .bak', !fs.existsSync(bakFile));

// 2) 再次保存（改名）：产生 .bak，内容是上一次的版本
const id = s1.albums[0].id;
s1.updateAlbum(id, { name: '演示专辑（改名）', url: 'https://nas.example.com:5006/dav', username: 'demo', password: '', auth: 'basic' });
check('覆盖保存前生成 .bak', fs.existsSync(bakFile));
const bakContent = JSON.parse(fs.readFileSync(bakFile, 'utf8'));
check('.bak 保存的是上一版内容', bakContent[0] && bakContent[0].name === '演示专辑', bakContent[0] && bakContent[0].name);

// 3) albums.json 被误删 → 下次启动从 .bak 恢复
fs.rmSync(albumsFile, { force: true });
const s2 = new Store(WORK, 'mpv.exe');
check('主文件被删后能从 .bak 恢复', s2.listAlbums().length === 1, `专辑数=${s2.listAlbums().length}`);
check('恢复后主文件已重建', fs.existsSync(albumsFile));

// 4) albums.json 被写坏 → 同样从 .bak 恢复（保留上一版，密码也跟着回来）
fs.writeFileSync(albumsFile, '{ 这不是合法 JSON', 'utf8');
const s3 = new Store(WORK, 'mpv.exe');
const restored = s3.listAlbums()[0];
check('主文件损坏后能从 .bak 恢复', s3.listAlbums().length === 1, `专辑数=${s3.listAlbums().length}`);
check('恢复出来的专辑密码完整', !!restored && restored.hasPassword === true && s3.albums[0].password === 'demo-pass');

// 5) 备份失败也不能影响保存（用一个不可写的备份路径模拟不了，这里只验证多次保存后仍是合法 JSON）
for (let i = 0; i < 5; i++) {
  s3.updateAlbum(s3.albums[0].id, { name: '演示专辑 v' + i, url: 'https://nas.example.com:5006/dav', username: 'demo', password: '', auth: 'basic' });
}
check('连续保存后主文件仍是合法 JSON', (() => {
  try { return JSON.parse(fs.readFileSync(albumsFile, 'utf8'))[0].name === '演示专辑 v4'; } catch { return false; }
})());

fs.rmSync(WORK, { recursive: true, force: true });

console.log('');
console.log(`结果: ${results.filter((r) => r.ok).length}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log('  失败: ' + r.name + (r.detail ? ' :: ' + r.detail : ''));
process.exit(failed ? 1 : 0);
