/** 配置迁移：旧默认 120→1800，自定义值保留，幂等 */
const sync = { config: { limits: { pollIntervalSec: 120, maxVideosPerScan: 5 }, enabled: true } };
const writes = [];
globalThis.chrome = {
  storage: {
    sync: {
      async get(key) {
        if (typeof key === 'string') return { [key]: sync[key] };
        return { ...sync };
      },
      async set(obj) {
        writes.push(obj);
        Object.assign(sync, obj);
      },
    },
  },
};

const { getConfig } = await import('../background/config.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, detail); }
}

const c1 = await getConfig();
ok('旧默认 120 → 1800', c1.limits.pollIntervalSec === 1800, String(c1.limits.pollIntervalSec));
ok('maxVideosPerScan 5 → 3', c1.limits.maxVideosPerScan === 3, String(c1.limits.maxVideosPerScan));
ok('写入 configVersion=2', sync.config.configVersion === 2, JSON.stringify(sync.config.configVersion));
ok('只迁移写一次', writes.length === 1, String(writes.length));

const c2 = await getConfig();
ok('幂等：第二次不再写', writes.length === 1, String(writes.length));
ok('第二次仍是 1800', c2.limits.pollIntervalSec === 1800);

// 自定义 900 保留
sync.config = { configVersion: 1, limits: { pollIntervalSec: 900, maxVideosPerScan: 2 } };
writes.length = 0;
const c3 = await getConfig();
ok('已有 configVersion 的自定义 900 保留', c3.limits.pollIntervalSec === 900, String(c3.limits.pollIntervalSec));
ok('已有版本不再迁移写', writes.length === 0, String(writes.length));

// 空配置走新默认
sync.config = {};
writes.length = 0;
const c4 = await getConfig();
ok('空配置默认 1800', c4.limits.pollIntervalSec === 1800, String(c4.limits.pollIntervalSec));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
