/**
 * 通过 CDP 在扩展页面里调用后台接口，用于重载/探活/手动发送。
 * 用法：
 *   node test/cdp-agent.mjs ping
 *   node test/cdp-agent.mjs reload
 *   node test/cdp-agent.mjs state
 *   node test/cdp-agent.mjs scan
 *   node test/cdp-agent.mjs task
 *   node test/cdp-agent.mjs retry <outboxId>
 *   node test/cdp-agent.mjs confirm <outboxId> [text]
 *   node test/cdp-agent.mjs eval "<expression>"
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_ID = 'lbjaejphdjahdkajciiehbjoemabihke';
const PORT = process.env.CDP_PORT || '9222';
const action = process.argv[2] || 'ping';
const arg1 = process.argv[3] || '';
const arg2 = process.argv[4] || '';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_TOKEN_FILE = join(ROOT, 'server', 'token.txt');
const BRIDGE_TOKEN = existsSync(BRIDGE_TOKEN_FILE) ? readFileSync(BRIDGE_TOKEN_FILE, 'utf8').trim() : '';

let openedByUs = false;

async function evalHref(wsUrl) {
  try {
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
    const ev = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
    ws.close();
    return ev.result?.result?.value || '';
  } catch {
    return '';
  }
}

async function findOrOpenPage() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  // 优先复用已经打开且地址有效的插件面板；不关闭用户界面
  for (const t of targets) {
    if (t.type !== 'page' || !t.url?.includes(`chrome-extension://${EXT_ID}/`)) continue;
    const href = await evalHref(t.webSocketDebuggerUrl);
    if (href.startsWith('chrome-extension://')) return t;
  }
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${EXT_ID}/popup/popup.html`, { method: 'PUT' });
  const page = await res.json();
  openedByUs = true;
  await new Promise((r) => setTimeout(r, 1500));
  return page;
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve({ ws, send }));
    ws.addEventListener('error', reject);
  });
}

function exprFor(a) {
  const call = (msg, timeout = 40000) => `(function(){return new Promise(function(resolve){
    chrome.runtime.sendMessage(${JSON.stringify(msg)}, function(resp){
      if (chrome.runtime.lastError) { resolve({error: chrome.runtime.lastError.message}); return; }
      resolve(resp);
    });
    setTimeout(function(){resolve({error:'timeout'});}, ${timeout});
  });})()`;

  if (a === 'ping') return call({ type: 'ping' }, 5000);
  if (a === 'reload') return `(function(){ chrome.runtime.reload(); return {ok:true}; })()`;
  if (a === 'state') return call({ type: 'get-state', includeSecrets: true }, 30000);
  if (a === 'scan') return call({ type: 'scan-now' }, 10000);
  if (a === 'task') return call({ type: 'get-task' }, 5000);
  if (a === 'retry') return call({ type: 'outbox-retry', id: arg1 }, 50000);
  if (a === 'confirm') return call({ type: 'outbox-confirm', id: arg1, text: arg2 || undefined }, 50000);
  if (a === 'api-status') return call({ type: 'api-status' }, 5000);
  if (a === 'enable-api') {
    const patch = { api: { enabled: true, url: 'ws://127.0.0.1:8765/ws', token: BRIDGE_TOKEN } };
    return `(function(){return new Promise(function(resolve){
      chrome.runtime.sendMessage(${JSON.stringify({ type: 'save-config', patch })}, function(save){
        setTimeout(function(){
          chrome.runtime.sendMessage({type:'api-status'}, function(status){
            resolve({ save: save && {ok:save.ok, error:save.error}, status });
          });
        }, 2500);
      });
    });})()`;
  }
  if (a === 'eval') return arg1;
  return call({ type: 'ping' }, 5000);
}

const page = await findOrOpenPage();
const { ws, send } = await connect(page.webSocketDebuggerUrl);
await send('Runtime.enable');
const ev = await send('Runtime.evaluate', {
  expression: exprFor(action),
  returnByValue: true,
  awaitPromise: true,
  timeout: 60000,
});
const val = ev.result?.result?.value ?? ev.result?.exceptionDetails ?? ev.result;
if (openedByUs) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/close/${page.id}`); } catch { /* ignore */ }
}
if (action === 'state' && val && !val.error) {
  const cfg = val.config || {};
  console.log(JSON.stringify({
    login: val.login,
    mode: cfg.mode,
    enabled: cfg.enabled,
    ai: { baseUrl: cfg.ai?.baseUrl, model: cfg.ai?.model, maxTokens: cfg.ai?.maxTokens },
    limits: cfg.limits,
    api: cfg.api ? { enabled: cfg.api.enabled, url: cfg.api.url, token: cfg.api.token ? '***' : '' } : null,
    apiStatus: val.apiStatus,
    circuit: val.circuit,
    stats: val.stats,
    outbox: (val.outbox || []).map((o) => ({
      id: o.id, status: o.status, kind: o.kind, oid: o.oid, replyType: o.replyType,
      root: o.root, parent: o.parent, text: o.text, error: o.error,
    })),
    logs: (val.logs || []).slice(-8).map((l) => `${l.level} ${l.msg} ${l.detail || ''}`),
  }, null, 2));
} else {
  console.log(JSON.stringify(val, null, 2));
}
ws.close();
