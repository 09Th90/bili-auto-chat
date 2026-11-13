/**
 * 轮询公共工具：去重 + 首次基线 + 逐条处理 + inbox 状态回写。
 */
import {
  isProcessed, markProcessed, isPrimed, setPrimed, addLog,
  upsertInbox, patchInbox, getInbox,
} from '../store.js';
import { getConfig } from '../config.js';

const TERMINAL = new Set(['sent', 'draft', 'queued', 'skipped', 'failed']);

function inboxEntry(sourceKey, item) {
  return {
    id: item.dedupeId,
    source: item.source || sourceKey,
    chatKey: item.chatKey,
    kind: item.replyPayload?.kind === 'dm' ? 'dm' : 'comment',
    incomingText: item.text,
    speakerName: item.speakerName,
    speakerUid: item.speakerUid,
    ts: item.ts,
    sceneLabel: item.sceneLabel,
    replyPayload: item.replyPayload,
    status: 'pending',
  };
}

function statusFromResult(result) {
  // 兼容旧 handler：可能返回 undefined / 数字 / 其它非对象
  if (!result || typeof result !== 'object') return { status: 'sent' };
  if (result.sent) return { status: 'sent' };
  if (result.drafted) return { status: 'draft' };
  if (result.queued) return { status: 'queued', reason: String(result.queued) };
  if (result.skipped) return { status: 'skipped', reason: String(result.skipped) };
  if (result.failed) return { status: 'failed', reason: '发送失败' };
  if (result.error) return { status: 'error', reason: String(result.error) };
  return { status: 'error', reason: '未知结果' };
}

async function applyResult(item, result) {
  const mapped = statusFromResult(result);
  await patchInbox(item.dedupeId, {
    ...mapped,
    reason: mapped.reason || '',
    ...(result?.reply ? { replyText: result.reply } : {}),
  });
  if (TERMINAL.has(mapped.status)) await markProcessed([item.dedupeId]);
  return mapped;
}

async function noteInboxError(item, error) {
  await patchInbox(item.dedupeId, { status: 'error', reason: String(error || '处理异常') });
}

/**
 * 处理一个来源的一批消息。
 * @param {string} sourceKey 来源标识（如 comments:{oid} / dm:{uid}）
 * @param {Array<{dedupeId:string}>} items
 * @param {(item|items) => Promise<any>} handle 处理新消息；batch 模式下一次性传入全部 fresh
 * @param {{batch?:boolean, sinceField?:string}} [opt]
 */
export async function processFeed(sourceKey, items, handle, { batch = false, sinceField = '' } = {}) {
  const t0 = Date.now();
  const primed = await isPrimed(sourceKey);
  const inbox = await getInbox();
  const inboxMap = new Map(inbox.map((x) => [x.id, x]));
  const fresh = [];
  let baselineSkipped = 0;
  let deduped = 0;
  const isTerminal = (id) => TERMINAL.has(inboxMap.get(id)?.status);

  if (!primed) {
    let cutoff = null;
    if (sinceField) {
      cutoff = Date.now();
      await setPrimed(sourceKey, cutoff);
    } else {
      await setPrimed(sourceKey);
    }

    const baselineItems = [];
    for (const item of items) {
      const ts = Number(item[sinceField]) || 0;
      if (cutoff != null && ts > cutoff) fresh.push(item);
      else baselineItems.push(item);
    }
    baselineSkipped = baselineItems.length;
    if (baselineItems.length) {
      const existing = baselineItems.filter((i) => !isTerminal(i.dedupeId));
      await markProcessed(baselineItems.map((i) => i.dedupeId));
      for (const item of existing) {
        await upsertInbox({ ...inboxEntry(sourceKey, item), status: 'skipped', reason: '首次基线（历史消息不回复）' });
      }
      await addLog('info', '建立基线', `${sourceKey}：跳过 ${baselineSkipped} 条历史消息，新消息将自动回复`, {
        sourceKey, cutoff, items: items.length, skippedHistory: baselineSkipped, fresh: fresh.length,
      });
    }
    if (!fresh.length) {
      if (items.length) {
        await addLog('info', '来源处理完成', `${sourceKey} 无新消息`, {
          sourceKey, items: items.length, fresh: 0, baselineSkipped, deduped, errors: 0,
          elapsedMs: Date.now() - t0,
        });
      }
      return;
    }
  } else {
    for (const item of items) {
      if (await isProcessed(item.dedupeId) || isTerminal(item.dedupeId)) {
        deduped++;
        continue;
      }
      fresh.push(item);
    }
    if (!fresh.length) {
      if (items.length) {
        await addLog('info', '来源处理完成', `${sourceKey} 全部已处理`, {
          sourceKey, items: items.length, fresh: 0, baselineSkipped, deduped, errors: 0,
          elapsedMs: Date.now() - t0,
        });
      }
      return;
    }
  }

  // 历史积压过滤：默认只回复最近 2 小时，避免旧通知被重新扫出来时批量补回
  let config = {};
  try { config = await getConfig(); } catch { /* ignore */ }
  const maxAgeMin = Number(config?.limits?.maxReplyAgeMin) || 0;
  if (maxAgeMin > 0) {
    const now = Date.now();
    const keep = [];
    let oldCount = 0;
    for (const item of fresh) {
      const ts = Number(item.ts) || 0;
      if (!ts) {
        // 无时间戳无法判断新旧（消息中心 @ 常见），按历史积压处理，避免一次性补回
        oldCount++;
        await upsertInbox({ ...inboxEntry(sourceKey, item), status: 'skipped', reason: '无时间戳，按历史消息跳过' });
        await markProcessed([item.dedupeId]);
      } else if (now - ts > maxAgeMin * 60_000) {
        oldCount++;
        await upsertInbox({ ...inboxEntry(sourceKey, item), status: 'skipped', reason: `超过 ${maxAgeMin} 分钟未处理，视为历史消息` });
        await markProcessed([item.dedupeId]);
      } else {
        keep.push(item);
      }
    }
    if (oldCount) {
      await addLog('info', '跳过历史积压', `${sourceKey}：${oldCount} 条超过 ${maxAgeMin} 分钟，不回复`, {
        sourceKey, oldCount, maxAgeMin,
      });
    }
    fresh.length = 0;
    fresh.push(...keep);
    if (!fresh.length) return;
  }

  for (const item of fresh) {
    if (!isTerminal(item.dedupeId)) {
      await upsertInbox(inboxEntry(sourceKey, item));
    }
  }

  let errors = 0;
  if (batch) {
    const tHandle = Date.now();
    try {
      const result = await handle(fresh);
      for (const item of fresh) await applyResult(item, result);
    } catch (e) {
      errors += fresh.length;
      for (const item of fresh) await noteInboxError(item, e.message || e);
      await addLog('error', '处理消息失败', `${sourceKey}: ${String(e.message || e)}`, {
        sourceKey, batch: true, items: fresh.length,
        elapsedMs: Date.now() - tHandle, error: String(e.message || e),
      });
    }
  } else {
    for (const item of fresh) {
      const tHandle = Date.now();
      try {
        const result = await handle(item);
        await applyResult(item, result);
      } catch (e) {
        errors++;
        await noteInboxError(item, e.message || e);
        await addLog('error', '处理消息失败', `${sourceKey} ${item.dedupeId}: ${String(e.message || e)}`, {
          sourceKey, dedupeId: item.dedupeId, elapsedMs: Date.now() - tHandle,
          error: String(e.message || e),
        });
      }
    }
  }

  await addLog('info', '来源处理完成', `${sourceKey} 新消息 ${fresh.length} 条，错误 ${errors}`, {
    sourceKey, items: items.length, fresh: fresh.length, baselineSkipped, deduped, errors,
    elapsedMs: Date.now() - t0,
  });
}
