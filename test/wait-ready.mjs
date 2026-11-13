/**
 * 等待现有 Edge 里插件启用 + B 站登录，然后自动配置 Agent 桥。
 * node test/wait-ready.mjs [cdpPort] [timeoutSec]
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.argv[2] || '9222';
const TIMEOUT = Number(process.argv[3] || 300) * 1000;
const EXT_ID = 'lbjaejphdjahdkajciiehbjoemabihke';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_FILE = join(ROOT, 'server', 'token.txt');
const TOKEN = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : '';
const BRIDGE = 'http://127.0.0.1:8765';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(method, path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  return res.json();
}

async function evalIn(wsUrl, expr) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (evt) => {
    const m = JSON.parse(evt.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ev = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 30000 });
  ws.close();
  return ev.result?.result?.value;
}

async function tryConfigure() {
  const list = await cdp('GET', '/json');
  const candidates = list.filter((t) => t.type === 'page' && (t.url || '').includes(`chrome-extension://${EXT_ID}/`));
  for (const t of candidates) {
    const href = await evalIn(t.webSocketDebuggerUrl, 'location.href').catch(() => '');
    if (!String(href).startsWith('chrome-extension://')) continue;
    const patch = { api: { enabled: true, url: 'ws://127.0.0.1:8765/ws', token: TOKEN } };
    const expr = `new Promise(function(res){ chrome.runtime.sendMessage(${JSON.stringify({ type: 'save-config', patch })}, function(r){ setTimeout(function(){ chrome.runtime.sendMessage({type:'api-status'}, function(s){ res({save:r&&{ok:r.ok,error:r.error}, status:s}); }); }, 2500); }); })`;
    const out = await evalIn(t.webSocketDebuggerUrl, expr).catch(() => null);
    if (out) return out;
  }
  // 没有可用的插件页：开一个 popup 标签（同一窗口，不是新窗口）
  const page = await cdp('PUT', `/json/new?chrome-extension://${EXT_ID}/popup/popup.html`);
  await sleep(1500);
  const href = await evalIn(page.webSocketDebuggerUrl, 'location.href').catch(() => '');
  if (!String(href).startsWith('chrome-extension://')) {
    await cdp('GET', `/json/close/${page.id}`).catch(() => {});
    return null;
  }
  const patch = { api: { enabled: true, url: 'ws://127.0.0.1:8765/ws', token: TOKEN } };
  const expr = `new Promise(function(res){ chrome.runtime.sendMessage(${JSON.stringify({ type: 'save-config', patch })}, function(r){ setTimeout(function(){ chrome.runtime.sendMessage({type:'api-status'}, function(s){ res({save:r&&{ok:r.ok,error:r.error}, status:s}); }); }, 2500); }); })`;
  const out = await evalIn(page.webSocketDebuggerUrl, expr).catch(() => null);
  await cdp('GET', `/json/close/${page.id}`).catch(() => {});
  return out;
}

async function loginState() {
  try {
    const r = await fetch(`${BRIDGE}/v1/state`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!r.ok) return null;
    const d = await r.json();
    return d.login || null;
  } catch {
    return null;
  }
}

const start = Date.now();
let configured = false;
let lastNote = '';
while (Date.now() - start < TIMEOUT) {
  if (!configured) {
    const out = await tryConfigure().catch(() => null);
    if (out?.status?.connected) {
      configured = true;
      console.log('AGENT_BRIDGE_CONNECTED');
    } else if (out) {
      if (out.status?.lastError && out.status.lastError !== lastNote) {
        lastNote = out.status.lastError;
        console.log('bridge status:', out.status.lastError);
      }
    } else if (lastNote !== 'waiting-extension') {
      lastNote = 'waiting-extension';
      console.log('等待插件启用（edge://extensions 里启用「B站自动聊天」）…');
    }
  }
  if (configured) {
    const login = await loginState();
    if (login) {
      console.log('LOGIN_OK', JSON.stringify(login));
      process.exit(0);
    }
    if (lastNote !== 'waiting-login') {
      lastNote = 'waiting-login';
      console.log('等待 B 站登录（请在同一个 Edge 窗口扫码登录）…');
    }
  }
  await sleep(5000);
}
console.log('TIMEOUT');
process.exit(1);
