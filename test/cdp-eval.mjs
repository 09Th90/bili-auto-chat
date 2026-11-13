// CDP 连接 SW 并执行表达式，验证 CDP 调 SW 可行性
const port = process.argv[2] || '9222';
const expr = process.argv[3] || '1+1';

const r = await fetch(`http://127.0.0.1:${port}/json`);
const targets = await r.json();
const sw = targets.find((t) => t.type === 'service_worker');
if (!sw) { console.log('无 SW'); process.exit(1); }

// 用 WebSocket 连 CDP
const { WebSocket } = await import('node:worker_threads').then(() => ({ WebSocket: globalThis.WebSocket }));
const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res));

let id = 0;
function send(method, params = {}) {
  return new Promise((resolve) => {
    const mid = ++id;
    const handler = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.id === mid) {
        ws.removeEventListener('message', handler);
        resolve(msg.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

const result = await send('Runtime.evaluate', {
  expression: expr,
  returnByValue: true,
  awaitPromise: true,
});
console.log('CDP eval 结果:', JSON.stringify(result.result?.value ?? result.result ?? result));
ws.close();
