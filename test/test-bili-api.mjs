/**
 * B 站接口实测（匿名）：验证 nav → wbi 签名 → 评论拉取链路。
 * node test/test-bili-api.mjs
 */
import { md5 } from '../lib/md5.js';
import { computeMixinKey, signParams, extractKeysFromNav } from '../background/bilibili/wbi.js';

const API = 'https://api.bilibili.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

async function get(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const res = await fetch(`${API}${path}?${qs}`, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      Origin: 'https://www.bilibili.com',
      Accept: 'application/json',
    },
  });
  return res.json();
}

// 1. nav（匿名）拿 wbi keys
const nav = await get('/x/web-interface/nav');
console.log('nav code =', nav.code, '| isLogin =', nav.data?.isLogin, '| uname =', nav.data?.uname || '(匿名)');
const { imgKey, subKey } = extractKeysFromNav(nav.data || {});
const mixinKey = computeMixinKey(imgKey, subKey);
console.log('imgKey =', imgKey, '| mixinKey =', mixinKey);

// 2. view 拿 aid（用 av170001）
const view = await get('/x/web-interface/view', { aid: 170001 });
console.log('view code =', view.code, '| title =', view.data?.title, '| aid =', view.data?.aid);
const aid = view.data?.aid;

// 3. 拉评论（与插件 getComments 完全相同的参数）
const params = {
  oid: aid,
  type: 1,
  mode: 3,
  plat: 1,
  web_location: 1315875,
  pagination_str: JSON.stringify({ offset: '' }),
};
const signed = signParams(params, mixinKey);
const comments = await get('/x/v2/reply/wbi/main', signed);
console.log('comments code =', comments.code, '| message =', comments.message || '(无)');
const replies = comments.data?.replies || [];
console.log('replies 数量 =', replies.length);
if (replies.length) {
  const r = replies[0];
  console.log('首条: rpid =', r.rpid_str || r.rpid, '| root =', r.root, '| uname =', r.member?.uname);
  console.log('  内容 =', String(r.content?.message || '').slice(0, 50));
  console.log('  楼中楼预览 =', (r.replies || []).length, '条');
}

// 4. 楼中楼接口（与插件 getReplies 相同参数）
if (replies.length) {
  const root = replies[0].rpid_str || replies[0].rpid;
  const sub = signParams({ oid: aid, type: 1, root, pn: 1, ps: 5, web_location: 1315875 }, mixinKey);
  const subResp = await get('/x/v2/reply/reply', sub);
  console.log('楼中楼 code =', subResp.code, '| 数量 =', (subResp.data?.replies || []).length);
}

// 5. 消息中心（匿名应返回 -101，验证接口存在）
const msgfeed = await get('/x/msgfeed/reply', { plat: 1, web_location: 1315875, build: 0, mobi_app: 'web', cursor: 0 });
console.log('msgfeed/reply code =', msgfeed.code, '(匿名应为 -101)', '| message =', msgfeed.message || '');
