/**
 * 消息中心目标解析自测：subject_type 不能直接当评论 type。
 * 414932549 是视频 aid（旧草稿被记成 type=11 的案例），必须解析成 type=1。
 */
globalThis.chrome = {
  storage: {
    local: { async get() { return {}; }, async set() {} },
    sync: { async get() { return {}; }, async set() {} },
    onChanged: { addListener() {} },
  },
  runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} }, getManifest: () => ({ version: 'test' }) },
  alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  cookies: { async get() { return null; } },
  tabs: { async query() { return []; } },
  scripting: { async executeScript() { return []; } },
};

const NAV = {
  code: 0,
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  },
};

globalThis.fetch = async (url) => {
  const u = String(url);
  let data = { code: -404, message: 'not found' };
  if (u.includes('/x/web-interface/nav')) data = NAV;
  else if (u.includes('/x/web-interface/view') && u.includes('aid=414932549')) {
    data = { code: 0, data: { aid: 414932549, title: '视频' } };
  } else if (u.includes('/x/polymer/web-dynamic/v1/detail') && u.includes('id=999999999')) {
    data = { code: 0, data: { item: { basic: { comment_id_str: '123456789', comment_type: 11 } } } };
  } else if (u.includes('/x/v2/reply/wbi/main') && u.includes('oid=777777')) {
    data = { code: 0, data: { replies: [] } };
  } else if (u.includes('/x/v2/reply/wbi/main') && u.includes('oid=414855396') && u.includes('type=11')) {
    data = { code: 0, data: { replies: [] } };
  }
  return { ok: true, status: 200, json: async () => data };
};

const { resolveMsgfeedTarget } = await import('../background/pollers/msgfeed.js');
const { setRequestGapMs } = await import('../background/bilibili/api.js');
setRequestGapMs(0);

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, detail); }
}

const video = await resolveMsgfeedTarget('414932549', 11);
ok('视频 aid + subject_type=11 → type 1（不再误判动态）', video?.type === 1 && video?.oid === '414932549', JSON.stringify(video));

const dyn = await resolveMsgfeedTarget('999999999', 17);
ok('动态 id → 用 basic.comment_id_str/comment_type', dyn?.oid === '123456789' && dyn?.type === 11, JSON.stringify(dyn));

const article = await resolveMsgfeedTarget('777777', 12);
ok('专栏兜底：评论区探测成功则透传', article?.oid === '777777' && article?.type === 12, JSON.stringify(article));

// 消息中心 business_id=11 + subject_id=动态评论 rid 的真实案例
const dynRid = await resolveMsgfeedTarget('414855396', 11);
ok('business_id=11 的动态评论 rid 可解析', dynRid?.oid === '414855396' && dynRid?.type === 11, JSON.stringify(dynRid));

const unknown = await resolveMsgfeedTarget('555555', 3);
ok('无法识别时返回 null（不生成垃圾草稿）', unknown === null, JSON.stringify(unknown));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
