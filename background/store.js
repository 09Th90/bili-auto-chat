/**
 * 运行时数据存储（chrome.storage.local）：
 * - contexts: 每个"聊天"独立的对话历史（会话隔离的核心）
 * - processed: 已处理消息去重
 * - outbox: 草稿/待发送队列
 * - logs: 活动日志
 */

const MAX_PROCESSED = 2000;
const MAX_LOGS = 500;
const MAX_CONTEXTS = 500;
const MAX_DETAIL = 20000;
const MAX_META = 2000;

/** 串行写锁：并行扫描下防止 read-modify-write 竞态（丢去重标记 → 重复回复） */
let writeChain = Promise.resolve();
function withLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

/** 会话 key：评论线程 comment:{oid}:{rootRpid}，私信 dm:{uid} */
export function chatKeyForComment(oid, rootRpid) {
  return `comment:${oid}:${rootRpid}`;
}
export function chatKeyForDm(uid) {
  return `dm:${uid}`;
}

export async function getContext(key) {
  const { contexts = {} } = await chrome.storage.local.get('contexts');
  return contexts[key] || { history: [], updatedAt: 0 };
}

export async function appendHistory(key, entries, maxTurns) {
  return withLock(async () => {
    const { contexts = {} } = await chrome.storage.local.get('contexts');
    const ctx = contexts[key] || { history: [], updatedAt: 0 };
    ctx.history.push(...entries);
    // 每轮 = user + assistant 两条；限制条数防止膨胀
    const keep = Math.max(2, maxTurns * 2);
    if (ctx.history.length > keep) {
      ctx.history = ctx.history.slice(ctx.history.length - keep);
    }
    ctx.updatedAt = Date.now();
    contexts[key] = ctx;

    // 上下文数量上限：按 updatedAt 淘汰最旧
    const keys = Object.keys(contexts);
    if (keys.length > MAX_CONTEXTS) {
      keys
        .sort((a, b) => (contexts[a].updatedAt || 0) - (contexts[b].updatedAt || 0))
        .slice(0, keys.length - MAX_CONTEXTS)
        .forEach((k) => delete contexts[k]);
    }
    await chrome.storage.local.set({ contexts });
    return ctx;
  });
}

export async function isProcessed(id) {
  const { processed = [] } = await chrome.storage.local.get('processed');
  return processed.includes(String(id));
}

export async function markProcessed(ids) {
  return withLock(async () => {
    const { processed = [] } = await chrome.storage.local.get('processed');
    const set = new Set(processed.map(String));
    for (const id of ids) set.add(String(id));
    const next = [...set].slice(-MAX_PROCESSED);
    await chrome.storage.local.set({ processed: next });
  });
}

/** 手动重试时解除永久去重 */
export async function unmarkProcessed(id) {
  return withLock(async () => {
    const { processed = [] } = await chrome.storage.local.get('processed');
    const next = processed.filter((x) => String(x) !== String(id));
    await chrome.storage.local.set({ processed: next });
  });
}

/** 首次静默标记：某个来源第一次扫描只标记不回复，避免历史消息轰炸 */
export async function isPrimed(sourceKey) {
  const { primed = {} } = await chrome.storage.local.get('primed');
  return !!primed[sourceKey];
}

export async function setPrimed(sourceKey, cutoffTs = 0) {
  const { primed = {} } = await chrome.storage.local.get('primed');
  primed[sourceKey] = cutoffTs || true;
  await chrome.storage.local.set({ primed });
}

/** 草稿/待发送队列 */
export async function getOutbox() {
  const { outbox = [] } = await chrome.storage.local.get('outbox');
  return outbox;
}

export async function addOutbox(item) {
  return withLock(async () => {
    const { outbox = [] } = await chrome.storage.local.get('outbox');
    outbox.push({ ...item, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now() });
    await chrome.storage.local.set({ outbox: outbox.slice(-200) });
    return outbox[outbox.length - 1];
  });
}

export async function updateOutbox(id, patch) {
  return withLock(async () => {
    const { outbox = [] } = await chrome.storage.local.get('outbox');
    const item = outbox.find((o) => o.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    await chrome.storage.local.set({ outbox });
    return item;
  });
}

export async function removeOutbox(id) {
  return withLock(async () => {
    const { outbox = [] } = await chrome.storage.local.get('outbox');
    await chrome.storage.local.set({ outbox: outbox.filter((o) => o.id !== id) });
  });
}

/** 结构化 meta 超限时保留一个可读预览，避免单条日志撑爆 storage */
function clampMeta(meta) {
  if (!meta || typeof meta !== 'object') return undefined;
  try {
    const json = JSON.stringify(meta);
    if (json.length <= MAX_META) return meta;
    return { truncated: true, preview: json.slice(0, MAX_META) };
  } catch {
    return { error: 'meta-not-serializable' };
  }
}

/** 活动日志：detail 是给人看的一句话，meta 给 popup/API 做筛选和统计 */
export async function addLog(level, msg, detail, meta) {
  return withLock(async () => {
    const { logs = [] } = await chrome.storage.local.get('logs');
    const entry = {
      ts: Date.now(),
      level,
      msg,
      detail: detail ? String(detail).slice(0, MAX_DETAIL) : undefined,
    };
    const safeMeta = clampMeta(meta);
    if (safeMeta) entry.meta = safeMeta;
    logs.push(entry);
    await chrome.storage.local.set({ logs: logs.slice(-MAX_LOGS) });
  });
}

export async function getLogs() {
  const { logs = [] } = await chrome.storage.local.get('logs');
  return logs;
}

/** 扫描游标/冷却状态（跨 SW 休眠保留） */
const DEFAULT_SCAN_STATE = {
  videoCursor: 0,
  videoList: null, // { mid, at, list:[{aid,title}] }
  dynamicCursor: 0,
  sourceCursor: 0,
  readCooldownUntil: 0,
  readLimitLevel: 0,
  lastScanAt: 0,
};

export async function getScanState() {
  const { scanState } = await chrome.storage.local.get('scanState');
  return { ...DEFAULT_SCAN_STATE, ...(scanState || {}) };
}

export async function setScanState(patch) {
  return withLock(async () => {
    const { scanState } = await chrome.storage.local.get('scanState');
    const next = { ...DEFAULT_SCAN_STATE, ...(scanState || {}), ...patch };
    await chrome.storage.local.set({ scanState: next });
    return next;
  });
}

/** ---------------- 未回复清单（inbox） ---------------- */
const MAX_INBOX = 500;
const INBOX_OPEN = new Set(['pending', 'error', 'draft', 'queued', 'failed']);

function pruneInboxList(list) {
  const cutoff = Date.now() - 7 * 86400_000;
  let next = list.filter((x) => !(x.status === 'sent' && (x.updatedAt || 0) < cutoff));
  if (next.length > MAX_INBOX) {
    next = next.slice().sort((a, b) => {
      const ao = INBOX_OPEN.has(a.status) ? 1 : 0;
      const bo = INBOX_OPEN.has(b.status) ? 1 : 0;
      if (ao !== bo) return ao - bo; // 先淘汰 closed
      return (a.updatedAt || 0) - (b.updatedAt || 0);
    });
    next = next.slice(next.length - MAX_INBOX);
  }
  return next;
}

export async function upsertInbox(item) {
  if (!item?.id) return null;
  return withLock(async () => {
    const { inbox = [] } = await chrome.storage.local.get('inbox');
    const idx = inbox.findIndex((x) => x.id === item.id);
    const now = Date.now();
    let nextItem;
    if (idx >= 0) {
      nextItem = { ...inbox[idx], ...item, updatedAt: now };
      inbox[idx] = nextItem;
    } else {
      nextItem = { ...item, firstSeenAt: now, updatedAt: now };
      inbox.push(nextItem);
    }
    await chrome.storage.local.set({ inbox: pruneInboxList(inbox) });
    return nextItem;
  });
}

export async function patchInbox(id, patch) {
  if (!id) return null;
  return withLock(async () => {
    const { inbox = [] } = await chrome.storage.local.get('inbox');
    const idx = inbox.findIndex((x) => x.id === id);
    const now = Date.now();
    let nextItem;
    if (idx >= 0) {
      nextItem = { ...inbox[idx], ...patch, updatedAt: now };
      inbox[idx] = nextItem;
    } else {
      nextItem = { id, ...patch, firstSeenAt: now, updatedAt: now };
      inbox.push(nextItem);
    }
    await chrome.storage.local.set({ inbox: pruneInboxList(inbox) });
    return nextItem;
  });
}

export async function getInbox() {
  const { inbox = [] } = await chrome.storage.local.get('inbox');
  return inbox;
}

export function isInboxOpen(status) {
  return INBOX_OPEN.has(status);
}

export async function getInboxStats() {
  const inbox = await getInbox();
  const counts = {};
  for (const it of inbox) counts[it.status] = (counts[it.status] || 0) + 1;
  return {
    total: inbox.length,
    open: inbox.filter((it) => INBOX_OPEN.has(it.status)).length,
    skipped: counts.skipped || 0,
    counts,
  };
}

/**
 * 熔断器按通道隔离：comment / dm 各自独立。
 * 评论被风控不该连带停掉私信；旧版的单 circuit 数据自动当作 global 读取。
 */
export async function getCircuit(kind = 'global') {
  const { circuits, circuit } = await chrome.storage.local.get(['circuits', 'circuit']);
  if (circuits?.[kind]) return circuits[kind];
  if (!circuits && kind === 'global' && circuit) return circuit;
  return { open: false, fails: 0, reason: '' };
}

export async function getCircuits() {
  const { circuits = {} } = await chrome.storage.local.get('circuits');
  return circuits;
}

export async function recordSendResult(kind, ok, reason) {
  // 兼容旧调用 recordSendResult(ok, reason)
  if (typeof kind === 'boolean') {
    reason = ok;
    ok = kind;
    kind = 'global';
  }
  const { circuits = {} } = await chrome.storage.local.get('circuits');
  const c = circuits[kind] || { open: false, fails: 0, reason: '' };
  if (ok) {
    c.fails = 0;
    c.open = false;
    c.reason = '';
  } else {
    c.fails = (c.fails || 0) + 1;
    // 风控码（-412 被封 / -509 限流）立即熔断，不等 3 次，避免继续撞墙加重封禁
    const isRiskCode = /code=-412|code=-509|code=-352|banned|请求过于频繁/.test(String(reason || ''));
    if (isRiskCode || c.fails >= 3) {
      c.open = true;
      c.reason = reason || '连续发送失败';
    }
  }
  circuits[kind] = c;
  await chrome.storage.local.set({ circuits });
  return c;
}

/** 不传 kind = 全部重置 */
export async function resetCircuit(kind) {
  if (!kind) {
    await chrome.storage.local.set({ circuits: {} });
    return;
  }
  const { circuits = {} } = await chrome.storage.local.get('circuits');
  circuits[kind] = { open: false, fails: 0, reason: '' };
  await chrome.storage.local.set({ circuits });
}

/** 记录一次发送尝试（含失败）：任何两次发送之间都要留间隔，失败重试也不例外 */
export async function noteSendAttempt() {
  return withLock(async () => {
    const now = Date.now();
    const dayKey = new Date().toISOString().slice(0, 10);
    const { stats } = await chrome.storage.local.get('stats');
    const s = stats && stats.day === dayKey ? stats : { day: dayKey, sentDay: 0, sentHour: 0, hourStart: now };
    s.lastSendAt = now;
    await chrome.storage.local.set({ stats: s });
    return s;
  });
}

/** 发送统计（用于频控） */
export async function bumpSendCount() {
  return withLock(async () => {
    const now = Date.now();
    const dayKey = new Date().toISOString().slice(0, 10);
    const { stats } = await chrome.storage.local.get('stats');
    const s = stats && stats.day === dayKey ? stats : { day: dayKey, sentDay: 0, sentHour: 0, hourStart: now };
    if (now - s.hourStart > 3600_000) {
      s.hourStart = now;
      s.sentHour = 0;
    }
    s.sentDay += 1;
    s.sentHour += 1;
    s.lastSendAt = now;
    await chrome.storage.local.set({ stats: s });
    return s;
  });
}

export async function getSendStats() {
  const now = Date.now();
  const dayKey = new Date().toISOString().slice(0, 10);
  const { stats } = await chrome.storage.local.get('stats');
  if (!stats || stats.day !== dayKey) return { day: dayKey, sentDay: 0, sentHour: 0, hourStart: now, lastSendAt: 0 };
  return stats;
}
