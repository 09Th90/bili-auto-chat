// 操控入口：通过插件 popup 页面的 main world 发消息给 SW，执行完整流程
// 关键：用 Page.addScriptToEvaluateOnNewDocument 在 main world 注入，绕过 isolated world 限制
const args = process.argv.slice(2);
const action = args[0] || 'state';

const r = await fetch(`http://127.0.0.1:9222/json`);
const targets = await r.json();
// 找插件 popup 或 options 页
let plugPage = targets.find((t) => t.url.includes('chrome-extension://') && (t.url.includes('popup') || t.url.includes('options')));
if (!plugPage) {
  // 打开 popup（这是操控入口，非多余窗口）
  const nr = await fetch('http://127.0.0.1:9222/json/new?chrome-extension://lbjaejphdjahdkajciiehbjoemabihke/popup/popup.html', { method: 'PUT' });
  plugPage = await nr.json();
  await new Promise((res) => setTimeout(res, 1500));
}
console.log('操控入口:', (plugPage.url || '').slice(0, 60));

const ws = new WebSocket(plugPage.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (evt) => {
  const msg = JSON.parse(evt.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
function send(method, params = {}) {
  return new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

await send('Page.enable');
await send('Runtime.enable');
// 在 main world 注入：获取 chrome API（addScriptToEvaluateOnNewDocument 注入的是 main world）
const inject = await send('Page.addScriptToEvaluateOnNewDocument', {
  source: 'window.__hasChrome = typeof chrome !== "undefined";',
});
// 重新加载使注入生效
await send('Page.reload', { ignoreCache: true });
await new Promise((res) => setTimeout(res, 2000));

// 用 main world context 执行（auxData.isDefault + origin chrome-extension）
// 直接 evaluate，Chrome 对扩展页面的默认 context 就是 main world
const expr = `(function(){
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.runtime) { resolve('no-chrome: ' + typeof chrome); return; }
    const msg = ${JSON.stringify(buildMsg(action))};
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) { resolve('err: ' + chrome.runtime.lastError.message); return; }
      resolve('OK: ' + JSON.stringify(resp).slice(0, 400));
    });
    setTimeout(() => resolve('timeout'), 25000);
  });
})()`;
const ev = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 30000 });
console.log('结果:', JSON.stringify(ev.result?.result?.value ?? ev.result).slice(0, 500));
ws.close();

function buildMsg(a) {
  if (a === 'scan') return { type: 'scan-now' };
  if (a === 'state') return { type: 'get-state' };
  return { type: 'get-state' };
}
