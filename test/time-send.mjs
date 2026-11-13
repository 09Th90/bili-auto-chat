// 逐步计时诊断发送链路，找卡点
globalThis.chrome = {
  storage: { local: { async get(k){if(typeof k==='string')return{[k]:undefined};return{};}, async set(){} }, sync: { async get(){return{};}, async set(){} } },
  runtime: { onInstalled:{addListener(){}}, onStartup:{addListener(){}}, onMessage:{addListener(){}}, getManifest:()=>({version:'0.1.0'}) },
  alarms: { create(){}, clear(){}, onAlarm:{addListener(){}} },
  cookies: { async get(){ await new Promise(r=>setTimeout(r,50)); return {value:'csrf'}; } },
  tabs: { async query(){ await new Promise(r=>setTimeout(r,30)); return [{id:1, url:'https://www.bilibili.com/video/BV1xx'}]; } },
  scripting: { async executeScript(){ return []; } },
};
const t = Date.now();
const log = (m) => console.log(`[${Date.now()-t}ms] ${m}`);

log('开始');
const { getCsrf } = await import('../background/bilibili/api.js');
const csrf = await getCsrf();
log('getCsrf → ' + (csrf ? 'OK' : 'null'));

// 测 bridgeFetch 的 sendMessage（模拟无监听器 = 快速失败）
log('bridgeFetch 开始');
const api = await import('../background/bilibili/api.js');
try {
  const r = await Promise.race([
    api.addReply({ type:1, oid:'123', message:'test', root:'456', parent:'456' }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('TOTAL-TIMEOUT-25s')), 25000)),
  ]);
  log('addReply → ' + JSON.stringify(r).slice(0, 80));
} catch (e) {
  log('addReply → ' + e.message);
}
log('总耗时 ' + (Date.now()-t) + 'ms');
