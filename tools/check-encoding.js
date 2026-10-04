'use strict';
// 直接对 WebDAV 上的字幕文件做编码体检：告诉你是 UTF-8 还是 GBK/BIG5，
// 以及转成 UTF-8 后的前几行长什么样。
//
// 用法：
//   node tools/check-encoding.js --url https://nas.example.com:5006/dav --user <用户名> --pass <密码> \
//        --path "/影视/电影/xxx.ass"

const path = require('path');
const { WebDAVClient } = require('../server/webdav');
const { detectAndDecode } = require('../server/text-encoding');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i === -1 ? def : argv[i + 1];
}

const URL_ARG = arg('url');
const TARGET = arg('path');
if (!URL_ARG || !TARGET) {
  console.error('用法: node tools/check-encoding.js --url <WebDAV 根地址> --user <用户> --pass <密码> --path <字幕文件路径>');
  process.exit(2);
}

(async () => {
  const album = {
    id: 'probe', name: 'probe', type: 'webdav', url: URL_ARG, root: '/',
    username: arg('user', ''), password: arg('pass', ''), auth: arg('auth', 'basic'),
    verifyTLS: arg('insecure', '') === '1' ? false : true,
  };
  const client = new WebDAVClient(album);
  const rel = TARGET.startsWith('/') ? TARGET : '/' + TARGET;

  const res = await client.open(rel, { method: 'GET' });
  const chunks = [];
  for await (const c of res.stream) chunks.push(c);
  const buf = Buffer.concat(chunks);

  const { encoding, text, bom } = detectAndDecode(buf);
  console.log(`文件      : ${path.basename(rel)}`);
  console.log(`大小      : ${buf.length} 字节`);
  console.log(`原始字节  : ${buf.subarray(0, 24).toString('hex').replace(/(..)/g, '$1 ').trim()}`);
  console.log(`BOM       : ${bom ? '有' : '无'}`);
  console.log(`检测编码  : ${encoding}`);
  console.log(`是否为乱码风险: ${encoding === 'utf-8' ? '否（mpv 能直接正确显示）' : '是 → 需要转成 UTF-8'}`);
  console.log('');
  console.log('—— 转成 UTF-8 后的前 8 行 ——');
  console.log(text.split(/\r?\n/).slice(0, 8).join('\n'));
})();
