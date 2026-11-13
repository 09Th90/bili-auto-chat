/**
 * 在任意 CDP page target 上执行表达式。
 * node test/cdp-page-eval.mjs <urlContains> <expression>
 */
const port = process.env.CDP_PORT || '9222';
const needle = process.argv[2] || '';
const expr = process.argv[3] || '1+1';

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && (t.url || '').includes(needle));
if (!page) {
  console.log(JSON.stringify({ error: 'target not found', needle, urls: targets.map((t) => t.url) }));
  process.exit(1);
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

const ev = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 30000 });
console.log(JSON.stringify(ev.result?.result?.value ?? ev.result?.exceptionDetails ?? ev.result, null, 2));
ws.close();
