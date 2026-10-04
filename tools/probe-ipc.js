// Probe: how can we talk to mpv's IPC on this machine / in this sandbox?
// Usage: node tools/probe-ipc.js
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');

const MPV = path.join(__dirname, '..', 'mpv', 'mpv.exe');
const COMMON = ['--idle=yes', '--force-window=no', '--vo=null', '--ao=null'];

function tryConnect(endpoint, label, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const sock = net.connect(endpoint);
    let buf = '';
    const done = (ok, detail) => {
      try { sock.destroy(); } catch {}
      resolve({ label, ok, detail });
    };
    sock.on('connect', () => {
      sock.write(JSON.stringify({ command: ['get_property', 'mpv-version'], request_id: 1 }) + '\n');
    });
    sock.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\n')) done(true, buf.trim().split('\n')[0]);
    });
    sock.on('error', (e) => done(false, `${e.code || ''} ${e.message}`.trim()));
    sock.setTimeout(timeoutMs, () => done(false, 'timeout'));
  });
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function probeTcp() {
  const port = 6631;
  const child = spawn(MPV, [...COMMON, `--input-ipc-server=tcp://127.0.0.1:${port}`], {
    stdio: 'ignore', detached: false,
  });
  await wait(2500);
  const res = await tryConnect({ host: '127.0.0.1', port }, `tcp://127.0.0.1:${port}`);
  try { child.kill(); } catch {}
  return res;
}

async function probePipe() {
  const name = `mpvwebdav-probe-${process.pid}`;
  const pipePath = `\\\\.\\pipe\\${name}`;
  const child = spawn(MPV, [...COMMON, `--input-ipc-server=${pipePath}`], { stdio: 'ignore' });
  await wait(2500);
  const res = await tryConnect(pipePath, pipePath);
  try { child.kill(); } catch {}
  return res;
}

(async () => {
  const tcp = await probeTcp();
  console.log('TCP  =>', JSON.stringify(tcp));
  const pipe = await probePipe();
  console.log('PIPE =>', JSON.stringify(pipe));
})();
