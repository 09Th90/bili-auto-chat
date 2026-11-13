// 连 extensions 页，读取已安装扩展列表
const r = await fetch(`http://127.0.0.1:9222/json`);
const targets = await r.json();
const extPage = targets.find((t) => t.url.includes('edge://extensions') || t.url.includes('extensions'));
if (!extPage) { console.log('无 extensions 页'); process.exit(1); }
const ws = new WebSocket(extPage.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res));
let id = 0;
function send(method, params = {}) {
  return new Promise((resolve) => {
    const mid = ++id;
    const h = (evt) => { const m = JSON.parse(evt.data); if (m.id === mid) { ws.removeEventListener('message', h); resolve(m.result); } };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
// extensions 页是 polymer 应用，读 DOM
const snap = await send('Runtime.evaluate', {
  expression: `document.body.innerText.slice(0, 800)`,
  returnByValue: true,
});
console.log('extensions 页内容:', snap.result?.value);
ws.close();
