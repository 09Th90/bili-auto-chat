/**
 * 私信轮询：会话列表 → 有对方新消息的会话拉取历史 → 合并接话。
 * 会话隔离：每个 talker 一个 dm:{uid} 会话。
 */
import { getDmSessions, getDmHistory } from '../bilibili/api.js';
import { processFeed } from './util.js';
import { handleIncoming, getMyUid } from '../dispatch.js';
import { chatKeyForDm, addLog } from '../store.js';
import {
  shouldBackoff, reportRateLimit, reportOk, isRateLimitMessage, reportRateLimitMessage,
} from '../backoff.js';

/** 私信 content 是 JSON 字符串 {"content":"文本"} */
function parseDmContent(content, msgType) {
  if (Number(msgType) !== 1) return null; // 只处理文本
  try {
    const obj = JSON.parse(content);
    return obj?.content ? String(obj.content) : null;
  } catch {
    return typeof content === 'string' && content ? content : null;
  }
}

export async function scanDm() {
  const tSource = Date.now();
  let myUid;
  try {
    myUid = await getMyUid();
    const tSessions = Date.now();
    const resp = await getDmSessions();
    const sessionsMs = Date.now() - tSessions;
    if (resp?.code !== 0) {
      if (shouldBackoff(resp?.code)) {
        const mins = reportRateLimit('dm', resp?.code, resp?.message);
        await addLog('warn', '私信接口限流，暂停扫描', `code=${resp?.code} ${resp?.message || ''}，退避约 ${mins} 分钟`, {
          source: 'dm', api: 'session_svr/get_sessions', code: resp?.code, message: resp?.message,
          backoffMin: mins, nextRetryAt: Date.now() + mins * 60_000, elapsedMs: sessionsMs,
        });
      } else {
        await addLog('warn', '拉取私信会话失败', `code=${resp?.code} ${resp?.message || ''}`, {
          source: 'dm', api: 'session_svr/get_sessions', code: resp?.code, message: resp?.message,
          elapsedMs: sessionsMs,
        });
      }
      return;
    }
    reportOk('dm');
    const sessions = resp.data?.session_list || [];
    await addLog('info', '私信会话列表获取完成', `${sessions.length} 个会话，${sessionsMs}ms`, {
      source: 'dm', sessions: sessions.length, elapsedMs: sessionsMs,
    });

    let scanned = 0;
    let lastSelf = 0;
    let tooOld = 0;
    let errors = 0;
    for (const s of sessions) {
      const tSession = Date.now();
      try {
        // 防风控：只对"最后一条是对方发的"会话拉历史（已读/自己结尾的跳过，省请求）
        const last = s.last_msg || {};
        const lastSender = Number(last.sender_uid || s.sender_uid || 0);
        const lastTs = Number(last.timestamp || 0);
        const isFromThem = lastSender === Number(s.talker_id) && lastSender !== myUid;
        // 会话列表本身已含 last_msg 文本，先用它快速判断是否可能是新消息
        if (!isFromThem) {
          lastSelf++;
          continue; // 最后一条是自己发的，无需回复
        }
        // 避免对很旧的会话反复拉：最后消息超过 30 分钟的跳过（除非未读）
        const unread = Number(s.unread_count || 0);
        if (unread === 0 && Date.now() / 1000 - lastTs > 1800) {
          tooOld++;
          continue;
        }

        const stat = await scanOneSession(s, myUid);
        scanned++;
        await addLog('info', '私信会话扫描完成', `${s.talker_id} 消息 ${stat.messages} 条`, {
          source: 'dm', talker: String(s.talker_id), elapsedMs: Date.now() - tSession,
          messages: stat.messages, items: stat.items, code: stat.code,
        });
      } catch (e) {
        errors++;
        const message = String(e.message || e);
        if (isRateLimitMessage(message)) {
          const info = reportRateLimitMessage('dm', message);
          await addLog('warn', '私信会话限流', `${s.talker_id}: ${message.slice(0, 80)}`, {
            source: 'dm', talker: String(s.talker_id), reason: 'rate-limit', message,
            backoffMin: info?.minutes || 0, nextRetryAt: info?.blockedUntil || 0,
            elapsedMs: Date.now() - tSession,
          });
        } else {
          await addLog('error', '扫描私信会话失败', `${s.talker_id}: ${message}`, {
            source: 'dm', talker: String(s.talker_id), stage: 'dm-session',
            error: message, elapsedMs: Date.now() - tSession,
          });
        }
      }
    }
    await addLog('info', '私信扫描完成', `会话 ${sessions.length}，扫描 ${scanned}，跳过 ${lastSelf + tooOld}，错误 ${errors}`, {
      source: 'dm', sessions: sessions.length, scanned, lastSelf, tooOld, errors,
      elapsedMs: Date.now() - tSource,
    });
  } catch (e) {
    const message = String(e.message || e);
    if (isRateLimitMessage(message)) {
      const info = reportRateLimitMessage('dm', message);
      await addLog('warn', '私信扫描限流', message.slice(0, 100), {
        source: 'dm', reason: 'rate-limit', message, backoffMin: info?.minutes || 0,
        nextRetryAt: info?.blockedUntil || 0, elapsedMs: Date.now() - tSource,
      });
    } else {
      await addLog('error', '私信扫描异常', message, {
        source: 'dm', stage: 'dm', error: message, elapsedMs: Date.now() - tSource,
      });
    }
  }
}

async function scanOneSession(session, myUid) {
  const t0 = Date.now();
  const talkerId = String(session.talker_id || '');
  if (!talkerId) return { messages: 0, items: 0, code: -1, elapsedMs: 0 };

  const tHistory = Date.now();
  const resp = await getDmHistory(talkerId, 10);
  const historyMs = Date.now() - tHistory;
  if (resp?.code !== 0) {
    await addLog('warn', '私信历史拉取失败', `${talkerId} code=${resp?.code} ${resp?.message || ''}`, {
      source: 'dm', talker: talkerId, api: 'svr_sync/fetch_session_msgs',
      code: resp?.code, message: resp?.message, elapsedMs: historyMs,
    });
    return { messages: 0, items: 0, code: resp?.code, elapsedMs: Date.now() - t0 };
  }
  const messages = resp.data?.messages || [];

  const items = [];
  for (const m of messages) {
    const text = parseDmContent(m.content, m.msg_type);
    // 消息唯一标识：msg_key 是 int64，经 JSON.parse 会丢精度，故拼上时间戳确保唯一
    const msgKey = String(m.msg_key_str || m.msg_key || m.msg_id_str || m.msg_id || '');
    const ts = Number(m.timestamp || m.msg_timestamp || 0);
    const msgId = msgKey ? `${msgKey}@${ts}` : '';
    if (!text || !msgId) continue;
    if (Number(m.sender_uid) === myUid) continue; // 自己发的跳过
    items.push({
      dedupeId: `d:${talkerId}:${msgId}`,
      ts, // 供时间基线判断新旧
      text,
      speakerName: session.talker_name || session.talker_info?.uname || `UID${talkerId}`,
      speakerUid: Number(talkerId),
      chatKey: chatKeyForDm(talkerId),
      scene: { kind: 'dm' },
      sceneLabel: `私信[${session.talker_name || talkerId}]`,
      replyPayload: { kind: 'dm', senderUid: myUid, receiverId: talkerId },
    });
  }

  const tProcess = Date.now();
  let mergedCount = 0;
  await processFeed(`dm:${talkerId}`, items, async (fresh) => {
    // 连续多条未读合并成一轮对话：取文本拼接（最多 3 条），一次性接话
    const texts = fresh.map((i) => i.text).slice(0, 3);
    mergedCount = fresh.length;
    const merged = { ...fresh[fresh.length - 1], text: texts.join('\n') };
    await handleIncoming(merged);
  }, { batch: true, sinceField: 'ts' });
  await addLog('info', '私信会话处理完成', `${talkerId} 历史 ${messages.length} 条`, {
    source: 'dm', talker: talkerId, messages: messages.length, items: items.length,
    merged: mergedCount, historyElapsedMs: historyMs, processElapsedMs: Date.now() - tProcess,
    elapsedMs: Date.now() - t0,
  });
  return { messages: messages.length, items: items.length, code: 0, elapsedMs: Date.now() - t0 };
}
