/**
 * B 站 web 接口封装。
 * 请求通道：优先 background 直连（credentials: 'include'），
 * 若返回 -101（疑似 cookie 未携带）自动降级到 content-script 页面桥（同站 fetch 必带 cookie）。
 */
import { computeMixinKey, signParams, extractKeysFromNav } from './wbi.js';
import { addLog } from '../store.js';
import { isRateLimitedResp, reportReadLimit } from '../backoff.js';

const API = 'https://api.bilibili.com';

/** ---------------- 基础请求 ---------------- */

const BILI_TAB_RE = /:\/\/([^/]+\.)?bilibili\.com\//;

/** 带超时的 fetch（默认 12s），防止挂起卡死整个扫描 */
async function fetchWithTimeout(url, init, ms = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 带超时的 tabs.sendMessage（默认 18s > 桥 fetch 15s，避免桥还在跑就砍断） */
function sendMessageWithTimeout(tabId, payload, ms = 18000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge-timeout')), ms);
    chrome.tabs.sendMessage(tabId, payload).then(
      (resp) => {
        clearTimeout(timer);
        resolve(resp);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// 防风控：所有 B 站请求串行起跑，默认间隔 700ms（带 ±20% 抖动）。
// 之前并发扫 10 个视频会立刻吃到 -412/-509，慢一点比被封强。
let requestGapMs = 700;
let nextRequestAt = 0;

export function setRequestGapMs(ms) {
  requestGapMs = Math.max(0, Number(ms) || 0);
}

async function pace() {
  const now = Date.now();
  const jitter = requestGapMs * (0.8 + Math.random() * 0.4);
  const slot = Math.max(now, nextRequestAt + jitter);
  nextRequestAt = slot;
  const wait = slot - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** 最近一次请求走的通道，失败时写进日志便于定位 */
export function getLastChannel() {
  return lastChannel;
}

/** B 站 rate-limited-self 经常只给 message：命中后落盘全局读取冷却 */
function noteReadLimit(data) {
  if (!isRateLimitedResp(data)) return data;
  setRequestGapMs(2000);
  reportReadLimit().catch(() => {});
  return data;
}

// 桥全不可用后短期缓存，避免每个请求都白白尝试一轮桥
let bridgeFailUntil = 0;

// 最近一次请求实际走的通道（诊断用：直连 / 页面桥）
let lastChannel = '';

/**
 * 向指定 tab 注入桥脚本（幂等），用于插件加载前就已打开的旧页面。
 */
async function ensureBridge(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/bili-bridge.js'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 页面桥通道：遍历所有 bilibili 标签页转发请求。
 * 对没有桥脚本的旧页面先自动补注（scripting.executeScript），再重试。
 */
/** 等标签页加载完成（发送用） */
async function waitTabReady(tabId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t?.status === 'complete') return true;
    } catch {
      return false;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * 发送类必须用对应来源的页面：
 * - 私信 → message.bilibili.com（Origin/Referer 一致，api.vc 才接受）
 * - 评论 → www.bilibili.com
 * 没有对应页面时创建一个后台标签页，发送完关闭。
 */
async function findSendTab(url) {
  const isDm = /api\.vc\.bilibili\.com/.test(url);
  const preferHost = isDm ? 'message.bilibili.com' : 'www.bilibili.com';
  const tabs = await chrome.tabs.query({});
  const bili = tabs.filter((t) => t.url && BILI_TAB_RE.test(t.url) && t.id !== undefined);
  const existing = bili.find((t) => t.url.includes(preferHost));
  if (existing) return { tab: existing, created: false };
  const target = isDm ? 'https://message.bilibili.com/' : 'https://www.bilibili.com/';
  const created = await chrome.tabs.create({ url: target, active: false });
  const ready = await waitTabReady(created.id, 15000);
  if (!ready) {
    try { await chrome.tabs.remove(created.id); } catch { /* ignore */ }
    throw new Error('send-tab-load-timeout');
  }
  return { tab: { id: created.id, url: target }, created: true };
}

/**
 * 在页面主世界直接 fetch：使用页面自身的 Cookie / Origin / Referer，
 * 不受 content script 监听器失效影响，也不需要注入桥脚本。
 */
async function mainWorldFetch(tabId, url, init) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (u, i) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const res = await fetch(u, {
          method: i.method || 'GET',
          headers: i.headers || {},
          body: i.body || undefined,
          credentials: 'include',
          signal: controller.signal,
        });
        const text = await res.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = { code: -1, message: 'non-json', raw: text.slice(0, 800) };
        }
        return { ok: res.ok, status: res.status, json };
      } catch (e) {
        return { ok: false, status: 0, json: { code: -1, message: String(e.message || e) } };
      } finally {
        clearTimeout(timer);
      }
    },
    args: [url, init],
  });
  const r = results?.[0]?.result;
  if (!r) throw new Error('main-world-no-result');
  return r;
}

/** 发送专用通道：单标签页、单次、主世界 fetch 优先，content script 兜底 */
async function bridgeSend(url, payload) {
  const { tab, created } = await findSendTab(url);
  try {
    try {
      const resp = await mainWorldFetch(tab.id, url, payload.init);
      if (resp?.json) {
        if (resp.json.code === -1 && /timeout|failed to fetch|networkerror/i.test(String(resp.json.message || ''))) {
          throw new Error(`main-world-fetch-failed: ${String(resp.json.message || '').slice(0, 80)}`);
        }
        lastChannel = `main:${tab.url || tab.id}`;
        return resp.json;
      }
    } catch (e) {
      try { await addLog('warn', '主世界发送失败，尝试页面桥', String(e.message || e).slice(0, 100)); } catch { /* ignore */ }
    }

    await ensureBridge(tab.id);
    await new Promise((r) => setTimeout(r, 250));
    const resp = await sendMessageWithTimeout(tab.id, payload, 15000);
    if (!resp?.json) throw new Error('bridge-empty-response');
    if (resp.json.code === -1 && /timeout|failed to fetch|networkerror/i.test(String(resp.json.message || ''))) {
      throw new Error(`bridge-fetch-failed: ${String(resp.json.message || '').slice(0, 80)}`);
    }
    lastChannel = `bridge:${tab.url || tab.id}`;
    return resp.json;
  } finally {
    if (created) {
      try { await chrome.tabs.remove(tab.id); } catch { /* ignore */ }
    }
  }
}

async function bridgeFetch(url, init, { maxTabs, probeBridge = false } = {}) {
  const payload = {
    type: 'bili-fetch',
    url,
    init: { method: init.method || 'GET', headers: init.headers || {}, body: init.body || null },
  };

  if (probeBridge) {
    try {
      return await bridgeSend(url, payload);
    } catch (e) {
      bridgeFailUntil = Date.now() + 60_000;
      try { await addLog('warn', '页面桥发送失败', String(e.message || e).slice(0, 120)); } catch { /* ignore */ }
      throw new Error(`bridge-unavailable: ${String(e.message || e)}`);
    }
  }

  // 读取类：遍历现有 B 站标签页，失败可注入后重试一次
  const tabs = await chrome.tabs.query({});
  let biliTabs = tabs.filter((t) => t.url && BILI_TAB_RE.test(t.url) && t.id !== undefined);
  if (!biliTabs.length) throw new Error('no-bilibili-tab');
  if (maxTabs && biliTabs.length > maxTabs) biliTabs = biliTabs.slice(0, maxTabs);

  const errors = [];
  for (const tab of biliTabs) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await sendMessageWithTimeout(tab.id, payload, 18000);
        if (resp?.json) {
          if (resp.json.code === -1 && /timeout|failed to fetch|networkerror/i.test(String(resp.json.message || ''))) {
            errors.push(`${tab.id}:bridge-fetch-failed`);
            break;
          }
          lastChannel = `bridge:${tab.url || tab.id}`;
          return resp.json;
        }
      } catch (e) {
        errors.push(`${tab.id}:${String(e.message || e).slice(0, 150)}`);
        if (attempt === 0) {
          await ensureBridge(tab.id);
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
      }
      break;
    }
  }
  bridgeFailUntil = Date.now() + 60_000;
  throw new Error(`bridge-unavailable${errors.length ? `: ${errors.slice(-10).join('; ')}` : ''}`);
}

/**
 * @param {string} path 如 /x/v2/reply/wbi/main；也接受完整 https URL（如 api.vc.bilibili.com 的私信接口）
 * @param {{method?:string, params?:object, form?:object}} opt
 */
export async function biliFetch(path, { method = 'GET', params, form, maxTabs, timeoutMs, preferBridge } = {}) {
  let url = /^https?:\/\//.test(path) ? path : API + path;
  if (params) {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
    ).toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  const init = {
    method,
    credentials: 'include',
    headers: { Accept: 'application/json' },
  };
  if (form) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(
      Object.entries(form).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
    ).toString();
  }

  await pace();

  // 发送类：必须每次尝试页面桥（带 cookie）。读取类的 bridgeFailUntil 缓存不能影响发送，
  // 否则扫描期间一次桥失败会让后续所有发送都走无登录态直连 → 必然 -412。
  if (preferBridge) {
    try {
      return noteReadLimit(await bridgeFetch(url, init, { maxTabs, probeBridge: true }));
    } catch (e) {
      try {
        await addLog('warn', '发送桥不可用，降级直连', String(e.message || e).slice(0, 120));
      } catch { /* 日志失败不影响 */ }
    }
  }

  // 通道 1：background 直连（公开接口可通；登录接口受 SameSite 影响可能 -101）
  let firstData = null;
  let firstError = null;
  try {
    lastChannel = 'direct';
    const res = await fetchWithTimeout(url, init, timeoutMs || 12000);
    const data = await res.json();
    if (data && data.code !== -101) {
      // 风控码：background 请求缺 Referer 易被拦，降级桥（带页面 Referer）再试一次
      if ([-412, -352, -509].includes(data.code) && Date.now() >= bridgeFailUntil) {
        try {
          return noteReadLimit(await bridgeFetch(url, init, { maxTabs }));
        } catch {
          return noteReadLimit(data);
        }
      }
      return noteReadLimit(data);
    }
    firstData = data; // -101 先留着，通道 2 失败时兜底返回
  } catch (e) {
    firstError = e;
  }

  // 通道 2：页面桥（同站 fetch 必带 cookie）；发送类已经在上面试过，不再重复
  if (!preferBridge && Date.now() >= bridgeFailUntil) {
    try {
      return noteReadLimit(await bridgeFetch(url, init, { maxTabs }));
    } catch {
      // fallthrough
    }
  }
  if (firstData) return noteReadLimit(firstData); // 至少返回真实 API 响应（如 -101），别让整个扫描炸掉
  throw firstError || new Error('bridge-unavailable');
}

/** ---------------- csrf ---------------- */

export async function getCsrf() {
  const cookie = await chrome.cookies.get({ url: 'https://www.bilibili.com', name: 'bili_jct' });
  return cookie?.value || '';
}

async function requireCsrf() {
  const csrf = await getCsrf();
  if (!csrf) throw new Error('缺少 bili_jct：未登录或 cookie 读取失败');
  return csrf;
}

/** ---------------- 扩展直连（无桥接）：DNR 注入 Cookie ---------------- */

const COOKIE_RULE_IDS = { comment: 9901, dm: 9902, probe: 9903 };

async function buildBiliCookieHeader() {
  const all = await chrome.cookies.getAll({ domain: 'bilibili.com' });
  const map = {};
  for (const c of all) {
    if (c.value) map[c.name] = c.value;
  }
  if (!map.SESSDATA || !map.bili_jct) throw new Error('缺少 SESSDATA/bili_jct，无法直连发送');
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * 不依赖页面/本地桥：用 declarativeNetRequest 在请求层写入 Cookie/Referer/Origin，
 * background 直连 B 站。适用于桥接服务没启动的情况。
 */
async function cookieFetch(url, { method = 'GET', headers = {}, body, referer, origin, ruleId } = {}) {
  const cookie = await buildBiliCookieHeader();
  const filter = /api\.vc\.bilibili\.com/.test(url)
    ? '||api.vc.bilibili.com/web_im/v1/web_im/send_msg'
    : /x\/web-interface\/nav/.test(url)
      ? '||api.bilibili.com/x/web-interface/nav'
      : '||api.bilibili.com/x/v2/reply/add';
  const id = ruleId || COOKIE_RULE_IDS.probe;
  const rule = {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Cookie', operation: 'set', value: cookie },
        { header: 'Referer', operation: 'set', value: referer || 'https://www.bilibili.com/' },
        { header: 'Origin', operation: 'set', value: origin || 'https://www.bilibili.com' },
      ],
    },
    condition: { urlFilter: filter, resourceTypes: ['xmlhttprequest', 'other'] },
  };
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id], addRules: [rule] });
  try {
    const res = await fetchWithTimeout(url, {
      method,
      credentials: 'omit',
      headers: { Accept: 'application/json', ...headers },
      body,
    }, 15000);
    return await res.json();
  } finally {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
  }
}

/** 诊断：用直连 Cookie 读登录态（不发送、不改数据） */
export async function cookieLoginTest() {
  return cookieFetch('https://api.bilibili.com/x/web-interface/nav', {
    referer: 'https://www.bilibili.com/',
    origin: 'https://www.bilibili.com',
    ruleId: COOKIE_RULE_IDS.probe,
  });
}

/** 直连 Cookie 发评论 */
export async function addReplyCookie({ type, oid, message, root = 0, parent = 0 }) {
  const csrf = await requireCsrf();
  const signed = await signWriteParams();
  const qs = new URLSearchParams(signed).toString();
  const form = new URLSearchParams({
    type: String(type),
    oid: String(oid),
    message: String(message),
    plat: '1',
    statistics: JSON.stringify({ appId: 100, platform: 5 }),
    gaia_source: 'main_web',
    root: String(root || 0),
    parent: String(parent || 0),
    csrf,
    csrf_token: csrf,
  }).toString();
  return cookieFetch(`https://api.bilibili.com/x/v2/reply/add?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    referer: 'https://www.bilibili.com/',
    origin: 'https://www.bilibili.com',
    ruleId: COOKIE_RULE_IDS.comment,
  });
}

/** 直连 Cookie 发私信 */
export async function sendDmCookie({ senderUid, receiverId, content }) {
  const csrf = await requireCsrf();
  const sender = String(senderUid || '');
  if (!sender) throw new Error('缺少自己的 UID');
  const signed = await signWriteParams({ sender_uid: sender, receiver_id: receiverId });
  const qs = new URLSearchParams(signed).toString();
  const form = new URLSearchParams({
    'msg[sender_uid]': sender,
    'msg[receiver_id]': String(receiverId),
    'msg[receiver_type]': '1',
    'msg[msg_type]': '1',
    'msg[msg_status]': '0',
    'msg[content]': JSON.stringify({ content }),
    'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
    'msg[new_face_version]': '0',
    'msg[dev_id]': '0',
    from_firework: '0',
    build: '0',
    mobi_app: 'web',
    csrf,
    csrf_token: csrf,
  }).toString();
  return cookieFetch(`https://api.vc.bilibili.com/web_im/v1/web_im/send_msg?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    referer: 'https://message.bilibili.com/',
    origin: 'https://message.bilibili.com',
    ruleId: COOKIE_RULE_IDS.dm,
  });
}

/** ---------------- WBI ---------------- */

let wbiCache = { key: '', at: 0 };

async function getMixinKey() {
  if (wbiCache.key && Date.now() - wbiCache.at < 30 * 60_000) return wbiCache.key;
  const nav = await biliFetch('/x/web-interface/nav');
  const { imgKey, subKey } = extractKeysFromNav(nav.data || {});
  const key = computeMixinKey(imgKey, subKey);
  wbiCache = { key, at: Date.now() };
  return key;
}

/** GET + WBI 签名 */
export async function wbiGet(path, params = {}) {
  const mixinKey = await getMixinKey();
  const signed = signParams(params, mixinKey);
  return biliFetch(path, { params: signed });
}

/**
 * 写接口的 WBI 签名参数（放 URL query，表单体不参与签名）。
 * 与 bilibili-api 17.x 一致：补 web_location=1550101，再签 wts/w_rid。
 */
async function signWriteParams(extra = {}) {
  const mixinKey = await getMixinKey();
  return signParams({ web_location: 1550101, ...extra }, mixinKey);
}

/** ---------------- 账号 ---------------- */

export async function getNav() {
  return biliFetch('/x/web-interface/nav');
}

/** ---------------- 稿件/动态 ---------------- */

/** 我的稿件列表（按发布时间倒序） */
export async function getMyArchives(mid, pn = 1, ps = 20) {
  return wbiGet('/x/space/wbi/arc/search', { mid, pn, ps, order: 'pubdate' });
}

/** 视频信息：换 aid/bvid */
export async function getVideoInfo({ bvid, aid }) {
  const params = bvid ? { bvid } : { aid };
  return biliFetch('/x/web-interface/view', { params });
}

/** 我的动态列表 */
export async function getMyDynamics(mid, offset = '') {
  return wbiGet('/x/polymer/web-dynamic/v1/feed/all', { host_mid: mid, offset, features: 'itemOpusStyle' });
}

/** 动态详情：拿 opus 的 basic.rid_str + basic.comment_type（评论区的真实 oid/type） */
export async function getDynamicDetail(dynamicId) {
  return wbiGet('/x/polymer/web-dynamic/v1/detail', { id: dynamicId, timezone_offset: -480, features: 'itemOpusStyle' });
}

/** ---------------- 评论区 ---------------- */

/**
 * 评论区一页（按时间序，拿到最新）。
 * type: 1=视频稿件(oid=aid) 11=动态(oid=动态id) 12=专栏
 */
export async function getComments(oid, type, offset = '') {
  return wbiGet('/x/v2/reply/wbi/main', {
    oid,
    type,
    mode: 3, // 按时间
    plat: 1,
    web_location: 1315875,
    pagination_str: JSON.stringify({ offset }),
  });
}

/** 楼中楼一页 */
export async function getReplies(oid, type, root, pn = 1, ps = 10) {
  return wbiGet('/x/v2/reply/reply', { oid, type, root, pn, ps, web_location: 1315875 });
}

/**
 * 发评论/楼中楼回复。
 * @param {{type:number, oid:string|number, message:string, root?:string|number, parent?:string|number}} p
 *   root=0 一级评论；root>0 时为楼中楼（parent=被回复的 rpid）
 */
export async function addReply({ type, oid, message, root = 0, parent = 0 }) {
  const csrf = await requireCsrf();
  // 评论写接口 17.x 起要求 WBI 签名（缺签名会被 WAF 直接 -412）。
  const signed = await signWriteParams();
  return biliFetch('/x/v2/reply/add', {
    method: 'POST',
    params: signed,
    maxTabs: 3,
    timeoutMs: 15000,
    preferBridge: true, // 发送走页面桥（带 cookie），避免 -101
    form: {
      type,
      oid,
      message,
      plat: 1,
      statistics: JSON.stringify({ appId: 100, platform: 5 }),
      gaia_source: 'main_web',
      root,
      parent,
      csrf,
      csrf_token: csrf,
    },
  });
}

/** 发送前预检目标评论区是否存在（避免把错误 type 直接打到发送接口） */
export async function probeCommentTarget(oid, type) {
  const resp = await getComments(String(oid), Number(type));
  if (resp?.code === 0) return { ok: true };
  return { ok: false, code: resp?.code, message: resp?.message || '' };
}

/** ---------------- 消息中心 ---------------- */

export async function getReplyMe(cursor = 0) {
  return biliFetch('/x/msgfeed/reply', {
    params: { plat: 1, web_location: 1315875, build: 0, mobi_app: 'web', cursor },
  });
}

export async function getAtMe(cursor = 0) {
  return biliFetch('/x/msgfeed/at', {
    params: { plat: 1, web_location: 1315875, build: 0, mobi_app: 'web', cursor },
  });
}

/** ---------------- 私信（api.vc.bilibili.com） ---------------- */

const VC = 'https://api.vc.bilibili.com';

export async function getDmSessions() {
  return biliFetch(`${VC}/session_svr/v1/session_svr/get_sessions`, {
    params: { session_type: 1, group_fold: 1, sort_rule: 2, build: 0, mobi_app: 'web', size: 20 },
  });
}

export async function getDmHistory(talkerId, size = 20, opts = {}) {
  return biliFetch(`${VC}/svr_sync/v1/svr_sync/fetch_session_msgs`, {
    params: { talker_id: talkerId, session_type: 1, size, sender_device_id: 1, build: 0, mobi_app: 'web' },
    maxTabs: opts.preferBridge ? 3 : 2,
    preferBridge: !!opts.preferBridge,
  });
}

/** 发私信（文本）。参数格式取自社区实现：msg[xxx] 嵌套表单 */
export async function sendDm({ senderUid, receiverId, content }) {
  const csrf = await requireCsrf();
  // 私信写接口同样要求 WBI；sender/receiver 同时放 query（官方 17.x 实现）。
  const signed = await signWriteParams({ sender_uid: senderUid, receiver_id: receiverId });
  return biliFetch(`${VC}/web_im/v1/web_im/send_msg`, {
    method: 'POST',
    params: signed,
    maxTabs: 3,
    timeoutMs: 15000,
    preferBridge: true, // 发送走页面桥（带 cookie）
    form: {
      'msg[sender_uid]': senderUid,
      'msg[receiver_id]': receiverId,
      'msg[receiver_type]': 1,
      'msg[msg_type]': 1,
      'msg[msg_status]': 0,
      'msg[content]': JSON.stringify({ content }),
      'msg[timestamp]': Math.floor(Date.now() / 1000),
      'msg[new_face_version]': 0,
      'msg[dev_id]': '0',
      from_firework: 0,
      build: 0,
      mobi_app: 'web',
      csrf_token: csrf,
      csrf,
    },
  });
}
