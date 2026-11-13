/**
 * 消息中心轮询：回复我的 / @我的。
 * 从消息里还原评论线程（root/parent），接话进对应会话。
 */
import { getReplyMe, getAtMe, getVideoInfo, getDynamicDetail, getComments } from '../bilibili/api.js';
import { processFeed } from './util.js';
import { handleIncoming, getMyUid } from '../dispatch.js';
import { chatKeyForComment, addLog, patchInbox } from '../store.js';
import {
  shouldBackoff, reportRateLimit, reportOk, isRateLimitMessage, reportRateLimitMessage,
} from '../backoff.js';

// 评论区合法 type：1 视频 / 11 图文动态 / 12 专栏 / 17 文字动态 / 14 音频 / 19 歌单
const VALID_REPLY_TYPES = [1, 11, 12, 14, 17, 19];

/**
 * subject_type 是消息中心自己的枚举，不能直接当评论区的 type。
 * 以 subject_id 反查真实资源：先按视频 aid 查，再按动态 id 查，最后才兜底透传。
 */
const targetCache = new Map();
export async function resolveMsgfeedTarget(subjectId, subjectType) {
  const key = String(subjectId);
  if (targetCache.has(key)) return targetCache.get(key);
  let out = null;

  try {
    const v = await getVideoInfo({ aid: key });
    if (v?.code === 0 && v?.data?.aid) out = { oid: String(v.data.aid), type: 1 };
  } catch {
    /* 不是视频 */
  }

  if (!out) {
    try {
      const d = await getDynamicDetail(key);
      const basic = d?.data?.item?.basic;
      const oid = String(basic?.comment_id_str || basic?.rid_str || '');
      const type = Number(basic?.comment_type) || 0;
      if (d?.code === 0 && oid && type) out = { oid, type };
    } catch {
      /* 不是动态 */
    }
  }

  if (!out) {
    // 新版消息中心的 subject_type 常为 null；business_id 有时就是评论类型（1/11/12…）。
    // 仍不可靠时，直接对 subject_id 探测各评论 type，哪个能打开评论区就用哪个。
    const t = Number(subjectType);
    const candidates = VALID_REPLY_TYPES.includes(t)
      ? [t, ...VALID_REPLY_TYPES.filter((x) => x !== t)]
      : VALID_REPLY_TYPES;
    for (const type of candidates) {
      try {
        const c = await getComments(key, type);
        if (c?.code === 0) {
          out = { oid: key, type };
          break;
        }
      } catch {
        /* 继续试下一个 type */
      }
    }
  }

  targetCache.set(key, out);
  return out;
}

function parseMsgfeedItem(raw) {
  const it = raw.item || {};
  const user = raw.user || {};
  // 二级回复的 reply_id 是空的，真实回复 rpid 在 source_id；时间在消息外层 reply_time
  const replyId = String(
    it.reply_id_str || it.reply_id || it.source_id_str || it.source_id || it.target_id_str || it.target_id || ''
  );
  const targetId = String(it.target_id_str || it.target_id || '0');
  const rootId = String(it.root_id_str || it.root_id || '0');
  const subjectId = String(it.subject_id_str || it.subject_id || '');
  const threadRoot = rootId !== '0' ? rootId : targetId !== '0' ? targetId : replyId;
  const text = String(it.source_content || '')
    .replace(/^回复\s*@[^:：]*[:：]\s*/, '')
    .trim();
  return {
    replyId,
    subjectId,
    // business_id 在消息中心里是资源类型（视频=1、图文/文字动态=11/17、专栏=12…）
    subjectType: it.subject_type ?? it.business_id,
    text,
    title: it.title || it.desc || subjectId,
    speakerName: user.nickname,
    speakerUid: user.mid,
    threadRoot,
    parent: replyId, // 回复对方这条
    ts: Number(raw.reply_time || it.reply_time || 0) * 1000 || 0,
  };
}

async function scanMsgfeed(kind) {
  const t0 = Date.now();
  const fetcher = kind === 'at' ? getAtMe : getReplyMe;
  const sourceKey = `msgfeed:${kind}`;
  const api = kind === 'at' ? '/x/msgfeed/at' : '/x/msgfeed/reply';
  try {
    const tFetch = Date.now();
    const resp = await fetcher(0);
    const fetchMs = Date.now() - tFetch;
    if (resp?.code !== 0) {
      if (shouldBackoff(resp?.code)) {
        const mins = reportRateLimit(sourceKey, resp?.code, resp?.message);
        await addLog('warn', '消息中心限流，暂停扫描', `code=${resp?.code} ${resp?.message || ''}，退避约 ${mins} 分钟`, {
          source: sourceKey, api, code: resp?.code, message: resp?.message,
          backoffMin: mins, nextRetryAt: Date.now() + mins * 60_000, elapsedMs: fetchMs,
        });
      } else {
        await addLog('warn', '拉取消息失败', `${sourceKey} code=${resp?.code} ${resp?.message || ''}`, {
          source: sourceKey, api, code: resp?.code, message: resp?.message, elapsedMs: fetchMs,
        });
      }
      return;
    }
    const myUid = await getMyUid();
    reportOk(sourceKey);
    const rawItems = resp.data?.items || [];
    await addLog('info', '消息中心拉取完成', `${sourceKey} ${rawItems.length} 条，${fetchMs}ms`, {
      source: sourceKey, api, items: rawItems.length, elapsedMs: fetchMs,
    });
    const items = [];
    let skippedAt = 0;
    let targetMissing = 0;
    for (const raw of rawItems) {
      const m = parseMsgfeedItem(raw);
      if (!m.replyId || !m.subjectId || !m.text) continue;
      // @我的里只有评论类可回复；type 现在可能是 "reply"/"at" 字符串
      const itemType = String(raw.item?.type || '').toLowerCase();
      if (kind === 'at' && itemType && !/reply|at|comment/.test(itemType) && Number(raw.item?.business_id) !== 1) {
        skippedAt++;
        continue;
      }

      const target = await resolveMsgfeedTarget(m.subjectId, m.subjectType);
      if (!target) {
        targetMissing++;
        await addLog('warn', '消息中心目标无法识别', `subject_id=${m.subjectId} subject_type=${m.subjectType}`, {
          source: sourceKey, subjectId: m.subjectId, subjectType: m.subjectType,
          replyId: m.replyId, elapsedMs: Date.now() - t0,
        });
        continue;
      }

      items.push({
        // 与评论区轮询共用同一条评论的 key，避免消息中心/评论区各回一次
        dedupeId: `c:${target.oid}:${m.replyId}`,
        ts: m.ts,
        text: m.text,
        speakerName: m.speakerName,
        speakerUid: m.speakerUid,
        chatKey: chatKeyForComment(target.oid, m.threadRoot),
        scene: { kind: 'comment', title: m.title },
        sceneLabel: `${kind === 'at' ? '@我' : '回复我'}[${m.title || m.subjectId}]`,
        replyPayload: {
          replyType: target.type,
          oid: target.oid,
          root: m.threadRoot,
          parent: m.parent,
        },
      });
    }

    const tProcess = Date.now();
    await processFeed(sourceKey, items, async (item) => {
      if (Number(item.speakerUid) === myUid) {
        await patchInbox(item.dedupeId, { status: 'skipped', reason: '自己的消息' });
        return { skipped: '自己的消息' };
      }
      return handleIncoming(item);
    }, { sinceField: 'ts' });
    await addLog('info', '消息中心处理完成', `${sourceKey} 待处理 ${items.length} 条`, {
      source: sourceKey, rawItems: rawItems.length, items: items.length,
      skippedAt, targetMissing, fetchElapsedMs: fetchMs,
      processElapsedMs: Date.now() - tProcess, elapsedMs: Date.now() - t0,
    });
  } catch (e) {
    const message = String(e.message || e);
    if (isRateLimitMessage(message)) {
      const info = reportRateLimitMessage(sourceKey, message);
      await addLog('warn', '消息中心扫描限流', `${sourceKey}: ${message.slice(0, 80)}`, {
        source: sourceKey, api, reason: 'rate-limit', message,
        backoffMin: info?.minutes || 0, nextRetryAt: info?.blockedUntil || 0,
        elapsedMs: Date.now() - t0,
      });
    } else {
      await addLog('error', '消息中心扫描异常', `${sourceKey}: ${message}`, {
        source: sourceKey, api, stage: 'msgfeed', error: message, elapsedMs: Date.now() - t0,
      });
    }
  }
}

export async function scanMsgfeedReply() {
  await scanMsgfeed('reply');
}

export async function scanMsgfeedAt() {
  await scanMsgfeed('at');
}
