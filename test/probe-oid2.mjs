const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Edg/131.0.0.0';
const { computeMixinKey, signParams } = await import('../background/bilibili/wbi.js');
// 用 wbi 签名请求动态详情
const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: { 'User-Agent': UA } })).json();
const pick = (u) => u.split('/').pop().split('.')[0];
const mk = computeMixinKey(pick(nav.data.wbi_img.img_url), pick(nav.data.wbi_img.sub_url));
const oid = '1268264595162660873';

// 测动态详情（wbi）
const p1 = signParams({ id: oid, timezone_offset: -480, features: 'itemOpusStyle' }, mk);
const d = await (await fetch('https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?' + new URLSearchParams(p1), { headers: { 'User-Agent': UA, Referer: 'https://t.bilibili.com/' } })).json();
console.log('动态详情 code=' + d.code, d.message || '');
if (d.data?.item) {
  const basic = d.data.item.basic || {};
  console.log('  → comment_type =', basic.comment_type, '| rid_str =', basic.rid_str, '| comment_id_str =', basic.comment_id_str, '| type =', d.data.item.type);
  // 用 basic 给的 comment_type + rid 试评论
  const ctype = basic.comment_type;
  const coid = basic.comment_id_str || basic.rid_str || oid;
  const p2 = signParams({ oid: coid, type: ctype, mode: 3, plat: 1, web_location: 1315875, pagination_str: '{"offset":""}' }, mk);
  const c = await (await fetch('https://api.bilibili.com/x/v2/reply/wbi/main?' + new URLSearchParams(p2), { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' } })).json();
  console.log('  → 用 comment_type=' + ctype + ' oid=' + coid + ' 查评论: code=' + c.code, 'replies=' + (c.data?.replies?.length ?? '-'), c.message || '');
} else {
  console.log('  → 该 oid 无动态数据（可能已删/非动态/无权限）');
}
