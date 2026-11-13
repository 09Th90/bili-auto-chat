/**
 * 直连执行器：绕过浏览器 UI，直接调用插件代码模块跑「扫描私信 → 生成 → 发送」。
 * - mock chrome API，让 background 模块在 Node 里原样跑
 * - 登录态：从 Edge 浏览器 Cookie 库解密 bili_jct/SESSDATA（Windows DPAPI）
 * - 发送请求自动带上 Referer: https://message.bilibili.com/（规避 -412 风控）
 *
 * 用法：
 *   node test/direct-run.mjs scan     # 只扫描私信，看能识别到几条
 *   node test/direct-run.mjs send     # 扫描 + 对最新一条未回复私信生成并发送
 *   node test/direct-run.mjs test-ai  # 只测模型 API 连通
 *
 * 环境变量：
 *   DRY=1        只生成不真正发送（安全）
 *   MODEL=mock   用固定测试回复代替真实模型（模型服务没开时）
 */
import { readFileSync, copyFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const DRY = process.env.DRY === '1';
const USE_MOCK_MODEL = process.env.MODEL === 'mock';

/** ---------- 1. 从 Edge Cookie 库取 B 站 cookie（DPAPI 解密） ---------- */
function getBiliCookies() {
  const cookieDb = join(homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Network', 'Cookies');
  if (!existsSync(cookieDb)) throw new Error('Edge Cookie 库不存在：' + cookieDb);
  const tmp = mkdtempSync(join(tmpdir(), 'bili-cookie-'));
  const dbCopy = join(tmp, 'Cookies.db');
  copyFileSync(cookieDb, dbCopy); // 复制以免被 Edge 锁定

  const py = `
import sqlite3, json, base64
conn = sqlite3.connect(r"${dbCopy.replace(/\\/g, '\\\\')}")
rows = conn.execute(
    "SELECT host_key, name, length(encrypted_value), encrypted_value FROM cookies "
    "WHERE host_key LIKE '%bilibili.com' AND name IN ('bili_jct','SESSDATA','DedeUserID')"
).fetchall()
out = []
for host, name, _ln, enc in rows:
    if not enc:
        continue
    if enc[:3] in (b'v10', b'v11'):
        enc = enc[3:]  # 去掉 DPAPI 前缀
    try:
        import subprocess, os, tempfile
        # 用 Windows DPAPI 解密
        import ctypes, ctypes.wintypes as wt
        class DATA_BLOB(ctypes.Structure):
            _fields_ = [('cbData', wt.DWORD), ('pbData', ctypes.POINTER(ctypes.c_byte))]
        blob_in = DATA_BLOB(len(enc), ctypes.cast(ctypes.create_string_buffer(enc, len(enc)), ctypes.POINTER(ctypes.c_byte)))
        blob_out = DATA_BLOB()
        if ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)):
            raw = ctypes.string_at(blob_out.pbData, blob_out.cbData)
            out.append([host, name, raw.decode('utf-8', 'replace')])
    except Exception as e:
        out.append([host, name, 'ERR:' + str(e)])
print(json.dumps(out))
`;
  const result = execFileSync('python', ['-c', py], { encoding: 'utf8', maxBuffer: 1 << 20 });
  const rows = JSON.parse(result.trim());
  const map = {};
  for (const [host, name, value] of rows) {
    if (!String(value).startsWith('ERR:')) map[name] = value;
  }
  return map;
}

/** ---------- 2. mock chrome API，让插件模块可运行 ---------- */
const store = { local: {}, sync: {} };
function makeStorage(area) {
  return {
    async get(key) {
      if (typeof key === 'string') return { [key]: store[area][key] };
      const out = {};
      for (const k of Object.keys(key)) out[k] = store[area][k];
      return out;
    },
    async set(obj) { Object.assign(store[area], obj); },
  };
}
globalThis.chrome = {
  storage: { local: makeStorage('local'), sync: makeStorage('sync') },
  runtime: {
    onInstalled: { addListener() {} }, onStartup: { addListener() {} },
    onMessage: { addListener() {} }, getManifest: () => ({ version: '0.1.0' }),
  },
  alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  cookies: {
    async get({ name }) {
      const c = COOKIE[name];
      return c ? { name, value: c } : null;
    },
  },
  tabs: { query: async () => [] },
  scripting: { executeScript: async () => [] },
};

// 拦 fetch：所有 B 站请求强制带 Referer/Origin，规避 -412
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const isBili = /bilibili\.com/.test(url);
  const headers = { ...(init.headers || {}) };
  if (isBili) {
    headers['Referer'] = /api\.vc\.bilibili\.com/.test(url) ? 'https://message.bilibili.com/' : 'https://www.bilibili.com/';
    headers['Origin'] = /api\.vc\.bilibili\.com/.test(url) ? 'https://message.bilibili.com' : 'https://www.bilibili.com';
    headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
  }
  return origFetch(url, { ...init, headers });
};

/** ---------- 3. 加载插件模块 ---------- */
const { getConfig } = await import('../background/config.js');
const { getDmSessions, getDmHistory, sendDm, getNav } = await import('../background/bilibili/api.js');
const { getMyUid } = await import('../background/dispatch.js');
const { generateReply } = await import('../background/ai/reply-engine.js');
const { chatKeyForDm, getOutbox, addOutbox } = await import('../background/store.js');

const COOKIE = getBiliCookies();
console.log('[cookie] bili_jct:', COOKIE.bili_jct ? 'OK(' + COOKIE.bili_jct.length + ')' : 'MISSING',
  '| SESSDATA:', COOKIE.SESSDATA ? 'OK' : 'MISSING', '| DedeUserID:', COOKIE.DedeUserID || 'MISSING');
if (!COOKIE.bili_jct) { console.error('缺少 bili_jct，无法发送。请确认 Edge 已登录 B 站。'); process.exit(1); }

const mode = process.argv[2] || 'scan';
const config = await getConfig();

/** ---------- 模型：真实服务或 mock ---------- */
async function genReply(chatKey, text, speakerName) {
  if (USE_MOCK_MODEL) {
    return { mock: true, text: '嗯哼？你好呀~ 谁在找我咯？' };
  }
  // 真实调插件的 reply-engine（会走 openai.js 到 8770）
  const reply = await generateReply({ config, chatKey, scene: { kind: 'dm' }, incomingText: text, speakerName });
  return { mock: false, text: reply };
}

async function run() {
  // 测登录态
  const nav = await getNav();
  console.log('[nav] code=', nav?.code, 'isLogin=', nav?.data?.isLogin, 'uname=', nav?.data?.uname);
  if (!nav?.data?.isLogin) { console.error('B 站登录态无效（cookie 解密失败或未登录）'); return; }
  const myUid = await getMyUid();
  console.log('[nav] myUid =', myUid);

  if (mode === 'test-ai') {
    const r = await genReply('tmp:test', '你好', '测试');
    console.log('[ai]', r);
    return;
  }

  // 拉私信会话
  const sess = await getDmSessions();
  console.log('[sessions] code=', sess?.code, 'message=', sess?.message || '');
  const sessions = sess?.data?.session_list || [];
  console.log('[sessions] 会话数 =', sessions.length);
  for (const s of sessions.slice(0, 5)) {
    const last = s.last_msg || {};
    let text = '';
    try { text = JSON.parse(last.content || '{}').content || ''; } catch { text = String(last.content || '').slice(0, 30); }
    console.log('  - talker_id=', s.talker_id, '| name=', s.talker_name || s.talker_info?.uname || '?',
      '| unread=', s.unread_count, '| 最后:', String(text).slice(0, 30));
  }

  // 对每个会话拉历史，找最新一条「对方发的」私信
  const target = [];
  for (const s of sessions) {
    const talkerId = s.talker_id;
    if (Number(talkerId) === myUid) continue;
    const hist = await getDmHistory(talkerId, 10);
    if (hist?.code !== 0) { console.log('  [history] talker', talkerId, 'code=', hist?.code); continue; }
    const msgs = (hist?.data?.messages || []).map((m) => {
      let text = '';
      try { text = JSON.parse(m.content || '{}').content || ''; } catch { text = ''; }
      return { msgId: m.msg_key ?? m.msg_id, sender: m.sender_uid, text, ts: m.timestamp };
    });
    const fromThem = msgs.filter((m) => Number(m.sender) === Number(talkerId) && m.text);
    if (fromThem.length) {
      const latest = fromThem[fromThem.length - 1];
      target.push({ talkerId, name: s.talker_name || s.talker_info?.uname || 'UID' + talkerId, latest });
    }
  }
  console.log('\n[scan] 待回复会话 =', target.length);
  for (const t of target) console.log('  -', t.name, '说:', t.latest.text);

  if (mode === 'scan') return;

  // send 模式：对第一条待回复会话生成 + 发送
  const t = target[0];
  if (!t) { console.log('\n[send] 没有待回复的私信'); return; }
  const chatKey = chatKeyForDm(t.talkerId);
  console.log('\n[gen] 对', t.name, '说的「' + t.latest.text + '」生成回复…');
  let reply;
  try {
    reply = await genReply(chatKey, t.latest.text, t.name);
  } catch (e) {
    console.error('[gen] 失败:', e.message, '\n提示：若模型服务未开，用 MODEL=mock 代替');
    return;
  }
  console.log('[gen]', reply.mock ? '(mock)' : '(真实模型)', reply.text);

  if (DRY) {
    console.log('\n[send] DRY=1，未真正发送。真实发送去掉 DRY=1');
    return;
  }

  console.log('\n[send] 发送给', t.name, '(uid', t.talkerId, ')…');
  const resp = await sendDm({ senderUid: myUid, receiverId: t.talkerId, content: reply.text });
  console.log('[send] 结果 code=', resp?.code, 'message=', resp?.message || 'OK', 'data=', JSON.stringify(resp?.data || {}).slice(0, 120));
  if (resp?.code === 0) {
    const { appendHistory } = await import('../background/store.js');
    await appendHistory(chatKey, [
      { role: 'user', content: t.latest.text, ts: Date.now() },
      { role: 'assistant', content: reply.text, ts: Date.now() },
    ], config.limits.maxHistoryTurns);
    console.log('[send] ✅ 发送成功，已写入会话历史');
  }
}

run().catch((e) => { console.error('执行异常:', e); process.exit(1); });
