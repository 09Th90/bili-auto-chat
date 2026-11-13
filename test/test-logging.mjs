/**
 * 日志基础设施自测：meta、截断、容量、限流消息分类。
 */
const data = { logs: [] };
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return { [key]: data[key] };
        const out = {};
        for (const k of Object.keys(key)) out[k] = data[k];
        return out;
      },
      async set(obj) {
        Object.assign(data, obj);
      },
    },
  },
};

const { addLog, getLogs } = await import('../background/store.js');
const {
  isRateLimitMessage, reportRateLimitMessage, getBackoffInfo, backoffRemainingSec, reportRateLimit,
} = await import('../background/backoff.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, detail); }
}

await addLog('info', '扫描完成', '耗时 1.2s', { ok: true, elapsedMs: 1200, source: 'comments:video' });
let logs = await getLogs();
ok('meta 持久化', logs.at(-1)?.meta?.elapsedMs === 1200 && logs.at(-1)?.meta?.source === 'comments:video');

await addLog('error', '发送失败', 'x'.repeat(1200), { ok: false, stage: 'api', code: -412 });
logs = await getLogs();
ok('detail 截断到 1000', logs.at(-1)?.detail?.length === 1000);
ok('失败 meta 保留', logs.at(-1)?.meta?.stage === 'api' && logs.at(-1)?.meta?.code === -412);

await addLog('info', '大 meta', 'x', { blob: 'a'.repeat(3000) });
logs = await getLogs();
ok('超大 meta 截断标记', logs.at(-1)?.meta?.truncated === true && typeof logs.at(-1)?.meta?.preview === 'string');

for (let i = 0; i < 510; i++) await addLog('info', `批量${i}`, 'x');
logs = await getLogs();
ok('日志容量上限 500', logs.length === 500, String(logs.length));

ok('识别 rate-limited-self', isRateLimitMessage('rate-limited-self: 请求过于密集，已保护性跳过'));
ok('识别保护性跳过', isRateLimitMessage('请求过于密集，已保护性跳过'));
ok('普通错误不算限流', !isRateLimitMessage('B站接口 code=-101 未登录'));

const info = reportRateLimitMessage('dm:test', 'rate-limited-self: 请求过于密集，已保护性跳过');
ok('消息限流返回退避', info && info.minutes >= 3 && info.blockedUntil > Date.now(), JSON.stringify(info));
ok('退避剩余时间 > 0', getBackoffInfo('dm:test').remainingSec > 0 && backoffRemainingSec('dm:test') > 0);
ok('非限流码不产生退避', reportRateLimit('normal:test', 0, '普通错误') === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
