/**
 * 发送载荷自测：评论必须带 WBI（wts/w_rid/web_location）、statistics、gaia_source、csrf。
 * 用 mock chrome + mock 页面桥捕获真实发出的 URL 与表单。
 */
let sent = null;

globalThis.chrome = {
  storage: {
    local: { async get() { return {}; }, async set() {} },
    sync: { async get() { return {}; }, async set() {} },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
  cookies: { async get({ name }) { return name === 'bili_jct' ? { value: 'test-csrf' } : null; } },
  tabs: {
    async query() { return [{ id: 7, url: 'https://www.bilibili.com/video/BV1test' }]; },
    async sendMessage(tabId, payload) {
      if (String(payload.url).includes('/x/web-interface/nav')) {
        return {
          ok: true,
          status: 200,
          json: {
            code: 0,
            data: {
              wbi_img: {
                img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
                sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
              },
            },
          },
        };
      }
      sent = payload;
      return { ok: true, status: 200, json: { code: 0, data: { rpid: 123 } } };
    },
  },
  scripting: { async executeScript() { return []; } },
};

const { addReply, setRequestGapMs } = await import('../background/bilibili/api.js');
const { signParams } = await import('../background/bilibili/wbi.js');
const { md5 } = await import('../lib/md5.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, detail); }
}

setRequestGapMs(0);

// 1. WBI 签名向量（Python urllib.urlencode(sorted(params)) + mixin_key）
const signed = signParams({ web_location: 1550101 }, 'testmixin', 1700000000);
ok('wts 固定值', String(signed.wts) === '1700000000');
ok('web_location 保留', String(signed.web_location) === '1550101');
ok(
  'w_rid 与官方算法一致',
  signed.w_rid === md5('web_location=1550101&wts=1700000000testmixin'),
  signed.w_rid
);

// 2. 评论发送载荷
const resp = await addReply({
  type: 1,
  oid: '414932549',
  message: '测试回复',
  root: '323415338400',
  parent: '323422071392',
});
ok('接口返回透传', resp?.code === 0);
ok('确实经页面桥发出', !!sent);
if (sent) {
  const url = new URL(sent.url);
  ok('URL 带 web_location', url.searchParams.get('web_location') === '1550101');
  ok('URL 带 wts', !!url.searchParams.get('wts'));
  ok('URL 带 w_rid', (url.searchParams.get('w_rid') || '').length === 32, url.search);

  const body = new URLSearchParams(sent.init.body);
  ok('type 正确', body.get('type') === '1');
  ok('oid 正确', body.get('oid') === '414932549');
  ok('root/parent 正确', body.get('root') === '323415338400' && body.get('parent') === '323422071392');
  ok('csrf 非空', body.get('csrf') === 'test-csrf');
  ok('csrf_token 同步', body.get('csrf_token') === 'test-csrf');
  ok('statistics 为 JSON', body.get('statistics') === '{"appId":100,"platform":5}', body.get('statistics'));
  ok('gaia_source 正确', body.get('gaia_source') === 'main_web');
  ok('plat=1', body.get('plat') === '1');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
