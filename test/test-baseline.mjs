/**
 * 私信基线逻辑测试：验证"启动后新到的私信不被历史基线吞掉"。
 * node test/test-baseline.mjs
 */
const store = { local: {} };
globalThis.chrome = {
  storage: {
    local: {
      async get(k) { if (typeof k === 'string') return { [k]: store.local[k] }; const o = {}; for (const x of Object.keys(k)) o[x] = store.local[x]; return o; },
      async set(o) { Object.assign(store.local, o); },
    },
    sync: { async get() { return {}; }, async set() {} },
  },
  runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} }, getManifest: () => ({ version: '0.1.0' }) },
  alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  cookies: { async get() { return null; } }, tabs: { async query() { return []; } }, scripting: { async executeScript() { return []; } },
};

const { processFeed } = await import('../background/pollers/util.js');

let failed = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`, ok ? '' : `(实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)})`);
  if (!ok) failed++;
};

const base = Date.now(); // 模拟插件启动时刻

// 场景1：首轮有 3 条历史（启动前）+ 1 条启动后的新消息
{
  const handled = [];
  const items = [
    { dedupeId: 'd:1:m1@100', ts: base - 5000, text: '旧消息1' },
    { dedupeId: 'd:1:m2@200', ts: base - 3000, text: '旧消息2' },
    { dedupeId: 'd:1:m3@300', ts: base - 1000, text: '旧消息3' },
    { dedupeId: 'd:1:m4@400', ts: base + 2000, text: '启动后新消息' }, // 关键：启动之后
  ];
  await processFeed('dm:1', items, async (fresh) => handled.push(...fresh.map((i) => i.text)), { batch: true, sinceField: 'ts' });
  check('场景1 基线吞历史但保住启动后新消息', handled, ['启动后新消息']);
}

// 场景2：第二轮，纯新消息
{
  const handled = [];
  const items = [
    { dedupeId: 'd:1:m5@500', ts: base + 5000, text: '第二轮新消息' },
  ];
  await processFeed('dm:1', items, async (fresh) => handled.push(...fresh.map((i) => i.text)), { batch: true, sinceField: 'ts' });
  check('场景2 后续新消息正常回复', handled, ['第二轮新消息']);
}

// 场景3：重复消息不重复回复
{
  const handled = [];
  const items = [
    { dedupeId: 'd:1:m5@500', ts: base + 5000, text: '第二轮新消息' }, // 重复
  ];
  await processFeed('dm:1', items, async (fresh) => handled.push(...fresh.map((i) => i.text)), { batch: true, sinceField: 'ts' });
  check('场景3 重复消息去重', handled, []);
}

// 场景4：评论区（无时间字段）首轮全跳过
{
  const handled = [];
  const items = [
    { dedupeId: 'c:100:x', text: '旧评论' },
    { dedupeId: 'c:100:y', text: '旧评论2' },
  ];
  await processFeed('comments:100:1', items, async (i) => handled.push(i.text), { batch: false });
  check('场景4 评论首轮建基线全跳过', handled, []);
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
