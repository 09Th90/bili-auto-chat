const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Edg/131.0.0.0';
const { computeMixinKey, signParams } = await import('../background/bilibili/wbi.js');
const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: { 'User-Agent': UA } })).json();
const pick = (u) => u.split('/').pop().split('.')[0];
const mk = computeMixinKey(pick(nav.data.wbi_img.img_url), pick(nav.data.wbi_img.sub_url));

// 取任意公开动态看结构（用一个已知公开动态源：直接搜聚合流不可匿名，改测动态详情的 basic 字段）
// 先看 comment_type 在动态数据里的位置 —— 用 polymer detail
const oid = '1268264595162660873';
const p = signParams({ id: oid, features: 'itemOpusStyle' }, mk);
const r = await (await fetch('https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?' + new URLSearchParams(p), { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' } })).json();
console.log('detail code=' + r.code, r.message || '');
if (r.data?.item) {
  const b = r.data.item.basic || {};
  const m = r.data.item.modules || {};
  console.log('basic.comment_type =', b.comment_type, '| basic.rid_str =', b.rid_str, '| basic.comment_id_str =', b.comment_id_str);
  console.log('type =', r.data.item.type);
  console.log('keys(basic) =', Object.keys(b).join(','));
  console.log('keys(item) =', Object.keys(r.data.item).join(','));
}
