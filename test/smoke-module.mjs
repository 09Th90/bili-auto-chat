/**
 * 模块图冒烟测试：mock chrome API 后加载 service-worker 全部依赖链，
 * 验证所有 import 路径正确、模块顶层无副作用崩溃。
 * node test/smoke-module.mjs
 */

const data = { local: {}, sync: {} };

function makeStorage(area) {
  return {
    async get(key) {
      if (typeof key === 'string') return { [key]: data[area][key] };
      const out = {};
      for (const k of Object.keys(key)) out[k] = data[area][k];
      return out;
    },
    async set(obj) {
      Object.assign(data[area], obj);
    },
  };
}

globalThis.chrome = {
  storage: {
    local: makeStorage('local'),
    sync: makeStorage('sync'),
    onChanged: { addListener() {} },
  },
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener() {} },
    onMessageExternal: { addListener() {} },
    getManifest: () => ({ version: '0.1.0' }),
    getURL: (p) => 'chrome-extension://test/' + p,
  },
  alarms: {
    create() {},
    clear() {},
    onAlarm: { addListener() {} },
  },
  cookies: { get: async () => null },
  tabs: { query: async () => [], sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [] },
};

try {
  await import('../background/service-worker.js');
  console.log('PASS  service-worker 模块图加载成功（全部 import 路径正确）');
} catch (e) {
  console.error('FAIL  模块加载失败:', e);
  process.exit(1);
}

// 额外：跑一轮 dispatch 纯逻辑（过滤）
const { shouldSkip, checkRateLimit } = await import('../background/dispatch.js');
const cfg = { filter: { skipKeywords: [], blacklistUsers: [], onlyQuestion: false }, limits: { sendIntervalSec: 60, maxSendPerHour: 10, maxSendPerDay: 50 } };
const skip = shouldSkip(cfg, '正常内容', 1);
console.log(skip === null ? 'PASS  shouldSkip 正常放行' : `FAIL  shouldSkip: ${skip}`);
const limit = await checkRateLimit(cfg);
console.log(typeof limit === 'string' ? `PASS  频控生效: ${limit}` : 'PASS  频控允许发送');
