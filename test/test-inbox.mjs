/** inbox 状态机 + processFeed 重试 + 限流识别 */
const store = { local: {} };
globalThis.chrome = {
  storage: {
    local: {
      async get(k) {
        if (typeof k === 'string') return { [k]: store.local[k] };
        const out = {};
        for (const x of Object.keys(k)) out[x] = store.local[x];
        return out;
      },
      async set(o) { Object.assign(store.local, o); },
    },
    sync: { async get() { return {}; }, async set() {} },
  },
  runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} }, getManifest: () => ({ version: 't' }) },
  alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  cookies: { async get() { return null; } },
};

const { upsertInbox, patchInbox, getInbox, getInboxStats, getScanState } = await import('../background/store.js');
const { processFeed } = await import('../background/pollers/util.js');
const { isRateLimitedResp, reportReadLimit, readCooldownRemainingSec } = await import('../background/backoff.js');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, detail); }
};

// inbox 基础
await upsertInbox({ id: 'a1', source: 'dm', kind: 'dm', incomingText: '你好', status: 'pending' });
ok('upsert 新增', (await getInbox()).length === 1);
await patchInbox('a1', { status: 'sent' });
ok('patch 为 sent', (await getInbox())[0].status === 'sent');
ok('stats open=0', (await getInboxStats()).open === 0);

// processFeed：AI error 不永久去重，下一轮可重试；sent 后去重
let calls = 0;
const item = {
  dedupeId: 'p1',
  ts: Date.now() + 5000,
  text: '测试消息',
  chatKey: 'dm:2',
  replyPayload: { kind: 'dm', senderUid: 1, receiverId: 2 },
};
const handler = async () => {
  calls++;
  return calls === 1 ? { error: 'boom' } : { sent: true, reply: '好' };
};
await processFeed('dm:2', [item], handler, { sinceField: 'ts' });
ok('第一次 error，inbox=error', (await getInbox()).find((x) => x.id === 'p1')?.status === 'error');
ok('error 未标记 processed', !(store.local.processed || []).includes('p1'), JSON.stringify(store.local.processed));
await processFeed('dm:2', [item], handler, { sinceField: 'ts' });
ok('第二次自动重试成功', calls === 2 && (await getInbox()).find((x) => x.id === 'p1')?.status === 'sent');
await processFeed('dm:2', [item], handler, { sinceField: 'ts' });
ok('sent 后不再重复处理', calls === 2);

// 基线写 skipped
const oldItem = { dedupeId: 'b1', ts: Date.now() - 10000, text: '旧消息', chatKey: 'dm:3' };
await processFeed('dm:3', [oldItem], async () => { throw new Error('should not handle'); }, { sinceField: 'ts' });
ok('基线消息写 skipped', (await getInbox()).find((x) => x.id === 'b1')?.status === 'skipped');

// 限流识别与全局冷却
ok('识别 rate-limited-self', isRateLimitedResp({ code: 0, message: 'rate-limited-self: 请求过于密集，已保护性跳过' }));
ok('识别 -412', isRateLimitedResp({ code: -412, message: 'request was banned' }));
ok('普通响应不误判', !isRateLimitedResp({ code: 0, message: 'OK' }));
const mins = await reportReadLimit();
ok('冷却分钟数 >= 5', mins >= 5, String(mins));
ok('冷却剩余秒 > 0', (await readCooldownRemainingSec()) > 0);
ok('scanState 已落盘', (await getScanState()).readCooldownUntil > Date.now());

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
