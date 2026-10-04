'use strict';
// 供 UI 测试脚本共用的小工具：找浏览器、等端口、发 HTTP、CDP 客户端。

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return process.env.CHROME_PATH || null;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

async function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(200);
  }
  return false;
}

async function httpJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null, text }; }
}

// 让操作系统挑一个空闲端口。测试实例绝不能去抢用户正在用的 8787，
// 否则测试请求会打到用户自己的实例上，污染他的专辑和设置。
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function startNode(script, args, env, logFile) {
  const fd = fs.openSync(logFile, 'a');
  return spawn(process.execPath, [script, ...args], {
    stdio: ['ignore', fd, fd],
    env: Object.assign({}, process.env, env || {}),
  });
}

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 1; this.pending = new Map(); this.handlers = []; }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve(true));
      ws.addEventListener('error', (e) => reject(new Error('CDP 连接失败: ' + (e.message || 'error'))));
      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
          return;
        }
        for (const h of this.handlers) h(msg);
      });
    });
  }

  onEvent(fn) { this.handlers.push(fn); }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
      }, 20000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面脚本异常: ' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result ? r.result.value : undefined;
  }

  async waitFor(expression, timeoutMs = 20000, label = expression) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
      try { if (await this.eval(expression)) return true; } catch (e) { lastErr = e; }
      await sleep(200);
    }
    throw new Error('等待超时: ' + label + (lastErr ? ' (' + lastErr.message + ')' : ''));
  }

  async center(expression) {
    return this.eval(`(function () {
      var n = ${expression};
      if (!n) return null;
      var r = n.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
  }

  // 真实鼠标事件（合成 MouseEvent 没有 clickCount/dblclick 语义）。
  // buttons 位掩码要和 Puppeteer 一样正确给出，否则部分版本不会当成正常点击。
  async realClick(x, y, clickCount = 1) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
  }

  async doubleClick(x, y) {
    await this.realClick(x, y, 1);
    await sleep(60);
    await this.realClick(x, y, 2);
  }

  async pressKey(key, code, vk) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }
}

function makeReporter() {
  const results = [];
  let failed = 0;
  return {
    check(name, ok, detail = '') {
      results.push({ name, ok, detail });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
      if (!ok) failed++;
    },
    summary() {
      console.log('');
      console.log(`结果: ${results.filter((r) => r.ok).length}/${results.length} 通过`);
      for (const x of results.filter((r) => !r.ok)) console.log('  失败: ' + x.name + (x.detail ? ' :: ' + x.detail : ''));
      return failed ? 1 : 0;
    },
    results,
  };
}

module.exports = { sleep, findBrowser, portOpen, waitForPort, getFreePort, httpJson, startNode, Cdp, makeReporter };
