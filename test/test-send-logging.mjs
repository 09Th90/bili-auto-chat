/**
 * 发送日志自测：模拟本地桥返回成功/限流失败，检查发送日志字段。
 */
const state = {
  local: {},
  sync: {
    config: {
      enabled: true,
      mode: 'auto',
      ai: { baseUrl: 'http://x/v1', apiKey: '', model: 'test', temperature: 0.5, maxTokens: 100, systemPrompt: 'test' },
      api: { enabled: true, url: 'ws://127.0.0.1:8765/ws', token: 'test-token' },
      limits: { sendIntervalSec: 0, maxSendPerHour: 100, maxSendPerDay: 100, maxHistoryTurns: 6, maxReplyLength: 500 },
      filter: { skipKeywords: [], blacklistUsers: [], onlyQuestion: false },
      sources: {},
      watch: { videos: [], dynamics: [] },
    },
  },
};

function makeStorage(area) {
  return {
    async get(key) {
      if (typeof key === 'string') return { [key]: state[area][key] };
      const out = {};
      for (const k of Object.keys(key)) out[k] = state[area][k];
      return out;
    },
    async set(obj) {
      Object.assign(state[area], obj);
    },
  };
}

globalThis.chrome = {
  storage: { local: makeStorage('local'), sync: makeStorage('sync'), onChanged: { addListener() {} } },
  runtime: { getManifest: () => ({ version: 'test' }) },
  cookies: { get: async () => null },
  tabs: { query: async () => [], sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [] },
};

let mode = 'success';
globalThis.fetch = async (url) => {
  if (String(url).includes('/v1/send')) {
    if (mode === 'success') {
      return { status: 200, json: async () => ({ sent: true, code: 0, message: 'OK', data: { rpid: 123456 } }) };
    }
    return { status: 200, json: async () => ({ sent: false, code: -412, message: 'request was banned' }) };
  }
  throw new Error('unexpected fetch ' + url);
};

const { sendReply } = await import('../background/dispatch.js');
const { getLogs } = await import('../background/store.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, detail); }
}

const payload = {
  text: '日志测试回复',
  chatKey: 'comment:1:2',
  incomingText: '测试消息',
  replyPayload: { replyType: 1, oid: '1', root: '2', parent: '2' },
};

mode = 'success';
const sent = await sendReply(payload);
let logs = await getLogs();
const start = logs.find((l) => l.msg === '发送开始' && l.meta?.trigger === 'agent');
const api = logs.find((l) => l.msg === '发送接口返回' && l.meta?.code === 0);
const success = logs.find((l) => l.msg === '发送成功' && l.meta?.rpid === 123456);

ok('发送结果成功', sent?.sent === true, JSON.stringify(sent));
ok('发送开始带 trigger/目标', !!start && start.meta.kind === 'comment' && start.meta.target?.oid === '1');
ok('发送接口返回带通道/耗时', !!api && api.meta.channel === 'local-bridge' && typeof api.meta.apiElapsedMs === 'number');
ok('发送成功带 rpid/端到端耗时', !!success && success.meta.ok === true && typeof success.meta.totalElapsedMs === 'number');

mode = 'fail';
const failed = await sendReply({ ...payload, text: '日志失败测试' });
logs = await getLogs();
const failure = [...logs].reverse().find((l) => l.msg.includes('发送被风控') && l.meta?.code === -412);

ok('发送失败返回错误', !!failed?.error, JSON.stringify(failed));
ok('失败日志带阶段/原因/退避', !!failure && failure.meta.ok === false && failure.meta.stage === 'local-bridge'
  && failure.meta.message.includes('banned') && failure.meta.backoffMin > 0
  && failure.meta.nextRetryAt > Date.now());

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
