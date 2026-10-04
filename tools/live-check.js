'use strict';
// 对着真实 WebDAV 服务跑一遍全流程：建专辑 → 测连接 → 逐级浏览 → 播放并检查 mpv 实际加载的轨道/字幕。
//
// 用法：
//   node tools/live-check.js --url https://nas.example.com:5006/dav --user <用户名> --pass <密码> \
//        [--path "/影视/电影/示例影片.2022/01.mp4"] [--seconds 8] [--headless]
//
// --headless（默认开）时给 mpv 加 --vo=null --ao=null --length=N，不会弹窗、不出声。

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(__dirname, '.live');
const APP_PORT = 8791;

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i === -1 ? def : argv[i + 1];
}
const URL_ARG = arg('url');
const USER = arg('user', '');
const PASS = arg('pass', '');
const TARGET = arg('path', '');
const SECONDS = parseInt(arg('seconds', '8'), 10);
const HEADLESS = argv.includes('--no-headless') ? false : true;
const AUTH = arg('auth', 'basic');
const SUB_DIRS = arg('subdirs', '');
const SCAN = argv.includes('--scan');
const SCAN_DEPTH = parseInt(arg('depth', '3'), 10);

if (!URL_ARG) {
  console.error('缺少 --url，例如：node tools/live-check.js --url https://nas.example.com:5006/dav --user <用户名> --pass <密码>');
  process.exit(2);
}

const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

async function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(200);
  }
  return false;
}

async function api(method, url, body) {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

// 在某个目录里按名字找子项（兼容同名/编码差异）
async function findEntry(albumId, dirPath, name) {
  const r = await api('GET', `/api/browse?albumId=${albumId}&path=${encodeURIComponent(dirPath)}`);
  if (r.status !== 200) return { error: r.json ? r.json.error : r.text, entries: [] };
  const entries = (r.json && r.json.entries) || [];
  const hit = entries.find((e) => e.name === name) || entries.find((e) => e.name.toLowerCase() === String(name).toLowerCase());
  return { entry: hit, entries };
}

// 广度优先扫描，找出「同一目录里既有视频又有外挂字幕」的文件夹
async function scanForSubtitles(albumId, start, maxDepth, budget = 400) {
  const found = [];
  let visited = 0;
  const queue = [{ path: start, depth: 0 }];
  while (queue.length && visited < budget) {
    const { path: dir, depth } = queue.shift();
    visited++;
    const r = await api('GET', `/api/browse?albumId=${albumId}&path=${encodeURIComponent(dir)}`);
    if (r.status !== 200) continue;
    const entries = (r.json && r.json.entries) || [];
    const subs = entries.filter((e) => e.kind === 'subtitle');
    const vids = entries.filter((e) => e.kind === 'video');
    if (subs.length && vids.length) found.push({ dir, subs, vids });
    if (depth + 1 <= maxDepth) {
      for (const e of entries) {
        if (e.isDir) queue.push({ path: e.path, depth: depth + 1 });
      }
    }
  }
  return { found, visited };
}

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const appLog = path.join(WORK, 'app.log');
  const mpvLog = path.join(WORK, 'mpv.log');

  const app = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    stdio: ['ignore', fs.openSync(appLog, 'a'), fs.openSync(appLog, 'a')],
    env: Object.assign({}, process.env, {
      MPV_WEBDAV_PORT: String(APP_PORT),
      MPV_WEBDAV_DATA: path.join(WORK, 'data'),
    }),
  });
  const cleanup = () => { try { app.kill(); } catch {} };
  process.on('exit', cleanup);

  try {
    check('本地应用已启动', await waitForPort(APP_PORT));

    // 服务端地址连通性
    const host = new URL(URL_ARG).hostname;
    const port = Number(new URL(URL_ARG).port || (/^https/.test(URL_ARG) ? 443 : 80));
    const reachable = await waitForPort(port, 6000);
    check(`WebDAV 服务器 ${host}:${port} 可连通`, reachable);

    await api('PUT', '/api/settings', {
      extraMpvArgs: HEADLESS
        ? ['--vo=null', '--ao=null', '--force-window=no', `--length=${SECONDS}`,
           '--msg-level=all=info', '--log-file=' + mpvLog]
        : ['--msg-level=all=info', '--log-file=' + mpvLog],
      ...(SUB_DIRS ? { subDirs: SUB_DIRS.split(',') } : {}),
    });

    // 1) 建专辑 + 测连接
    let r = await api('POST', '/api/albums', {
      name: '联调专辑', type: 'webdav', url: URL_ARG, root: '/',
      username: USER, password: PASS, auth: AUTH, verifyTLS: false,
    });
    const album = r.json && r.json.album;
    check('创建专辑', !!album, r.text.slice(0, 160));
    if (!album) throw new Error('专辑创建失败');

    r = await api('POST', '/api/albums/test', {
      id: album.id, url: URL_ARG, root: '/', username: USER, password: PASS, auth: AUTH, verifyTLS: false,
    });
    check('测试连接', !!(r.json && r.json.ok), r.json ? `${r.json.message}（${r.json.elapsedMs} ms）` : r.text);

    // 2) 浏览根目录
    r = await api('GET', `/api/browse?albumId=${album.id}&path=/`);
    let entries = (r.json && r.json.entries) || [];
    check('浏览根目录', r.status === 200 && entries.length > 0,
      entries.slice(0, 12).map((e) => (e.isDir ? '📁' : '📄') + e.name).join('  '));
    if (r.status !== 200) throw new Error((r.json && r.json.error) || r.text);

    // 2.5) 扫描带外挂字幕的目录
    if (SCAN) {
      const t0 = Date.now();
      const { found, visited } = await scanForSubtitles(album.id, arg('path', '/'), SCAN_DEPTH);
      console.log(`\n      扫了 ${visited} 个目录，找到 ${found.length} 个「视频+外挂字幕」目录（${Date.now() - t0} ms）：`);
      for (const f of found.slice(0, 10)) {
        console.log(`        📁 ${f.dir}`);
        console.log(`           字幕: ${f.subs.map((s) => s.name).join(' | ')}`);
        console.log(`           视频: ${f.vids.slice(0, 3).map((v) => v.name + (v.subtitleCount ? `(匹配${v.subtitleCount})` : '')).join(' | ')}` +
          (f.vids.length > 3 ? ` … 共 ${f.vids.length} 个` : ''));
      }
      if (found.length) {
        const pick = found.find((f) => f.vids.some((v) => v.subtitleCount > 0)) || found[0];
        const video = pick.vids.find((v) => v.subtitleCount > 0) || pick.vids[0];
        console.log(`\n      用真实文件验证字幕自动挂载：${video.path}`);
        const p = await api('POST', '/api/play', { albumId: album.id, path: video.path, mode: 'replace', loadSubs: true });
        const subs = (p.json && p.json.subtitles) || [];
        check('真实服务器上发现并下发了外挂字幕', subs.length > 0, subs.join(' | '));
        await sleep(6000);
        const log = fs.existsSync(mpvLog) ? fs.readFileSync(mpvLog, 'utf8') : '';
        const subLines = [...log.matchAll(/[●○]\s*Subs\s+--sid=\d+[^\n]*/g)].map((m) => m[0].trim());
        check('mpv 实际挂载了这些字幕', subLines.length > 0, `${subLines.length} 条`);
        for (const l of subLines) console.log('        ' + l);
        await api('POST', '/api/player', { action: 'stop' });
      } else {
        check('扫描到可验证的外挂字幕', false, '这棵树里没找到和外挂字幕同目录的视频');
      }
      console.log('');
      return; // 扫描模式到此为止
    }

    // 3) 逐级进入目标路径
    let current = '/';
    if (TARGET) {
      const segs = TARGET.split('/').filter(Boolean);
      const leaf = segs.pop();
      for (const seg of segs) {
        const { entry, entries: list, error } = await findEntry(album.id, current, seg);
        if (error) { check(`进入 ${seg}`, false, error); break; }
        if (!entry) {
          check(`进入 ${seg}`, false, '找不到该目录；当前目录有：' + list.map((e) => e.name).join(' / '));
          break;
        }
        current = entry.path;
        console.log(`      → ${entry.name}  (${entry.path})`);
      }

      // 列出视频所在目录
      const { entry: video, entries: list, error } = await findEntry(album.id, current, leaf);
      check(`定位目标文件 ${leaf}`, !!(video && !error), error || (video ? `kind=${video.kind} size=${video.size} 字幕角标=${video.subtitleCount}` : '未找到'));
      console.log('      目录内容：');
      for (const e of list) {
        console.log(`        ${e.isDir ? '📁' : '🎬'} ${e.name}` +
          (e.isDir ? '' : `  ${(e.size / 1048576).toFixed(1)} MB  [${e.kind}]` +
            (e.kind === 'subtitle' ? '' : (e.subtitleCount ? `  字幕×${e.subtitleCount}` : ''))));
      }

      // 4) 播放
      if (video && !video.isDir) {
        const t0 = Date.now();
        r = await api('POST', '/api/play', { albumId: album.id, path: video.path, mode: 'replace', loadSubs: true });
        check('发起播放', r.status === 200 && !!(r.json && r.json.ok), r.text.slice(0, 200));
        if (r.json && r.json.ok) {
          console.log('      发现字幕：' + (r.json.subtitles.length ? r.json.subtitles.join(' | ') : '（无）'));
          const player = r.json.player;
          console.log(`      播放通道：${player.mode}（${player.mode === 'ipc' ? '命名管道 IPC' : '回退模式'}）`);

          // 4.5) 字幕编码体检：看看经代理拿到的字幕是不是干净的 UTF-8
          if (argv.includes('--check-subs') && r.json.subtitles.length) {
            const st = await api('GET', '/api/state');
            const token = st.json && st.json.streamToken;
            const dirRes = await api('GET', `/api/browse?albumId=${album.id}&path=${encodeURIComponent(current)}`);
            const byName = new Map(((dirRes.json && dirRes.json.entries) || []).map((e) => [e.name, e.path]));
            for (const name of r.json.subtitles) {
              const rel = byName.get(name);
              if (!rel) { check(`字幕 ${name} 能找到路径`, false); continue; }
              const u = `http://127.0.0.1:${APP_PORT}/stream/${token}/${album.id}${encodeURI(rel)}`;
              const sres = await fetch(u);
              const bytes = Buffer.from(await sres.arrayBuffer());
              let text = null;
              try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* 不是合法 UTF-8 */ }
              check(`字幕 ${name} 经代理后是合法 UTF-8（不会显示乱码）`, text !== null,
                text !== null ? `${bytes.length} 字节，${sres.headers.get('content-type')}` : '仍是原始编码（会乱码）');
              if (text) {
                const preview = text.split(/\r?\n/)
                  .map((l) => l.trim())
                  .find((l) => l && !/^\d+$/.test(l) && !l.includes('-->') && !l.startsWith('[') && !/^Dialogue:/i.test(l) && !l.startsWith('Format:') && !l.startsWith('Style:'));
                if (preview) console.log('        内容预览: ' + preview.slice(0, 70));
              }
            }
          }

          const need = HEADLESS ? SECONDS + 6 : 12;
          console.log(`      等待 mpv 播放 ${need}s…`);
          await sleep(need * 1000);

          const log = fs.existsSync(mpvLog) ? fs.readFileSync(mpvLog, 'utf8') : '';
          check('mpv 已启动并写出日志', log.length > 0, `${log.length} 字节`);
          check('mpv 打开了流代理地址', /Opening done:|Opening http/.test(log));
          const vTrack = /●?\s*Video\s+--vid=1([^\n]*)/.exec(log);
          check('mpv 解码了视频轨', !!vTrack, vTrack ? vTrack[1].trim().slice(0, 90) : '');
          const aTrack = /●?\s*Audio\s+--aid=1([^\n]*)/.exec(log);
          check('mpv 解码了音频轨', !!aTrack, aTrack ? aTrack[1].trim().slice(0, 90) : '');
          const subLines = [...log.matchAll(/[●○]\s*Subs\s+--sid=\d+[^\n]*/g)].map((m) => m[0].trim());
          const selected = subLines.filter((l) => l.startsWith('●'));
          check('mpv 挂载了外挂字幕轨', subLines.length > 0, subLines.length ? `共 ${subLines.length} 条，已选中 ${selected.length} 条` : '未加载任何字幕');
          for (const l of subLines) console.log('        ' + l);
          const errs = [...log.matchAll(/\[e\].*$/gm)].map((m) => m[0].trim()).slice(0, 4);
          if (errs.length) console.log('      mpv 报错行：\n        ' + errs.join('\n        '));

          r = await api('GET', '/api/player');
          console.log(`      player: running=${r.json.player.running} idle=${r.json.player.idle} pos=${r.json.player.position} ` +
            `subtitleTracks=${r.json.player.subtitleTracks}`);
          check('播放过程中状态正常（无错误）', !r.json.player.error, r.json.player.error || '');
          await api('POST', '/api/player', { action: 'stop' });
        }
      }
    }
  } catch (err) {
    check('联调未抛出异常', false, err.stack || String(err));
  } finally {
    cleanup();
    await sleep(400);
  }

  console.log('');
  console.log(`结果: ${results.filter((x) => x.ok).length}/${results.length} 通过`);
  for (const x of results.filter((y) => !y.ok)) console.log('  失败: ' + x.name + (x.detail ? ' :: ' + x.detail : ''));
  console.log('日志: ' + WORK);
  process.exit(failed ? 1 : 0);
})();
