/**
 * 第三方 Agent 通道：扩展主动连接本地桥接服务（WebSocket）。
 * 桥接服务 → 扩展：{id, action, payload}
 * 扩展 → 桥接服务：{id, ok, result} / {id, ok:false, error}
 * 20s 一次的 ping/pong 同时用于 SW 保活。
 */
import { getConfig } from './config.js';
import { addLog } from './store.js';

let ws = null;
let connected = false;
let lastError = '';
let lastUrl = '';
let lastConnectedAt = 0;
let reconnectTimer = null;
let handleMsgRef = null;
let generation = 0;

export function getBridgeStatus() {
  return {
    connected,
    url: lastUrl,
    lastError,
    lastConnectedAt,
    readyState: ws?.readyState ?? -1,
  };
}

export async function startBridge(handleMsg) {
  handleMsgRef = handleMsg;
  generation += 1;
  const gen = generation;
  clearTimeout(reconnectTimer);
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
  connected = false;

  const config = await getConfig();
  const api = config.api || {};
  lastUrl = api.url || '';
  if (!api.enabled) {
    lastError = '';
    return;
  }
  if (!api.token) {
    lastError = '缺少 token';
    await addLog('warn', 'Agent 接口未配置 token', '请在设置页填写与桥接服务一致的 token');
    return;
  }
  connect(api.url, api.token, gen);
}

/** 定时唤醒用：只在没连上时重连，不打断进行中的请求 */
export async function ensureBridge(handleMsg) {
  handleMsgRef = handleMsg;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  await startBridge(handleMsg);
}

export function stopBridge() {
  generation += 1;
  clearTimeout(reconnectTimer);
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
  }
  ws = null;
  connected = false;
}

function connect(url, token, gen) {
  if (gen !== generation) return;
  let wsUrl;
  try {
    const u = new URL(url);
    u.searchParams.set('token', token);
    wsUrl = u.toString();
  } catch {
    lastError = '接口地址无效';
    return;
  }

  let sock;
  try {
    sock = new WebSocket(wsUrl);
  } catch (e) {
    lastError = String(e.message || e);
    scheduleReconnect(gen);
    return;
  }
  ws = sock;

  sock.addEventListener('open', () => {
    if (gen !== generation) {
      try { sock.close(); } catch { /* ignore */ }
      return;
    }
    connected = true;
    lastError = '';
    lastConnectedAt = Date.now();
    addLog('info', 'Agent 接口已连接', url);
  });

  sock.addEventListener('message', async (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (msg?.type === 'ping') {
      try { sock.send(JSON.stringify({ type: 'pong', ts: Date.now() })); } catch { /* ignore */ }
      return;
    }
    if (!msg?.id || !msg?.action) return;
    try {
      const result = await handleMsgRef({ type: msg.action, ...(msg.payload || {}) }, { external: true });
      sock.send(JSON.stringify({ id: msg.id, ok: true, result }));
    } catch (e) {
      sock.send(JSON.stringify({ id: msg.id, ok: false, error: String(e.message || e) }));
    }
  });

  sock.addEventListener('close', () => {
    if (gen !== generation) return;
    connected = false;
    ws = null;
    scheduleReconnect(gen);
  });

  sock.addEventListener('error', () => {
    lastError = 'WebSocket 连接错误（桥接服务未启动？）';
  });
}

function scheduleReconnect(gen) {
  if (gen !== generation) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    if (gen !== generation) return;
    const config = await getConfig();
    const api = config.api || {};
    if (!api.enabled || !api.token) return;
    connect(api.url, api.token, gen);
  }, 5000);
}
