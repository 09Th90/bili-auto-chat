// 通过 CDP 连插件后台（service worker），执行指定命令
// 用法: node test/cdp-run.mjs <port> <action>
// action: scan | state | eval:<code>
const port = process.argv[2] || '9222';
const action = process.argv[3] || 'state';

async function getTargets() {
  const r = await fetch(`http://127.0.0.1:${port}/json`);
  return r.json();
}

// 找插件的 service worker（含 bili-auto-chat 或特定 ID）
async function findPluginSW() {
  const targets = await getTargets();
  // 插件 ID 之前见过 lbjaejphdjahdkajciiehbjoemabihke
  return targets.find((t) =>
    t.type === 'service_worker' &&
    (t.url.includes('lbjaejphdjahdkajciiehbjoemabihke') || t.url.includes('background'))
  );
}

const targets = await getTargets();
console.log(`端口 ${port} 目标 ${targets.length} 个:`);
targets.forEach((t) => console.log(' ', t.type, '|', (t.title || '').slice(0, 35), '|', (t.url || '').slice(0, 65)));
const sw = await findPluginSW();
console.log('\n插件 SW:', sw ? sw.url : '未找到');
if (!sw) { process.exit(1); }
console.log('WS:', sw.webSocketDebuggerUrl);
