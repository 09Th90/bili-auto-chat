/**
 * 把导出的 B 站 cookie 写进测试实例（默认 9223）。
 * node test/cdp-cookies-import.mjs <cookies.json> [port]
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const port = process.argv[3] || '9223';
if (!file) throw new Error('用法: node test/cdp-cookies-import.mjs <cookies.json> [port]');
const raw = JSON.parse(readFileSync(file, 'utf8'));

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === 'page') || list.find((t) => t.type === 'other');
if (!page) throw new Error('没有可用的 page target');

const cookies = raw.map((c) => {
  const out = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite || 'Lax',
  };
  if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires;
  return out;
});

const ws = new WebSocket(page.webSocketDebuggerUrl);
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

await send('Network.enable');
const res = await send('Network.setCookies', { cookies });
const err = res.error?.message || res.result?.error;
console.log(JSON.stringify({ ok: !err, count: cookies.length, error: err || null }));
ws.close();
