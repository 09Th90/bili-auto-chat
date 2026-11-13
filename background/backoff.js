/**
 * 按来源限流退避：B 站返回 -509/-412/-352 时，只暂停对应来源，其他来源照常。
 * 退避随失败次数指数增长（2/4/8 分钟，上限 30 分钟），成功后复位。
 */

import { getScanState, setScanState } from './store.js';

const RATE_LIMIT_CODES = [-509, -412, -352];
const RATE_LIMIT_MESSAGE_RE = /rate-?limited-self|请求过于密集|保护性跳过|请求过于频繁|banned/i;

// 每个来源独立的退避状态：{ blockedUntil, consecutive }
const backoffs = new Map();

/** 判断是否限流码 */
export function isRateLimited(code) {
  return RATE_LIMIT_CODES.includes(Number(code));
}

/** B 站限流/保护性跳过有时只给 message，不给标准 code */
export function isRateLimitMessage(message) {
  return RATE_LIMIT_MESSAGE_RE.test(String(message || ''));
}

/** 某来源的退避详情（供跳过日志/接口展示） */
export function getBackoffInfo(source) {
  const cur = backoffs.get(source);
  if (!cur) return { remainingSec: 0, blockedUntil: 0, consecutive: 0 };
  return {
    remainingSec: Math.max(0, Math.ceil((cur.blockedUntil - Date.now()) / 1000)),
    blockedUntil: cur.blockedUntil,
    consecutive: cur.consecutive,
  };
}

/** 记录某来源一次限流，返回退避分钟数。防风控：起始 3 分钟，指数到 45 分钟 */
export function reportRateLimit(source, code, message) {
  if (!isRateLimited(code) && !isRateLimitMessage(message)) return 0;
  const cur = backoffs.get(source) || { blockedUntil: 0, consecutive: 0 };
  cur.consecutive += 1;
  const minutes = Math.min(45, 3 * Math.pow(2, cur.consecutive - 1));
  cur.blockedUntil = Date.now() + minutes * 60_000;
  backoffs.set(source, cur);
  return minutes;
}

/** 仅凭错误信息记录限流，返回分钟数与退避截止时间 */
export function reportRateLimitMessage(source, message) {
  if (!isRateLimitMessage(message)) return null;
  const minutes = reportRateLimit(source, -412);
  return { minutes, ...getBackoffInfo(source) };
}

/** 记录某来源成功，复位退避 */
export function reportOk(source) {
  backoffs.delete(source);
}

/** 某来源是否在退避期，返回剩余秒数（0=可请求） */
export function backoffRemainingSec(source) {
  const cur = backoffs.get(source);
  if (!cur) return 0;
  const rem = Math.ceil((cur.blockedUntil - Date.now()) / 1000);
  return rem > 0 ? rem : 0;
}

/** 是否限流码 */
export function shouldBackoff(code) {
  return isRateLimited(code);
}

/** 响应体是否表达限流（code 或 message 任一命中） */
export function isRateLimitedResp(resp) {
  if (!resp) return false;
  if (isRateLimited(resp.code)) return true;
  return isRateLimitMessage(resp.message || resp.msg);
}

/**
 * 全局读取冷却：B 站 `rate-limited-self` 往往不带 code，只给 message。
 * 冷却期内所有读取来源暂停，避免继续撞墙。
 */
export async function reportReadLimit() {
  const s = await getScanState();
  if (s.readCooldownUntil > Date.now()) return 0; // 已在冷却，不重复升级
  const level = Math.min(5, (s.readLimitLevel || 0) + 1);
  const mins = [5, 10, 20, 40, 60][level - 1] || 60;
  const until = Date.now() + mins * 60_000;
  await setScanState({ readCooldownUntil: until, readLimitLevel: level });
  return mins;
}

export async function readCooldownRemainingSec() {
  const s = await getScanState();
  return Math.max(0, Math.ceil(((s.readCooldownUntil || 0) - Date.now()) / 1000));
}

export async function clearReadLimit() {
  const s = await getScanState();
  if (s.readCooldownUntil || s.readLimitLevel) {
    await setScanState({ readCooldownUntil: 0, readLimitLevel: 0 });
  }
}
