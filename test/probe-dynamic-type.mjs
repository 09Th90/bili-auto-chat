const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Edg/131.0.0.0';
const { computeMixinKey, signParams } = await import('../background/bilibili/wbi.js');
const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: { 'User-Agent': UA } })).json();
const pick = (u) => u.split('/').pop().split('.')[0];
const mk = computeMixinKey(pick(nav.data.wbi_img.img_url), pick(nav.data.wbi_img.sub_url));
const oid = '1268264595162660873';
for (const type of [11, 17, 1]) {
  const p = signParams({ oid, type, mode: 3, plat: 1, web_location: 1315875, pagination_str: '{"offset":""}' }, mk);
  const r = await (await fetch('https://api.bilibili.com/x/v2/reply/wbi/main?' + new URLSearchParams(p), { headers: { 'User-Agent': UA } })).json();
  console.log('type=' + type, '→ code=' + r.code, 'replies=' + (r.data?.replies?.length ?? '-'), r.code === 0 ? '✅ 正确' : (r.message || ''));
}
