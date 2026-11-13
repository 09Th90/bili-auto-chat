// 连插件 options 页，执行 chrome.runtime.sendMessage 唤醒 SW
const r = await fetch(`http://127.0.0.1:9222/json`);
const targets = await r.json();
const optPage = targets.find((t) => t.url.includes('options.html'));
if (!optPage) { console.log('未找到 options 页'); process.exit(1); }

const ws = new WebSocket(optPage.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res));
let id = 0;
function send(method, params = {}) {
  return new Promise((resolve) => {
    const mid = ++id;
    const handler = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.id === mid) { ws.removeEventListener('message', handler); resolve(msg.result); }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

// 在 options 页上下文发消息唤醒 SW，并执行一次扫描
const expr = `new Promise((resolve) => {
  try {
    chrome.runtime.sendMessage({type:'scan-now'}, (resp) => {
      resolve('scan-now 响应: ' + JSON.stringify(resp));
    });
  } catch (e) { resolve('异常: ' + e.message); }
})`;
const result = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 40000 });
console.log('结果:', JSON.stringify(result.result?.value ?? result.result ?? result).slice(0, 300));
ws.close();
