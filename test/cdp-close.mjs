// 关闭所有我用 CDP 开的 chrome-extension 废页
const r = await fetch(`http://127.0.0.1:9222/json`);
const targets = await r.json();
const junk = targets.filter((t) => t.url && t.url.includes('chrome-extension://lbjaejphdjahdkajciiehbjoemabihke'));
console.log('待清理的废页:', junk.length, '个');
for (const t of junk) {
  await fetch(`http://127.0.0.1:9222/json/close/${t.id}`);
  console.log('已关闭:', t.url.slice(0, 55));
}
const r2 = await fetch(`http://127.0.0.1:9222/json`);
const left = await r2.json();
console.log('剩余目标:', left.length);
left.forEach((t) => console.log(' ', (t.url || '').slice(0, 55)));
