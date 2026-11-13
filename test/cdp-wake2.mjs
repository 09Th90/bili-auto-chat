// 在 options 页的 MAIN world 执行（访问 chrome API）
const r = await fetch(`http://127.0.0.1:9222/json`);
const targets = await r.json();
const optPage = targets.find((t) => t.url.includes('options.html'));
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

// 启用 Runtime，获取 executionContext
await send('Runtime.enable');
await send('Page.enable');
// 等待 context 创建
const ctx = await new Promise((resolve) => {
  const h = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.method === 'Runtime.executionContextCreated' && msg.params.context.auxData?.isDefault) {
      ws.removeEventListener('message', h);
      resolve(msg.params.context.id);
    }
  };
  ws.addEventListener('message', h);
  setTimeout(() => resolve(null), 3000);
});
console.log('context id:', ctx);

// 找 main world context（type=default, auxData.frameId 存在）
const expr = `(function(){
  return new Promise((resolve) => {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime) { resolve('chrome 不可用'); return; }
      chrome.runtime.sendMessage({type:'scan-now'}, (resp) => {
        resolve('scan-now → ' + JSON.stringify(resp));
      });
    } catch (e) { resolve('异常: ' + e.message); }
  });
})()`;
const result = await send('Runtime.evaluate', {
  expression: expr, returnByValue: true, awaitPromise: true, timeout: 40000,
  ...(ctx ? { contextId: ctx } : {}),
});
console.log('结果:', JSON.stringify(result.result?.value ?? result.result ?? result).slice(0, 300));
ws.close();
