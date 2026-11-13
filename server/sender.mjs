/**
 * 本地 B 站发送执行器（参考 acttk/dsh-bili-interactor 的做法）：
 * 不依赖浏览器页面/注入权限，直接用扩展导出的 Cookie + WBI 签名发请求。
 */
import { computeMixinKey, signParams, extractKeysFromNav } from '../background/bilibili/wbi.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

const BASE_HEADERS = { 'User-Agent': UA, Accept: 'application/json' };

function cookieHeader(cookies) {
  return Object.entries(cookies || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function request(url, { method = 'GET', headers = {}, body, timeout = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: { ...BASE_HEADERS, ...headers },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { code: -1, message: 'non-json', raw: text.slice(0, 300) };
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

let wbiCache = { mixin: '', at: 0 };

async function getMixinKey(cookies) {
  if (wbiCache.mixin && Date.now() - wbiCache.at < 30 * 60_000) return wbiCache.mixin;
  const { json } = await request('https://api.bilibili.com/x/web-interface/nav', {
    headers: {
      Cookie: cookieHeader(cookies),
      Referer: 'https://www.bilibili.com/',
    },
  });
  const { imgKey, subKey } = extractKeysFromNav(json?.data || {});
  const mixin = computeMixinKey(imgKey, subKey);
  wbiCache = { mixin, at: Date.now() };
  return mixin;
}

function qs(params) {
  return new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
  ).toString();
}

/** 发评论 / 楼中楼回复 */
export async function sendComment({ type, oid, message, root = 0, parent = 0 }, cookies) {
  const csrf = cookies?.bili_jct;
  if (!csrf) return { code: -111, message: '缺少 bili_jct（扩展未登录？）' };
  if (!type || !oid || !message) return { code: -400, message: '缺少 type/oid/message' };

  const mixin = await getMixinKey(cookies);
  const signed = signParams({ web_location: 1550101 }, mixin);
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

  const { json } = await request(`https://api.bilibili.com/x/v2/reply/add?${qs(signed)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader(cookies),
      Referer: 'https://www.bilibili.com/',
      Origin: 'https://www.bilibili.com',
    },
    body: form,
  });
  return json;
}

/** 发私信 */
export async function sendDm({ senderUid, receiverId, content }, cookies) {
  const csrf = cookies?.bili_jct;
  if (!csrf) return { code: -111, message: '缺少 bili_jct（扩展未登录？）' };
  const sender = String(senderUid || cookies?.DedeUserID || '');
  if (!sender || sender === '0') return { code: -400, message: '缺少自己的 UID' };
  if (!receiverId || !content) return { code: -400, message: '缺少 receiverId/content' };

  const mixin = await getMixinKey(cookies);
  const signed = signParams({ sender_uid: sender, receiver_id: receiverId, web_location: 1550101 }, mixin);
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

  const { json } = await request(`https://api.vc.bilibili.com/web_im/v1/web_im/send_msg?${qs(signed)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader(cookies),
      Referer: 'https://message.bilibili.com/',
      Origin: 'https://message.bilibili.com',
    },
    body: form,
  });
  return json;
}

/** 统一入口：根据 replyPayload 判断评论还是私信 */
export async function sendDirect(body, cookies) {
  const payload = body?.replyPayload || {};
  const kind = payload.kind === 'dm' || (!payload.replyType && (payload.receiverId || body?.receiverId)) ? 'dm' : 'comment';
  if (kind === 'dm') {
    return sendDm(
      {
        senderUid: payload.senderUid ?? body?.senderUid,
        receiverId: payload.receiverId ?? body?.receiverId,
        content: body?.text ?? body?.content,
      },
      cookies
    );
  }
  return sendComment(
    {
      type: payload.replyType ?? body?.replyType,
      oid: payload.oid ?? body?.oid,
      message: body?.text ?? body?.message,
      root: payload.root ?? body?.root,
      parent: payload.parent ?? body?.parent,
    },
    cookies
  );
}

/** 回读楼中楼（公开接口，不需要 Cookie） */
export async function getReplies({ oid, type, root, pn = 1, ps = 20 }) {
  const { json } = await request(
    `https://api.bilibili.com/x/v2/reply/reply?oid=${encodeURIComponent(oid)}&type=${encodeURIComponent(type)}&root=${encodeURIComponent(root)}&pn=${pn}&ps=${ps}`
  );
  return json;
}
