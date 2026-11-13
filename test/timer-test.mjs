globalThis.chrome = {
  storage: { local: { async get(k){if(typeof k==='string')return{[k]:undefined};return{};}, async set(){} }, sync: { async get(){return{};}, async set(){} } },
  runtime: { onInstalled:{addListener(){}}, onStartup:{addListener(){}}, onMessage:{addListener(){}}, getManifest:()=>({version:'0.1.0'}) },
  alarms: { create(){}, clear(){}, onAlarm:{addListener(){}} },
  cookies: { async get(){return {value:'x'};} }, tabs: { async query(){return [];} }, scripting: { async executeScript(){return [];} },
};
const t0 = Date.now();
const log = (m) => console.log(`[${String(Date.now()-t0).padStart(5)}ms] ${m}`);
log('import 模块…');
const api = await import('../background/bilibili/api.js');
log('import 完成');
async function timed(name, fn) {
  const s = Date.now();
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 8000))]);
    log(`${name} → OK ${Date.now()-s}ms`);
  } catch (e) { log(`${name} → ${e.message} ${Date.now()-s}ms`); }
}
await timed('getNav', () => api.getNav());
await timed('getDmSessions', () => api.getDmSessions());
await timed('getMyArchives(假mid)', () => api.getMyArchives(1, 1, 1));
log('总计 ' + (Date.now()-t0) + 'ms');
