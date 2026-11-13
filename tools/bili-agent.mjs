#!/usr/bin/env node
/**
 * 第三方 Agent CLI：通过本地桥接服务调用插件。
 * 示例：
 *   node tools/bili-agent.mjs health
 *   node tools/bili-agent.mjs state
 *   node tools/bili-agent.mjs scan
 *   node tools/bili-agent.mjs generate "你好呀"
 *   node tools/bili-agent.mjs chat "你好呀"
 *   node tools/bili-agent.mjs send '{"text":"回复内容","replyPayload":{"replyType":1,"oid":"414932549","root":"323415338400","parent":"323422071392"}}'
 *   node tools/bili-agent.mjs send @payload.json
 *   node tools/bili-agent.mjs outbox
 *   node tools/bili-agent.mjs logs 20
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BILI_BRIDGE_URL || 'http://127.0.0.1:8765';
const TOKEN_FILE = join(ROOT, 'server', 'token.txt');
const TOKEN = process.env.BILI_BRIDGE_TOKEN || (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : '');

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    let res;
    try {
      res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      console.error(`无法连接桥接服务 ${BASE}`);
      console.error('请先运行：tools/start-bridge.cmd（或 node server/bridge.mjs）');
      console.error(String(e.message || e));
      process.exit(1);
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (res.ok) return data;
    lastErr = { status: res.status, data };
    // 扩展后台休眠/重载瞬间：等重连后自动重试
    if ([502, 503, 504].includes(res.status) && i < 2) {
      console.error(`桥接暂时不可用（HTTP ${res.status}），等待重连后重试…`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    console.error(`HTTP ${res.status}`);
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
  console.error(JSON.stringify(lastErr, null, 2));
  process.exit(1);
}

function readPayload(arg) {
  if (!arg) {
    console.error('缺少 JSON 参数');
    process.exit(1);
  }
  const text = arg.startsWith('@') ? readFileSync(arg.slice(1), 'utf8') : arg;
  try { return JSON.parse(text); } catch (e) {
    console.error('JSON 解析失败:', e.message);
    process.exit(1);
  }
}

const [cmd, ...args] = process.argv.slice(2);
let out;
switch (cmd) {
  case 'health':
    out = await (await fetch(BASE + '/health')).json();
    break;
  case 'state':
    out = await api('GET', '/v1/state');
    break;
  case 'scan':
    out = await api('POST', '/v1/scan', { wait: args[0] !== 'nowait' });
    break;
  case 'generate':
    out = await api('POST', '/v1/generate', { text: args.join(' ') });
    break;
  case 'chat':
    out = await api('POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: args.join(' ') }],
    });
    break;
  case 'reply':
    out = await api('POST', '/v1/reply', readPayload(args[0]));
    break;
  case 'send':
    out = await api('POST', '/v1/send', readPayload(args[0]));
    break;
  case 'dm':
    out = await api('GET', `/v1/dm/history?talker=${encodeURIComponent(args[0])}&size=${Number(args[1]) || 20}`);
    break;
  case 'replies':
    out = await api('GET', `/v1/replies?oid=${encodeURIComponent(args[0])}&type=${args[1] || '1'}&root=${encodeURIComponent(args[2] || '')}&ps=${Number(args[3]) || 20}`);
    break;
  case 'inbox':
    out = await api('GET', `/v1/inbox?status=${args[0] || 'open'}`);
    break;
  case 'inbox-retry':
    out = await api('POST', `/v1/inbox/${encodeURIComponent(args[0])}/retry`, { text: args[1] });
    break;
  case 'inbox-ignore':
    out = await api('POST', `/v1/inbox/${encodeURIComponent(args[0])}/ignore`, {});
    break;
  case 'outbox':
    out = await api('GET', '/v1/outbox');
    break;
  case 'logs':
    out = await api('GET', `/v1/logs?limit=${Number(args[0]) || 50}`);
    break;
  case 'confirm':
    out = await api('POST', `/v1/outbox/${encodeURIComponent(args[0])}/confirm`, { text: args[1] });
    break;
  case 'discard':
    out = await api('POST', `/v1/outbox/${encodeURIComponent(args[0])}/discard`, {});
    break;
  case 'retry':
    out = await api('POST', `/v1/outbox/${encodeURIComponent(args[0])}/retry`, {});
    break;
  case 'config':
    out = await api('POST', '/v1/config', { patch: readPayload(args[0]) });
    break;
  case 'reset':
    out = await api('POST', '/v1/reset-circuit', { kind: args[0] });
    break;
  default:
    console.log(`bili-agent 用法：
  node tools/bili-agent.mjs health
  node tools/bili-agent.mjs state
  node tools/bili-agent.mjs scan [nowait]
  node tools/bili-agent.mjs generate <文本>
  node tools/bili-agent.mjs chat <文本>
  node tools/bili-agent.mjs reply '<JSON>'
  node tools/bili-agent.mjs send '<JSON>'
  node tools/bili-agent.mjs dm <uid> [条数]
  node tools/bili-agent.mjs replies <oid> <type> <root> [条数]
  node tools/bili-agent.mjs inbox [open|all|skipped]
  node tools/bili-agent.mjs inbox-retry <id> [新文本]
  node tools/bili-agent.mjs inbox-ignore <id>
  node tools/bili-agent.mjs outbox
  node tools/bili-agent.mjs logs [条数]
  node tools/bili-agent.mjs confirm <id> [新文本]
  node tools/bili-agent.mjs discard <id>
  node tools/bili-agent.mjs retry <id>
  node tools/bili-agent.mjs config '<JSON patch>'
  node tools/bili-agent.mjs reset [comment|dm]
环境变量：BILI_BRIDGE_URL（默认 http://127.0.0.1:8765）、BILI_BRIDGE_TOKEN`);
    process.exit(0);
}
console.log(JSON.stringify(out, null, 2));
