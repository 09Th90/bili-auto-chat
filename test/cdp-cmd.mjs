// 用 addScriptToEvaluateOnNewDocument 在 MAIN world 注入命令执行器
// 注入脚本跑在页面真实 main world，有完整 chrome API
const cmdType = process.argv[2] || 'run-full';
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

await send('Page.enable');
await send('Runtime.enable');

// 注入脚本到 main world：把结果写到 window.__cmdResult，并 storage 写命令
const cmdId = 'cmd-' + Date.now();
const source = `
  (function(){
    try {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.set({ extCmd: { type: ${JSON.stringify(cmdType)}, id: ${JSON.stringify(cmdId)} } }, function(){
          window.__cmdResult = 'write-ok';
        });
      } else {
        window.__cmdResult = 'no-chrome-storage: ' + typeof chrome;
      }
    } catch(e) { window.__cmdResult = 'exc: ' + e.message; }
  })();
`;
await send('Page.addScriptToEvaluateOnNewDocument', { source });
// reload 触发注入
await send('Page.reload', { ignoreCache: true });
await new Promise((res) => setTimeout(res, 2500));

// 读注入脚本的结果（main world 的 window.__cmdResult）
const read = await send('Runtime.evaluate', { expression: 'window.__cmdResult || "not-set"', returnByValue: true });
console.log('注入结果:', read.result?.result?.value);

// 读命令执行结果（SW 写到 storage 的 extCmdResult）
const readResult = await send('Runtime.evaluate', {
  expression: `(function(){ return new Promise((resolve)=>{
    if (typeof chrome==='undefined'||!chrome.storage){ resolve('no-chrome'); return; }
    chrome.storage.local.get(['extCmdResult'], (d)=>{
      resolve(JSON.stringify(d.extCmdResult || 'none'));
    });
    setTimeout(()=>resolve('timeout'), 3000);
  }); })()`,
  returnByValue: true, awaitPromise: true,
});
console.log('命令结果:', readResult.result?.result?.value ?? readResult.result);
ws.close();
