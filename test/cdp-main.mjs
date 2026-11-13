// 在插件页面的 MAIN world 执行（有 chrome API）
const r = await fetch(`http://127.0.0.1:9222/json`);
const targets = await r.json();
const optPage = targets.find((t) => t.url.includes('options.html'));
const ws = new WebSocket(optPage.webSocketDebuggerUrl);
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

// 收集所有 executionContext，找 main world（auxData.isDefault=true 或 type=default）
let mainCtx = null;
const ctxs = [];
await send('Runtime.enable');
await send('Page.enable');
// 重新导航触发 context 事件，或直接用 Page.getFrameTree 后 evaluate in all contexts
const tree = await send('Page.getFrameTree');
const frameId = tree.result?.frameTree?.frame?.id;
console.log('frameId:', frameId);

// 方法：用 Runtime.evaluate 不带 contextId 时默认进 isolated world。
// 正确做法：用 Page.addScriptToEvaluateOnNewDocument 或直接用 Runtime.evaluate with contextId of default world。
// 通过 Runtime.enable 后已有的 context：重新加载页面收集
const ctxPromise = new Promise((resolve) => {
  const h = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.method === 'Runtime.executionContextCreated') {
      const c = msg.params.context;
      ctxs.push({ id: c.id, origin: c.origin, isDefault: c.auxData?.isDefault, type: c.type });
      if (c.auxData?.isDefault || c.origin?.startsWith('chrome-extension://')) {
        ws.removeEventListener('message', h);
        resolve(c.id);
      }
    }
  };
  ws.addEventListener('message', h);
  setTimeout(() => resolve(null), 4000);
});
await send('Page.reload', { ignoreCache: true });
const ctxId = await ctxPromise;
console.log('contexts:', JSON.stringify(ctxs), '| 选中 main ctx:', ctxId);

if (ctxId) {
  const expr = `new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({type:'get-state'}, (resp) => {
        resolve('state: ' + JSON.stringify({login: resp?.login?.uname, outbox: resp?.outbox?.length, enabled: resp?.config?.enabled}));
      });
      setTimeout(() => resolve('timeout'), 15000);
    } catch (e) { resolve('异常: ' + e.message); }
  })`;
  const r2 = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, contextId: ctxId, timeout: 20000 });
  console.log('get-state:', JSON.stringify(r2.result?.result?.value ?? r2.result).slice(0, 300));
}
ws.close();
