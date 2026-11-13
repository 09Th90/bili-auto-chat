// 用 Edge cookie 实测消息中心各接口的真实返回结构
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

function getBiliCookies() {
  const db = join(homedir(), 'AppData/Local/Microsoft/Edge/User Data/Default/Network/Cookies');
  if (!existsSync(db)) throw new Error('无 Edge Cookie 库');
  const tmp = mkdtempSync(join(tmpdir(), 'ck-'));
  const c = join(tmp, 'C.db');
  // Edge 锁定 Cookies 文件，用 PowerShell 读字节绕过锁
  try {
    copyFileSync(db, c);
  } catch {
    const ps = `[IO.File]::ReadAllBytes('${db.replace(/\\/g, '\\\\')}') | Set-Content -Path '${c.replace(/\\/g, '\\\\')}' -Encoding Byte`;
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { maxBuffer: 1 << 24 });
  }
  const cPosix = c.replace(/\\/g, '/');
  const py = `
import sqlite3, json, ctypes, ctypes.wintypes as wt
class B(ctypes.Structure):
    _fields_=[('cbData',wt.DWORD),('pbData',ctypes.POINTER(ctypes.c_byte))]
conn=sqlite3.connect(r"${cPosix}")
out={}
for host,name,enc in conn.execute("SELECT host_key,name,encrypted_value FROM cookies WHERE host_key LIKE '%bilibili.com' AND name IN ('bili_jct','SESSDATA','DedeUserID')"):
    if not enc or enc[:3] not in (b'v10',b'v11'): continue
    enc=enc[3:]
    bi=B(len(enc),ctypes.cast(ctypes.create_string_buffer(enc,len(enc)),ctypes.POINTER(ctypes.c_byte)))
    bo=B()
    if ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(bi),None,None,None,None,0,ctypes.byref(bo)):
        out[name]=ctypes.string_at(bo.pbData,bo.cbData).decode('utf-8','replace')
print(json.dumps(out))
`;
  return JSON.parse(execFileSync('python', ['-c', py], { encoding: 'utf8' }).trim());
}

const ck = getBiliCookies();
console.log('cookie:', ck.SESSDATA ? 'OK' : 'MISSING', '| bili_jct:', ck.bili_jct ? 'OK' : 'MISSING');
const cookieStr = `SESSDATA=${ck.SESSDATA}; bili_jct=${ck.bili_jct}; DedeUserID=${ck.DedeUserID}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Edg/131.0.0.0';

async function probe(name, url) {
  try {
    const r = await (await fetch(url, {
      headers: { 'User-Agent': UA, Cookie: cookieStr, Referer: 'https://message.bilibili.com/', Accept: 'application/json' }
    })).json();
    console.log(`\n===== ${name} (code=${r.code}) =====`);
    if (r.code !== 0) { console.log('  ', r.message); return; }
    // 打印第一条 item 的完整字段结构
    const items = r.data?.items || r.data?.session_list || r.data?.messages || [];
    if (items.length) {
      console.log('  第一条完整字段:', JSON.stringify(items[0], null, 1).slice(0, 900));
    } else {
      console.log('  (空) data keys:', Object.keys(r.data || {}).join(','));
    }
  } catch (e) { console.log(name, 'ERR', e.message); }
}

await probe('回复我的', 'https://api.bilibili.com/x/msgfeed/reply?plat=1&web_location=1315875&build=0&mobi_app=web&cursor=0');
await probe('@我的', 'https://api.bilibili.com/x/msgfeed/at?plat=1&web_location=1315875&build=0&mobi_app=web&cursor=0');
