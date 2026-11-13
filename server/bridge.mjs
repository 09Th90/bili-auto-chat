#!/usr/bin/env node
/**
 * bili-auto-chat 本地桥接服务（零依赖）。
 *
 * 扩展主动连 ws://127.0.0.1:8765/ws?token=xxx；
 * 第三方 Agent 走 HTTP：
 *   GET  /health
 *   GET  /v1/state
 *   POST /v1/scan                 {wait?:true}
 *   POST /v1/generate             {text, scene?, chatKey?}
 *   POST /v1/reply                {text, chatKey, speakerName, speakerUid, scene, replyPayload, sceneLabel}
 *   POST /v1/send                 {text, replyPayload, chatKey?, incomingText?, force?}
 *   POST /v1/chat/completions     OpenAI 兼容
 *   GET  /v1/outbox
 *   POST /v1/outbox/:id/confirm   {text?}
 *   POST /v1/outbox/:id/discard
 *   POST /v1/outbox/:id/retry
 *   GET  /v1/logs?limit=50
 *   POST /v1/reset-circuit        {kind?}
 *   POST /v1/config               {patch}
 *
 * 鉴权：Authorization: Bearer <token>（也支持 X-API-Key / ?token=）
 * 只监听 127.0.0.1；token 保存在 server/token.txt。
 */
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendDirect, getReplies } from './sender.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.BILI_BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.BILI_BRIDGE_PORT || 8765);
const TOKEN_FILE = join(__dirname, 'token.txt');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function loadToken() {
  if (process.env.BILI_BRIDGE_TOKEN) return process.env.BILI_BRIDGE_TOKEN.trim();
  if (existsSync(TOKEN_FILE)) {
    const t = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  }
  const t = randomBytes(24).toString('hex');
  mkdirSync(__dirname, { recursive: true });
  writeFileSync(TOKEN_FILE, t + '\n');
  console.error('[bridge] 已生成 token（写入 server/token.txt）');
  console.error('[bridge] 请把该 token 填到扩展设置页「第三方 Agent 接口」');
  return t;
}
const TOKEN = loadToken();

/** ---------------- WebSocket 极简服务端 ---------------- */
let extSocket = null;
let extConnectedAt = 0;
let lastPongAt = 0;
let pingTimer = null;
let fragOpcode = 0;
let fragParts = [];
let rpcSeq = 0;
const pending = new Map();

function wsFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = body.length;
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function wsSend(socket, payload, opcode = 0x1) {
  if (!socket || socket.destroyed) return false;
  try {
    socket.write(wsFrame(payload, opcode));
    return true;
  } catch {
    return false;
  }
}

function extractFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (len > 5_000_000) throw new Error('frame too large');
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { fin, opcode, payload, total: offset + maskLen + len };
}

function attachSocket(socket) {
  if (extSocket && extSocket !== socket) {
    try { extSocket.destroy(); } catch { /* ignore */ }
  }
  extSocket = socket;
  extConnectedAt = Date.now();
  lastPongAt = Date.now();
  fragOpcode = 0;
  fragParts = [];
  socket.setNoDelay(true);

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      let frame;
      try {
        frame = extractFrame(buf);
      } catch {
        socket.destroy();
        return;
      }
      if (!frame) break;
      buf = buf.subarray(frame.total);
      handleFrame(socket, frame);
    }
  });
  socket.on('close', () => {
    if (extSocket === socket) {
      extSocket = null;
      rejectAll(new Error('extension-disconnected'));
    }
  });
  socket.on('error', () => {});
  startPing();
  console.error('[bridge] 扩展已连接');
}

function handleFrame(socket, frame) {
  if (frame.opcode === 0x8) {
    wsSend(socket, frame.payload, 0x8);
    socket.end();
    return;
  }
  if (frame.opcode === 0x9) {
    wsSend(socket, frame.payload, 0xa);
    return;
  }
  if (frame.opcode === 0xa) {
    lastPongAt = Date.now();
    return;
  }
  if (frame.opcode !== 0x1 && frame.opcode !== 0x0) return;

  if (frame.opcode === 0x1) {
    fragOpcode = 0x1;
    fragParts = [frame.payload];
  } else {
    fragParts.push(frame.payload);
  }
  if (!frame.fin) return;
  const text = Buffer.concat(fragParts).toString('utf8');
  fragParts = [];
  fragOpcode = 0;

  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg?.type === 'pong') {
    lastPongAt = Date.now();
    return;
  }
  if (msg?.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || 'extension error'));
  }
}

function startPing() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (!extSocket) return;
    if (Date.now() - lastPongAt > 70_000) {
      try { extSocket.destroy(); } catch { /* ignore */ }
      return;
    }
    wsSend(extSocket, JSON.stringify({ type: 'ping', ts: Date.now() }));
  }, 10_000);
}

function rejectAll(err) {
  for (const [, p] of pending) p.reject(err);
  pending.clear();
}

function rpc(action, payload = {}, timeoutMs = 60_000) {
  if (!extSocket) {
    return Promise.reject(Object.assign(new Error('扩展未连接桥接服务'), { code: 'extension-disconnected' }));
  }
  const id = `rpc-${++rpcSeq}-${Date.now()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error(`RPC 超时：${action}`), { code: 'rpc-timeout' }));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    const ok = wsSend(extSocket, JSON.stringify({ id, action, payload }));
    if (!ok) {
      clearTimeout(timer);
      pending.delete(id);
      reject(Object.assign(new Error('发送失败：扩展连接已断开'), { code: 'extension-disconnected' }));
    }
  });
}

/** ---------------- HTTP ---------------- */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key');
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function auth(req, url) {
  const h = String(req.headers.authorization || '');
  const bearer = h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
  const token = bearer || String(req.headers['x-api-key'] || '') || url.searchParams.get('token') || '';
  return token === TOKEN;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scanAndWait(body) {
  const startedAt = Date.now();
  const kicked = await rpc('scan-now', {});
  if (body.wait === false || kicked?.skipped) return kicked;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(1500);
    const t = await rpc('get-task');
    if (t?.task?.status === 'done' && (t.task.at || 0) >= startedAt) return t.task;
  }
  return { started: true, timeout: true, hint: '扫描超过 90s，结果请查日志' };
}

async function route(req, res, url) {
  if (url.pathname === '/health' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      service: 'bili-auto-chat-bridge',
      extensionConnected: !!extSocket,
      connectedAt: extConnectedAt,
      pending: pending.size,
      tokenFile: TOKEN_FILE,
      now: Date.now(),
    });
  }
  // 首次配对页：用户在主浏览器打开一次，把 token 写进扩展并让扩展连上桥
  if (url.pathname === '/pair' && req.method === 'GET') {
    if (url.searchParams.get('token') !== TOKEN) return json(res, 401, { error: 'bad token' });
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>配对 B站自动聊天</title>
<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;max-width:640px;margin:60px auto;padding:0 20px;color:#222}
h1{font-size:20px}.ok{color:#0a7d32}.err{color:#b00020}code{background:#f3f3f3;padding:2px 6px;border-radius:4px}</style>
</head><body><h1>配对「B站自动聊天」</h1>
<p>这个页面由本地桥接服务提供，只用于把 token 写进浏览器扩展。</p>
<p id="s">正在配对…</p>
<p style="color:#666;font-size:13px">配对成功后可以关闭此页面。桥接地址：<code>ws://127.0.0.1:8765/ws</code></p>
<script>
const EXT_ID = 'lbjaejphdjahdkajciiehbjoemabihke';
const TOKEN = ${JSON.stringify(TOKEN)};
const WS = 'ws://127.0.0.1:8765/ws';
function send(msg){return new Promise(function(resolve){
  try { chrome.runtime.sendMessage(EXT_ID, msg, function(r){
    if (chrome.runtime.lastError) { resolve({error: chrome.runtime.lastError.message}); return; }
    resolve(r || {error:'空响应'});
  }); } catch(e) { resolve({error: e.message}); }
  setTimeout(function(){resolve({error:'超时'});}, 8000);
});}
(async function(){
  const el = document.getElementById('s');
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
    el.className = 'err';
    el.textContent = '此页面拿不到扩展接口，请在插件设置页手动填写 token 并启用。';
    return;
  }
  el.textContent = '正在写入配置…';
  const r = await send({action:'api-config', token:TOKEN, url:WS});
  if (!r || !r.ok) {
    el.className = 'err';
    el.textContent = '配对失败：' + ((r && r.error) || '未知错误') + '（请确认已点插件里的「重载后台」）';
    return;
  }
  el.className = 'ok';
  el.textContent = '配对成功，插件正在连接桥接服务…';
  setTimeout(async function(){
    const s = await send({action:'api-status', token:TOKEN});
    el.textContent = s && s.connected ? '已连接，可以关闭此页面。' : ('已配对但桥接未连接：' + ((s && s.lastError) || '请检查桥接服务'));
    el.className = s && s.connected ? 'ok' : 'err';
  }, 2500);
})();
</script></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  if (!url.pathname.startsWith('/v1/')) return json(res, 404, { error: 'not found' });
  if (!auth(req, url)) {
    return json(res, 401, { error: 'unauthorized', hint: 'Authorization: Bearer <server/token.txt 里的 token>' });
  }

  const body = req.method === 'POST' ? await readJson(req) : {};
  const p = url.pathname;

  if (p === '/v1/state' && req.method === 'GET') return json(res, 200, await rpc('get-state'));
  if (p === '/v1/scan' && req.method === 'POST') return json(res, 200, await scanAndWait(body));
  if (p === '/v1/scan-state' && req.method === 'GET') return json(res, 200, await rpc('get-scan-state'));
  if (p === '/v1/test-cookie-direct' && req.method === 'GET') return json(res, 200, await rpc('test-cookie-direct'));
    if (p === '/v1/msgfeed' && req.method === 'GET') {
    return json(res, 200, await rpc('get-msgfeed', {
      kind: url.searchParams.get('kind') || 'reply',
      cursor: Number(url.searchParams.get('cursor')) || 0,
    }, 60_000));
  }
  if (p === '/v1/generate' && req.method === 'POST') {
    const text = body.text || body.incomingText || body.prompt;
    if (!text) return json(res, 400, { error: '缺少 text' });
    return json(res, 200, await rpc('quick-chat', {
      text,
      scene: body.scene || 'dm',
      chatKey: body.chatKey,
    }));
  }
  if (p === '/v1/reply' && req.method === 'POST') {
    return json(res, 200, await rpc('manual-reply', {
      chatKey: body.chatKey,
      text: body.text,
      speakerName: body.speakerName,
      speakerUid: body.speakerUid,
      scene: body.scene,
      replyPayload: body.replyPayload,
      sceneLabel: body.sceneLabel,
    }));
  }
  if (p === '/v1/send' && req.method === 'POST') {
    let cookies = {};
    try {
      const c = await rpc('get-cookies', {}, 20000);
      cookies = c?.cookies || {};
    } catch (e) {
      return json(res, 503, { error: `无法从扩展获取 Cookie：${String(e.message || e)}`, code: 'extension-disconnected' });
    }
    const result = await sendDirect(body, cookies);
    if (result?.code === 0 && body.dedupeId) {
      await rpc('mark-replied', {
        dedupeId: body.dedupeId,
        chatKey: body.chatKey,
        kind: body.replyPayload?.kind === 'dm' ? 'dm' : 'comment',
        incomingText: body.incomingText,
        speakerName: body.speakerName,
        sceneLabel: body.sceneLabel,
        replyPayload: body.replyPayload,
        replyText: body.text,
        source: body.source || 'agent',
      }, 15000).catch(() => {});
    }
    return json(res, 200, { sent: result?.code === 0, ...result });
  }
  if (p === '/v1/mark-replied' && req.method === 'POST') {
    return json(res, 200, await rpc('mark-replied', body));
  }
  if (p === '/v1/reload' && req.method === 'POST') {
    try { await rpc('reload', {}, 3000); } catch { /* reload 会断开连接 */ }
    return json(res, 200, { ok: true });
  }
  if (p === '/v1/replies' && req.method === 'GET') {
    return json(res, 200, await getReplies({
      oid: url.searchParams.get('oid'),
      type: url.searchParams.get('type') || '1',
      root: url.searchParams.get('root'),
      pn: Number(url.searchParams.get('pn')) || 1,
      ps: Number(url.searchParams.get('ps')) || 20,
    }));
  }
  if (p === '/v1/chat/completions' && req.method === 'POST') {
    const messages = Array.isArray(body.messages) && body.messages.length
      ? body.messages
      : [{ role: 'user', content: String(body.prompt || body.text || '') }];
    const out = await rpc('agent-chat', {
      messages,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
    });
    return json(res, 200, {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: out?.model || body.model || 'bili-auto-chat',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: out?.reply || '' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
  if (p === '/v1/dm/history' && req.method === 'GET') {
    const talker = url.searchParams.get('talker');
    if (!talker) return json(res, 400, { error: '缺少 talker' });
    return json(res, 200, await rpc('get-dm-history', {
      talkerId: talker,
      size: Number(url.searchParams.get('size')) || 20,
    }, 90_000));
  }
  if (p === '/v1/inbox' && req.method === 'GET') {
    const out = await rpc('get-inbox');
    const status = url.searchParams.get('status') || 'open';
    const open = new Set(['pending', 'error', 'draft', 'queued', 'failed']);
    let inbox = out?.inbox || [];
    if (status === 'open') inbox = inbox.filter((x) => open.has(x.status));
    else if (status !== 'all') inbox = inbox.filter((x) => x.status === status);
    return json(res, 200, { inbox, stats: out?.stats });
  }
  const ib = p.match(/^\/v1\/inbox\/([^/]+)\/(retry|ignore)$/);
  if (ib && req.method === 'POST') {
    const id = decodeURIComponent(ib[1]);
    const action = ib[2] === 'retry' ? 'inbox-retry' : 'inbox-ignore';
    return json(res, 200, await rpc(action, { id, text: body.text }));
  }
  if (p === '/v1/outbox' && req.method === 'GET') return json(res, 200, await rpc('get-outbox'));
  if (p === '/v1/logs' && req.method === 'GET') {
    const out = await rpc('get-logs');
    let logs = out?.logs || [];
    const level = url.searchParams.get('level');
    if (level) logs = logs.filter((l) => l.level === level);
    const since = Number(url.searchParams.get('since'));
    if (since > 0) logs = logs.filter((l) => (l.ts || 0) >= since);
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
    return json(res, 200, { logs: logs.slice(-limit), total: logs.length });
  }
  const ob = p.match(/^\/v1\/outbox\/([^/]+)\/(confirm|discard|retry)$/);
  if (ob && req.method === 'POST') {
    const id = decodeURIComponent(ob[1]);
    const act = ob[2];
    const action = act === 'confirm' ? 'outbox-confirm' : act === 'discard' ? 'outbox-discard' : 'outbox-retry';
    return json(res, 200, await rpc(action, { id, text: body.text }));
  }
  if (p === '/v1/reset-circuit' && req.method === 'POST') {
    return json(res, 200, await rpc('reset-circuit', { kind: body.kind }));
  }
  if (p === '/v1/config' && req.method === 'POST') {
    return json(res, 200, await rpc('save-config', { patch: body.patch || body }));
  }
  return json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  route(req, res, url).catch((e) => {
    const code = e?.code === 'extension-disconnected' ? 503 : e?.code === 'rpc-timeout' ? 504 : 500;
    const hint = code === 503
      ? '请确认扩展已启用，并在设置页「第三方 Agent 接口」填好同一个 token'
      : undefined;
    json(res, code, { error: String(e?.message || e), code: e?.code, hint });
  });
});

server.on('upgrade', (req, socket) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`); } catch { socket.destroy(); return; }
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  if (url.searchParams.get('token') !== TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  attachSocket(socket);
});

server.listen(PORT, HOST, () => {
  console.error(`[bridge] listening http://${HOST}:${PORT}  (health: /health)`);
  console.error(`[bridge] token: ${TOKEN}`);
  console.error('[bridge] 扩展设置页填：ws://' + HOST + ':' + PORT + '/ws + 同一个 token');
});

process.on('SIGINT', () => {
  clearInterval(pingTimer);
  server.close(() => process.exit(0));
});
