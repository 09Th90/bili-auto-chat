// 用 Browser-level CDP (browser ws) 列出所有 target 并 attach 到插件 SW
const r = await fetch(`http://127.0.0.1:9222/json/version`);
const ver = await r.json();
const browserWs = ver.webSocketDebuggerUrl;
console.log('browser ws:', browserWs);

const ws = new WebSocket(browserWs);
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

const gt = await send('Target.getTargets');
const infos = gt.result?.targetInfos || [];
console.log('全部 targets:', infos.length);
infos.forEach((t) => console.log(' ', t.type.padEnd(18), t.targetId.slice(0, 8), '|', (t.url || '').slice(0, 60)));

// 找插件 SW
const swInfo = infos.find((t) => (t.url || '').includes('lbjaejphdjahdkajciiehbjoemabihke') && t.type === 'service_worker');
console.log('\n插件 SW:', swInfo ? swInfo.targetId : '未找到');

if (swInfo) {
  const at = await send('Target.attachToTarget', { targetId: swInfo.targetId, flatten: true });
  console.log('attach sessionId:', at.result?.sessionId ? '成功' : '失败');
  const sessionId = at.result?.sessionId;
  // 在 SW 上下文 evaluate
  const ev = await send('Runtime.evaluate', {
    expression: 'typeof runScan + "/" + typeof doSend + "/" + typeof getConfig',
    returnByValue: true, sessionId,
  });
  console.log('SW 函数可见性:', JSON.stringify(ev.result?.result?.value ?? ev.result));
}
ws.close();
