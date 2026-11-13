// 通过 CDP 在插件页面 main world 执行 chrome.runtime.sendMessage（用 Runtime.evaluate with userGesture + contextId 从 Page.getFrameTree）
const r = await fetch(`http://127.0.0.1:9222/json`);
const targets = await r.json();
const optPage = targets.find((t) => t.url.includes('options.html') || t.url.includes('popup.html'));
if (!optPage) { console.log('无插件页面，打开 popup'); process.exit(1); }
console.log('连接:', optPage.url.slice(0, 60));

const ws = new WebSocket(optPage.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res));
let id = 0;
function send(method, params = {}) {
  return new Promise((resolve) => {
    const mid = ++id;
    const handler = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.id === mid) { ws.removeEventListener('message', handler); resolve(msg); }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

// 先用 DOM 判断是否扩展页面，再用 Runtime.evaluate 执行（不指定 contextId，Chrome 会用默认 page context）
// 关键：扩展页面的 evaluate 默认 context 就是 page context，chrome 应可用
const r1 = await send('Runtime.evaluate', {
  expression: 'typeof chrome + "/" + (chrome && chrome.runtime ? "runtime-ok" : "no-runtime")',
  returnByValue: true,
});
console.log('探测:', JSON.stringify(r1.result?.result?.value ?? r1.result));

// 直接执行扫描
const expr = `new Promise((resolve) => {
  try {
    chrome.runtime.sendMessage({type:'get-state'}, (resp) => {
      resolve('state: ' + JSON.stringify({hasConfig: !!resp?.config, login: resp?.login?.uname, outbox: resp?.outbox?.length}));
    });
    setTimeout(() => resolve('timeout'), 15000);
  } catch (e) { resolve('异常: ' + e.message); }
})`;
const r2 = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 20000 });
console.log('get-state:', JSON.stringify(r2.result?.result?.value ?? r2.result).slice(0, 300));
ws.close();
