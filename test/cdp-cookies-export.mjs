/**
 * 从已登录的 Edge（默认 9222）导出 B 站 cookie，供测试实例使用。
 * node test/cdp-cookies-export.mjs [port] > cookies.json
 */
const port = process.argv[2] || '9222';
const urls = [
  'https://www.bilibili.com/',
  'https://api.bilibili.com/',
  'https://api.vc.bilibili.com/',
  'https://message.bilibili.com/',
];

async function targets() {
  return (await (await fetch(`http://127.0.0.1:${port}/json`)).json());
}

let list = await targets();
let page = list.find((t) => t.type === 'page' && /:\/\/([^/]+\.)?bilibili\.com\//.test(t.url || ''));
if (!page) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?https%3A%2F%2Fwww.bilibili.com%2F`, { method: 'PUT' });
  page = await res.json();
  await new Promise((r) => setTimeout(r, 4000));
}

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
const res = await send('Network.getCookies', { urls });
const cookies = res.result?.cookies || [];
process.stderr.write(`导出 ${cookies.length} 条 cookie（来源页面 ${page.url.slice(0, 60)}）\n`);
console.log(JSON.stringify(cookies));
ws.close();
