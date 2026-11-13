// 测 CDP 能否写插件的 chrome.storage（触发 SW 的命令通道）
const r = await fetch(`http://127.0.0.1:9222/json`);
const targets = await r.json();
const plugPage = targets.find((t) => t.url.includes('chrome-extension://lbjaejphdjahdkajciiehbjoemabihke'));
if (!plugPage) { console.log('无插件页'); process.exit(1); }
const ws = new WebSocket(plugPage.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });

// 探测 chrome.storage 可用性
const probe = await send('Runtime.evaluate', {
  expression: 'JSON.stringify({chrome: typeof chrome, storage: typeof (chrome&&chrome.storage), local: typeof (chrome&&chrome.storage&&chrome.storage.local)})',
  returnByValue: true,
});
console.log('探测:', probe.result?.result?.value);

// 尝试写命令
const write = await send('Runtime.evaluate', {
  expression: `(function(){ return new Promise((resolve)=>{
    try {
      chrome.storage.local.set({ extCmd: { type:'run-full', id:'test-'+Date.now() } }, () => {
        resolve('写入成功, lastError=' + (chrome.runtime?.lastError?.message || 'none'));
      });
      setTimeout(()=>resolve('timeout'), 5000);
    } catch(e){ resolve('异常:'+e.message); }
  }); })()`,
  returnByValue: true, awaitPromise: true,
});
console.log('写命令:', write.result?.result?.value ?? write.result);
ws.close();
