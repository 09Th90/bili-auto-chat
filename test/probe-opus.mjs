const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Edg/131.0.0.0';
const { computeMixinKey, signParams } = await import('../background/bilibili/wbi.js');
const oid = '1268264595162660873';
const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: { 'User-Agent': UA } })).json();
const pick = (u) => u.split('/').pop().split('.')[0];
const mk = computeMixinKey(pick(nav.data.wbi_img.img_url), pick(nav.data.wbi_img.sub_url));

// 1. opus 详情（wbi）
const p1 = signParams({ id: oid, timezone_offset: -480 }, mk);
const d = await (await fetch('https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?' + new URLSearchParams(p1), {
  headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
})).json();
console.log('opus详情 code=' + d.code, (d.message||'').slice(0,20));
const item = d.data?.item;
if (item) {
  console.log('  type =', item.type);
  console.log('  basic =', JSON.stringify(item.basic || {}));
  const b = item.basic || {};
  console.log('  ★ comment_type =', b.comment_type, '| rid_str =', b.rid_str, '| comment_id_str =', b.comment_id_str);
  // 用 basic 的 comment_type + oid 查评论
  const ctype = b.comment_type || 17;
  const coid = b.comment_id_str || b.rid_str || oid;
  const p2 = signParams({ oid: coid, type: ctype, mode: 3, plat: 1, web_location: 1315875, pagination_str: '{"offset":""}' }, mk);
  const c = await (await fetch('https://api.bilibili.com/x/v2/reply/wbi/main?' + new URLSearchParams(p2), {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
  })).json();
  console.log('  ★ 用 comment_type=' + ctype + ' oid=' + coid + ' 查评论: code=' + c.code, 'replies=' + (c.data?.replies?.length ?? '-'), (c.message||'').slice(0,15));
} else {
  console.log('  → 无数据（风控或已删）');
}
