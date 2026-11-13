// 用多组 type + 老版评论接口 + 动态详情交叉验证这个 oid
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Edg/131.0.0.0';
const { computeMixinKey, signParams } = await import('../background/bilibili/wbi.js');
const oid = '1268264595162660873';

const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: { 'User-Agent': UA } })).json();
const pick = (u) => u.split('/').pop().split('.')[0];
const mk = computeMixinKey(pick(nav.data.wbi_img.img_url), pick(nav.data.wbi_img.sub_url));
console.log('匿名测试（受限于风控，仅参考）\n');

// 老版评论接口（不需 wbi），测多个 type
for (const type of [1, 11, 12, 17]) {
  try {
    const r = await (await fetch(`https://api.bilibili.com/x/v2/reply?type=${type}&oid=${oid}&pn=1&ps=5`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
    })).json();
    console.log(`老接口 type=${type} → code=${r.code}`, (r.message||'').slice(0,15), '| replies=' + (r.data?.replies?.length ?? '-'));
  } catch (e) { console.log(`type=${type} ERR`, e.message); }
}
