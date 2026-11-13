/**
 * 发送分发器：生成回复后的统一出口。
 * - auto 模式：过频控后直接发送；不满足频控则暂存 outbox 等待下轮
 * - confirm 模式：写入 outbox 草稿，等用户确认
 * 确认/发送成功后才把这一轮（user + assistant）写入会话历史。
 */
import { getConfig } from './config.js';
import {
  addOutbox, getOutbox, updateOutbox, removeOutbox,
  addLog, appendHistory, bumpSendCount, getSendStats,
  recordSendResult, getCircuit, resetCircuit, noteSendAttempt,
  chatKeyForDm, chatKeyForComment, patchInbox,
} from './store.js';
import { generateReply, cleanReply } from './ai/reply-engine.js';
import {
  addReply, sendDm, getNav, getVideoInfo, getDynamicDetail, getLastChannel,
  addReplyCookie, sendDmCookie,
} from './bilibili/api.js';
import { shouldBackoff, reportRateLimit, backoffRemainingSec, isRateLimitMessage } from './backoff.js';

// 无论配置里填多小，两次发送至少隔 10s；太密会直接吃 -412
const MIN_SEND_INTERVAL_SEC = 10;
const SEND_TIMEOUT_MS = 60_000;
const STALE_PENDING_MS = 90_000;

let myUidCache = 0;

export async function getMyUid() {
  if (myUidCache) return myUidCache;
  const nav = await getNav();
  myUidCache = nav?.data?.mid || 0;
  return myUidCache;
}

/** 过滤：黑名单/关键词/只回提问 */
/** 去掉 emoji、颜文字、图片/表情标记、空白后是否还有可回复的文字 */
export function hasRealText(text) {
  const t = String(text || '')
    // B 站图片/表情占位标记
    .replace(/\[[^\]]{0,12}\]/g, '') // [图片][表情][doge] 等方括号标记
    .replace(/【[^】]{0,12}】/g, '') // 【图片】等
    // emoji（含变体、组合、旗帜）
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    // 常见空白与零宽字符
    .replace(/[\s​-‍﻿]/g, '');
  return t.trim().length >= 2; // 至少 2 个字才算有内容
}

export function shouldSkip(config, text, uid) {
  const f = config.filter || {};
  if ((f.blacklistUsers || []).map(Number).includes(Number(uid))) return '黑名单用户';
  const t = String(text || '');
  // 无实质文字（纯表情/图片/空白）不回，避免瞎脑补
  if (!hasRealText(t)) return '无文字内容（表情/图片）';
  for (const kw of f.skipKeywords || []) {
    if (kw && t.includes(kw)) return `命中过滤词「${kw}」`;
  }
  if (f.onlyQuestion && !/[?？]/.test(t)) return '未含提问（仅回复提问模式）';
  return null;
}

/** 已知失败码的人话提示 */
function sendErrorHint(code) {
  if ([-412, -352, -351].includes(Number(code))) return 'B站风控拦截，暂停几分钟后再试';
  if (Number(code) === -101) return '未登录或登录态失效';
  if (Number(code) === -111) return 'csrf 校验失败（bili_jct 丢失）';
  if (Number(code) === 12002) return '该内容评论区已关闭';
  if (Number(code) === 12009) return 'oid/type 不匹配（目标类型识别错误）';
  if (Number(code) === 12014) return '评论发送过于频繁';
  if (Number(code) === 12015) return '需要先在网页端手动发一条完成验证';
  return '';
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label || 'timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// 旧草稿可能带着错误的 type（例如把视频记成动态），发送前修正
const targetCache = new Map();
async function resolveCommentTarget(oid, type) {
  const key = `${type}:${oid}`;
  if (targetCache.has(key)) return targetCache.get(key);
  let out = { oid: String(oid), type: Number(type) || 1 };
  if (out.type !== 1) {
    try {
      const v = await getVideoInfo({ aid: oid });
      if (v?.code === 0 && v?.data?.aid) {
        out = { oid: String(v.data.aid), type: 1 };
      } else {
        const d = await getDynamicDetail(String(oid));
        const basic = d?.data?.item?.basic;
        const coid = String(basic?.comment_id_str || basic?.rid_str || '');
        const ctype = Number(basic?.comment_type) || 0;
        if (d?.code === 0 && coid && ctype) out = { oid: coid, type: ctype };
      }
    } catch {
      /* 解析失败就保持原参数，让 B 站返回明确错误 */
    }
  }
  targetCache.set(key, out);
  return out;
}

/** 频控检查：返回 null=可发，否则返回不可发原因。发送间隔带随机抖动防风控 */
export async function checkRateLimit(config, kind = 'global', { ignoreInterval = false } = {}) {
  const circuit = await getCircuit(kind);
  if (circuit.open) return `已熔断：${circuit.reason}`;
  const s = await getSendStats();
  const lim = config.limits;
  if (s.sentHour >= lim.maxSendPerHour) return '达到每小时上限';
  if (s.sentDay >= lim.maxSendPerDay) return '达到每日上限';
  if (ignoreInterval) return null; // 用户手动确认 = 主动重试，不受自动间隔限制
  // 发送间隔 ±30% 随机抖动，避免固定频率被识别为机器人
  const base = Math.max(Number(lim.sendIntervalSec) || 0, MIN_SEND_INTERVAL_SEC);
  const jitter = base * (0.7 + Math.random() * 0.6);
  const wait = (s.lastSendAt || 0) + jitter * 1000 - Date.now();
  if (wait > 0) return `发送间隔未到（约 ${Math.ceil(wait / 1000)}s）`;
  return null;
}

/** 由本地桥接服务执行真实发送（参考 dsh-bili-interactor：直接用 Cookie 发请求） */
function bridgeHttpBase(apiUrl) {
  try {
    const u = new URL(apiUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    return u.origin;
  } catch {
    return '';
  }
}

async function sendViaLocalBridge(item, config) {
  const base = bridgeHttpBase(config.api?.url);
  if (!base || !config.api?.token) return { reachable: false };
  const payload = {
    text: item.text,
    chatKey: item.chatKey,
    incomingText: item.incomingText,
    speakerName: item.speakerName,
    sceneLabel: item.sceneLabel,
    replyPayload:
      item.kind === 'dm'
        ? { kind: 'dm', senderUid: item.senderUid, receiverId: item.receiverId }
        : { replyType: item.replyType, oid: item.oid, root: item.root, parent: item.parent },
  };
  try {
    const res = await withTimeout(
      fetch(`${base}/v1/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.api.token}`,
        },
        body: JSON.stringify(payload),
      }),
      35_000,
      'local-bridge-timeout'
    );
    if (res.status === 503) return { reachable: false };
    const data = await res.json().catch(() => ({}));
    if (data.sent) return { reachable: true, ok: true, data: data.data, code: 0 };
    return { reachable: true, ok: false, code: data.code, message: data.message };
  } catch {
    return { reachable: false };
  }
}

async function syncInboxItem(item, patch) {
  if (!item?.dedupeId) return;
  try {
    await patchInbox(item.dedupeId, patch);
  } catch { /* 记账失败不影响发送结果 */ }
}

/** 实际发送一条 outbox 项 */
async function doSend(item, { trigger = 'auto' } = {}) {
  const kind = item.kind === 'dm' ? 'dm' : 'comment';
  const totalStart = Number(item.receivedAt) || Number(item.createdAt) || Date.now();
  const target = kind === 'dm'
    ? { receiverId: item.receiverId }
    : { type: item.replyType, oid: item.oid, root: item.root, parent: item.parent };
  const baseMeta = {
    dedupeId: item.dedupeId,
    outboxId: item.id,
    kind,
    trigger,
    target,
    textLen: String(item.text || '').length,
  };

  // 防风控：发送前检查该通道退避，被封期间不发（不占用发送间隔）
  const backoff = backoffRemainingSec(`send:${kind}`);
  if (backoff > 0) {
    await addLog('warn', '发送通道退避中', `${kind} ${backoff}s 后恢复，暂不发送`, {
      ...baseMeta,
      reason: 'send-backoff',
      remainingSec: backoff,
      nextRetryAt: Date.now() + backoff * 1000,
    });
    return false;
  }
  await noteSendAttempt(); // 任何真实发送尝试（含失败）都占用发送间隔，防止连发轰炸
  const tStart = Date.now();
  await addLog('info', '发送开始', `${item.sceneLabel || item.chatKey} → ${String(item.text || '').slice(0, 30)}`, {
    ...baseMeta,
    queuedMs: tStart - totalStart,
  });

  let resp = null;
  let channel = '';
  let stage = 'prepare';
  let targetElapsedMs = 0;
  let apiElapsedMs = 0;
  try {
    const config = await getConfig();

    // 首选本地桥接执行器：直接用扩展导出的 Cookie 发请求，不受页面注入权限影响
    let localOffline = false;
    if (config.api?.enabled && config.api?.token) {
      stage = 'local-bridge';
      const tLocal = Date.now();
      const local = await sendViaLocalBridge(item, config);
      apiElapsedMs += Date.now() - tLocal;
      if (local.reachable) {
        channel = 'local-bridge';
        resp = local.ok ? { code: 0, data: local.data } : { code: local.code, message: local.message };
      } else {
        localOffline = true;
        await addLog('warn', '本地发送桥未运行', '改试扩展直连 Cookie 发送', {
          ...baseMeta,
          stage: 'local-bridge',
          channel: 'local-bridge-offline',
        });
      }
    }

    // 第二条通道：扩展直连 Cookie（DNR 注入 Cookie），不需要桥接/页面权限
    if (!resp) {
      try {
        stage = 'cookie-direct';
        const tCookie = Date.now();
        if (kind === 'dm') {
          resp = await withTimeout(
            sendDmCookie({
              senderUid: item.senderUid,
              receiverId: item.receiverId,
              content: item.text,
            }),
            SEND_TIMEOUT_MS,
            'send-timeout(私信/直连)'
          );
        } else {
          stage = 'target-resolve';
          const tTarget = Date.now();
          const before = { type: item.replyType, oid: item.oid };
          const resolved = await resolveCommentTarget(item.oid, item.replyType);
          targetElapsedMs = Date.now() - tTarget;
          if (Number(resolved.type) !== Number(item.replyType) || String(resolved.oid) !== String(item.oid)) {
            item.replyType = resolved.type;
            item.oid = resolved.oid;
            await updateOutbox(item.id, { replyType: resolved.type, oid: resolved.oid });
            await addLog('info', '发送目标已修正', `oid=${resolved.oid} type=${resolved.type}`, {
              ...baseMeta, from: before, to: { type: resolved.type, oid: resolved.oid }, elapsedMs: targetElapsedMs,
            });
          }
          stage = 'cookie-direct';
          resp = await withTimeout(
            addReplyCookie({
              type: item.replyType,
              oid: item.oid,
              message: item.text,
              root: item.root || 0,
              parent: item.parent || 0,
            }),
            SEND_TIMEOUT_MS,
            'send-timeout(评论/直连)'
          );
        }
        apiElapsedMs += Date.now() - tCookie;
        channel = 'cookie-direct';
      } catch (e) {
        await addLog('warn', '扩展直连 Cookie 发送失败', String(e.message || e), {
          ...baseMeta,
          ok: false,
          stage: 'cookie-direct',
          error: String(e.message || e),
        });
        if (localOffline) {
          const reason = `本地桥未运行，扩展直连 Cookie 也失败：${String(e.message || e)}`;
          await addLog('error', '发送通道不可用', reason, {
            ...baseMeta, ok: false, stage: 'cookie-direct', channel: 'unavailable',
          });
          await syncInboxItem(item, { status: 'failed', reason, outboxId: item.id, replyText: item.text });
          return false;
        }
      }
    }

    // 最后兜底：页面桥（仅当没有配置本地桥时；避免桥离线时误撞 -412）
    if (!resp) {
      if (kind === 'dm') {
        stage = 'api';
        const tApi = Date.now();
        resp = await withTimeout(
          sendDm({
            senderUid: item.senderUid,
            receiverId: item.receiverId,
            content: item.text,
          }),
          SEND_TIMEOUT_MS,
          'send-timeout(私信)'
        );
        apiElapsedMs += Date.now() - tApi;
      } else {
        stage = 'target-resolve';
        const tTarget = Date.now();
        const resolved = await resolveCommentTarget(item.oid, item.replyType);
        targetElapsedMs = Date.now() - tTarget;
        if (Number(resolved.type) !== Number(item.replyType) || String(resolved.oid) !== String(item.oid)) {
          item.replyType = resolved.type;
          item.oid = resolved.oid;
          await updateOutbox(item.id, { replyType: resolved.type, oid: resolved.oid });
          await addLog('info', '发送目标已修正', `oid=${resolved.oid} type=${resolved.type}`, {
            ...baseMeta, from: { type: item.replyType, oid: item.oid }, to: { type: resolved.type, oid: resolved.oid }, elapsedMs: targetElapsedMs,
          });
        }
        stage = 'api';
        const tApi = Date.now();
        resp = await withTimeout(
          addReply({
            type: item.replyType,
            oid: item.oid,
            message: item.text,
            root: item.root || 0,
            parent: item.parent || 0,
          }),
          SEND_TIMEOUT_MS,
          'send-timeout(评论)'
        );
        apiElapsedMs += Date.now() - tApi;
      }
      channel = getLastChannel();
    }

    await addLog('info', '发送接口返回', `kind=${kind} code=${resp?.code} 通道=${channel} 接口${apiElapsedMs}ms`, {
      ...baseMeta, code: resp?.code, channel, stage, apiElapsedMs, targetElapsedMs,
    });

    if (resp?.code !== 0) {
      const hint = sendErrorHint(resp?.code);
      const message = resp?.message || '';
      const isRisk = shouldBackoff(resp?.code) || isRateLimitMessage(message);
      let backoffMin = 0;
      let nextRetryAt = 0;
      if (isRisk) {
        backoffMin = reportRateLimit(`send:${kind}`, resp?.code, message);
        nextRetryAt = Date.now() + backoffMin * 60_000;
      }
      const detail = `B站接口 code=${resp?.code} ${message}${hint ? `（${hint}）` : ''}`;
      await recordSendResult(kind, false, detail);
      await addLog('error', isRisk ? '发送被风控，暂停发送' : '发送失败', detail, {
        ...baseMeta,
        ok: false,
        stage,
        code: resp?.code,
        message,
        hint,
        channel,
        apiElapsedMs,
        targetElapsedMs,
        totalElapsedMs: Date.now() - totalStart,
        backoffMin,
        nextRetryAt,
        retryCount: item.retryCount || 0,
      });
      await syncInboxItem(item, { status: 'failed', reason: detail, outboxId: item.id, replyText: item.text });
      return false;
    }

    await recordSendResult(kind, true);
    await bumpSendCount();
    // 这一轮写入会话历史
    await appendHistory(item.chatKey, [
      { role: 'user', content: item.incomingText, ts: item.createdAt },
      { role: 'assistant', content: item.text, ts: Date.now() },
    ], (await getConfig()).limits.maxHistoryTurns);

    const data = resp?.data || {};
    const rpid = data.rpid || data.rpid_str || data.reply?.rpid || data.reply?.rpid_str || null;
    const msgKey = data.msg_key || data.msg_key_str || data.msg_id || null;
    await addLog('info', '发送成功', `${item.sceneLabel || item.chatKey} → ${String(item.text || '').slice(0, 40)}`, {
      ...baseMeta,
      ok: true,
      code: 0,
      channel,
      rpid,
      msgKey,
      apiElapsedMs,
      targetElapsedMs,
      totalElapsedMs: Date.now() - totalStart,
      retryCount: item.retryCount || 0,
    });
    await syncInboxItem(item, { status: 'sent', outboxId: item.id, replyText: item.text, verifiedAt: Date.now(), reason: '' });
    return true;
  } catch (e) {
    const message = String(e.message || e);
    if (/timeout/i.test(message)) stage = 'timeout';
    else if (stage === 'prepare') stage = 'exception';
    await recordSendResult(kind, false, message);
    await addLog('error', '发送异常', `${kind}: ${message}`, {
      ...baseMeta,
      ok: false,
      stage,
      error: message,
      channel,
      apiElapsedMs,
      targetElapsedMs,
      totalElapsedMs: Date.now() - totalStart,
      retryCount: item.retryCount || 0,
    });
    await syncInboxItem(item, { status: 'failed', reason: message, outboxId: item.id, replyText: item.text });
    return false;
  }
}

/**
 * 统一入口：收到一条别人的消息，生成回复并按模式分发。
 * @param {object} p
 * @param {string} p.chatKey
 * @param {string} p.dedupeId        去重 id（调用前已处理的不在这里查）
 * @param {string} p.text            对方消息
 * @param {string} [p.speakerName]
 * @param {string|number} [p.speakerUid]
 * @param {object} p.scene           { kind:'comment'|'dm', title? }
 * @param {object} p.replyPayload    发送参数：
 *   评论：{ replyType, oid, root, parent }；私信：{ kind:'dm', senderUid, receiverId }
 * @param {string} [p.sceneLabel]    日志显示名
 */
export async function handleIncoming(p) {
  const receivedAt = Date.now();
  const config = await getConfig();
  const kind = p.replyPayload?.kind === 'dm' ? 'dm' : 'comment';
  const source = p.source || (p.scene?.kind === 'dm' ? 'dm' : 'comment');
  const baseMeta = {
    dedupeId: p.dedupeId,
    source,
    chatKey: p.chatKey,
    kind,
    sceneLabel: p.sceneLabel,
    speakerUid: p.speakerUid,
    textLen: String(p.text || '').length,
  };

  if (!config.enabled) {
    if (p.dedupeId) await patchInbox(p.dedupeId, { status: 'skipped', reason: '总开关关闭' });
    await addLog('info', '跳过消息', `${p.sceneLabel || ''} 总开关关闭`, { ...baseMeta, reason: '总开关关闭' });
    return { skipped: '总开关关闭' };
  }

  const skip = shouldSkip(config, p.text, p.speakerUid);
  if (skip) {
    if (p.dedupeId) await patchInbox(p.dedupeId, { status: 'skipped', reason: skip });
    await addLog('info', '跳过消息', `${p.sceneLabel || ''} ${skip}`, { ...baseMeta, reason: skip });
    return { skipped: skip };
  }

  await addLog('info', '收到消息', `${p.sceneLabel || p.chatKey}【${p.speakerName || '?'}】${String(p.text).slice(0, 60)}`, baseMeta);

  const tGen = Date.now();
  let aiElapsedMs = 0;
  let reply;
  try {
    reply = await generateReply({
      config,
      chatKey: p.chatKey,
      scene: p.scene,
      incomingText: p.text,
      speakerName: p.speakerName,
    });
    aiElapsedMs = Date.now() - tGen;
    await addLog('info', 'AI 生成完成', `${aiElapsedMs}ms，${reply?.length || 0} 字`, {
      ...baseMeta, elapsedMs: aiElapsedMs, model: config.ai.model, replyLen: reply?.length || 0,
    });
  } catch (e) {
    aiElapsedMs = Date.now() - tGen;
    const message = String(e.message || e);
    if (p.dedupeId) await patchInbox(p.dedupeId, { status: 'error', reason: message });
    await addLog('error', 'AI 生成失败', message, {
      ...baseMeta, elapsedMs: aiElapsedMs, model: config.ai.model, error: message,
    });
    return { error: message };
  }
  if (!reply) {
    if (p.dedupeId) await patchInbox(p.dedupeId, { status: 'error', reason: 'empty reply' });
    await addLog('warn', 'AI 返回空', p.chatKey, {
      ...baseMeta, elapsedMs: aiElapsedMs, model: config.ai.model,
    });
    return { error: 'empty reply' };
  }

  const item = {
    chatKey: p.chatKey,
    kind,
    text: reply,
    incomingText: p.text,
    speakerName: p.speakerName,
    sceneLabel: p.sceneLabel,
    createdAt: Date.now(),
    receivedAt,
    source,
    dedupeId: p.dedupeId,
    status: 'pending',
    ...(kind === 'dm'
      ? { senderUid: p.replyPayload.senderUid, receiverId: p.replyPayload.receiverId }
      : { replyType: p.replyPayload.replyType, oid: p.replyPayload.oid, root: p.replyPayload.root, parent: p.replyPayload.parent }),
  };

  if (config.mode === 'auto') {
    const limit = await checkRateLimit(config, item.kind);
    if (limit) {
      item.status = 'queued';
      item.queuedReason = limit;
      const saved = await addOutbox(item);
      if (p.dedupeId) await patchInbox(p.dedupeId, { status: 'queued', reason: limit, outboxId: saved.id, replyText: reply });
      await addLog('info', '排队等待发送', limit, {
        ...baseMeta, outboxId: saved.id, reason: limit, aiElapsedMs, totalElapsedMs: Date.now() - receivedAt,
      });
      return { queued: limit, reply };
    }
    const saved = await addOutbox(item);
    const ok = await doSend(saved, { trigger: 'auto' });
    if (ok) {
      await removeOutbox(saved.id);
      if (p.dedupeId) await patchInbox(p.dedupeId, { status: 'sent', outboxId: saved.id, replyText: reply, verifiedAt: Date.now(), reason: '' });
    } else {
      await updateOutbox(saved.id, { status: 'failed', error: '发送失败，见日志' });
      if (p.dedupeId) await patchInbox(p.dedupeId, { status: 'failed', outboxId: saved.id, replyText: reply, reason: '发送失败，见日志' });
    }
    return ok ? { sent: true, reply } : { failed: true, reply };
  }

  // confirm 模式：草稿等确认
  item.status = 'draft';
  const saved = await addOutbox(item);
  if (p.dedupeId) await patchInbox(p.dedupeId, { status: 'draft', outboxId: saved.id, replyText: reply });
  await addLog('info', '生成草稿待确认', `${p.sceneLabel || ''} → ${reply.slice(0, 40)}`, {
    ...baseMeta, outboxId: saved.id, aiElapsedMs, totalElapsedMs: Date.now() - receivedAt,
  });
  return { drafted: true, reply };
}

/**
 * 第三方 Agent 直接发送：不生成、不改写，按给定目标立即发出去。
 * 仍然遵守每小时/每天上限；手动确认语义会复位对应通道的熔断。
 */
export async function sendReply(p) {
  const config = await getConfig();
  if (!config.enabled) return { error: '总开关关闭' };
  if (!p?.text) return { error: '缺少 text' };

  const payload = p.replyPayload || {};
  const kind = payload.kind === 'dm' ? 'dm' : 'comment';
  if (kind === 'dm' && !payload.receiverId) return { error: '缺少 receiverId' };
  if (kind === 'comment' && (!payload.oid || !payload.replyType)) return { error: '缺少 oid/replyType' };

  let senderUid = payload.senderUid;
  if (kind === 'dm' && !senderUid) senderUid = await getMyUid();
  if (kind === 'dm' && !senderUid) return { error: '无法获取自己的 UID（登录态失效？）' };

  const item = {
    chatKey:
      p.chatKey ||
      (kind === 'dm'
        ? chatKeyForDm(payload.receiverId)
        : chatKeyForComment(String(payload.oid), payload.root || payload.parent || 0)),
    kind,
    text: cleanReply(p.text, config.limits.maxReplyLength), // 按句边界截断，不静默丢字
    incomingText: p.incomingText || '',
    speakerName: p.speakerName,
    sceneLabel: p.sceneLabel || (kind === 'dm' ? `Agent私信[${payload.receiverId}]` : `Agent评论[${payload.oid}]`),
    createdAt: Date.now(),
    status: 'pending',
    ...(kind === 'dm'
      ? { senderUid, receiverId: String(payload.receiverId) }
      : {
          replyType: Number(payload.replyType),
          oid: String(payload.oid),
          root: payload.root || 0,
          parent: payload.parent || 0,
        }),
  };

  const saved = await addOutbox(item);
  const result = await confirmSend(saved.id, item.text, 'agent');
  return { ...result, id: saved.id, text: item.text };
}

/** 用户在 popup 确认发送（可编辑后发送）。手动确认 = 主动重试，自动复位熔断 */
export async function confirmSend(id, editedText, trigger = 'manual') {
  await addLog('info', '确认发送请求', `id=${id}`, { outboxId: id, trigger });
  const outbox = await getOutbox();
  const item = outbox.find((o) => o.id === id);
  if (!item) return { error: '草稿不存在' };
  if (editedText != null) item.text = editedText;
  const kind = item.kind === 'dm' ? 'dm' : 'comment';

  const circuit = await getCircuit(kind);
  if (circuit.open) {
    await resetCircuit(kind);
    await addLog('info', '熔断已复位', `手动确认发送视为 ${kind} 通道重试`, {
      outboxId: id, kind, trigger, reason: circuit.reason,
    });
  }

  const limit = await checkRateLimit(await getConfig(), kind, { ignoreInterval: true });
  if (limit) {
    await addLog('warn', '发送被频控拦截', limit, { outboxId: id, kind, trigger, reason: limit });
    return { error: limit };
  }

  await addLog('info', '开始发送', `${item.sceneLabel || ''} → ${item.text.slice(0, 30)}`, {
    outboxId: id, kind, trigger, queuedMs: Date.now() - (item.createdAt || Date.now()),
  });
  const ok = await doSend(item, { trigger });
  if (ok) await removeOutbox(id);
  else await updateOutbox(id, { status: 'failed', error: '发送失败，见日志' });
  return ok ? { sent: true } : { error: '发送失败，见日志' };
}

/**
 * SW 被回收时正在发送的草稿会永远停在 pending。
 * 启动/扫描时把超时的 pending 转成 failed，让用户能手动重试。
 */
export async function reconcileOutbox() {
  const outbox = await getOutbox();
  for (const item of outbox) {
    if (item.status !== 'pending') continue;
    if (Date.now() - (item.createdAt || 0) <= STALE_PENDING_MS) continue;
    await updateOutbox(item.id, {
      status: 'failed',
      error: '上次发送中断（后台被回收），可手动重试',
    });
    if (item.dedupeId) {
      await patchInbox(item.dedupeId, {
        status: 'failed', reason: '上次发送中断（后台被回收），可手动重试',
        outboxId: item.id, replyText: item.text,
      });
    }
    await addLog('warn', '恢复卡死草稿', `${item.sceneLabel || item.chatKey}：发送中断，已转为失败待重试`, {
      outboxId: item.id, ageMs: Date.now() - (item.createdAt || 0),
      from: 'pending', to: 'failed',
    });
  }
}

/** 处理 auto 模式下排队的项（只重发 queued；failed 等人工确认，避免连发触发风控） */
export async function flushQueue() {
  const stats = { attempted: 0, sent: 0, failed: 0, skipped: 0, elapsedMs: 0 };
  const t0 = Date.now();
  const config = await getConfig();
  if (!config.enabled || config.mode !== 'auto') {
    stats.elapsedMs = Date.now() - t0;
    return stats;
  }
  const outbox = await getOutbox();
  const queued = outbox.filter((o) => o.status === 'queued');
  for (const item of queued) {
    const kind = item.kind === 'dm' ? 'dm' : 'comment';
    const limit = await checkRateLimit(config, kind);
    if (limit) {
      stats.skipped = queued.length - stats.attempted;
      break;
    }
    stats.attempted++;
    const ok = await doSend(item, { trigger: 'auto-queue' });
    if (ok) {
      stats.sent++;
      await removeOutbox(item.id);
    } else {
      stats.failed++;
      await updateOutbox(item.id, { status: 'failed', error: '发送失败，见日志' });
      stats.skipped = queued.length - stats.attempted;
      break;
    }
  }
  stats.elapsedMs = Date.now() - t0;
  return stats;
}
