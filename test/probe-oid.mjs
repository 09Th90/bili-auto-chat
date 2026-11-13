const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Edg/131.0.0.0';
const oid = '1268264595162660873';
// 试动态详情接口
for (const url of [
  `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${oid}`,
  `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/get_dynamic_detail?dynamic_id=${oid}`,
  `https://api.bilibili.com/x/v2/reply?type=11&oid=${oid}&pn=1&ps=5`,  // 老版评论接口
]) {
  try {
    const r = await (await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' } })).json();
    console.log(url.replace('https://','').slice(0,55), '→ code=' + r.code, (r.message||'').slice(0,20), '|', JSON.stringify(r.data||{}).slice(0,60));
  } catch (e) { console.log('ERR', e.message); }
}
