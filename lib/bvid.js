/**
 * B 站目标对象识别：从用户输入里提取视频（BV/av）或动态 ID。
 * BV↔aid 数值换算不在此处做，统一走 x/web-interface/view 接口获取 aid，可靠不依赖算法。
 */

const BV_RE = /\b(BV[0-9A-Za-z]{10})\b/;
const AV_RE = /(?:\bav\b|\/video\/av)(\d+)/i;
const DYNAMIC_RE = /(?:t\.bilibili\.com\/|bilibili\.com\/opus\/|dynamic\/)(\d{5,})/;

/**
 * @param {string} input 用户输入：BV 号 / av 号 / 视频或动态 URL
 * @returns {{kind:'video', id:string} | {kind:'dynamic', id:string} | null}
 *   video.id 为 BV 号或 av 号原文；dynamic.id 为动态数字 ID
 */
export function parseTarget(input) {
  const s = String(input || '').trim();
  if (!s) return null;

  const bv = s.match(BV_RE);
  if (bv) return { kind: 'video', id: bv[1] };

  const av = s.match(AV_RE);
  if (av) return { kind: 'video', id: 'av' + av[1] };

  const dyn = s.match(DYNAMIC_RE);
  if (dyn) return { kind: 'dynamic', id: dyn[1] };

  if (/^av\d+$/i.test(s)) return { kind: 'video', id: s };
  if (/^\d{5,}$/.test(s)) return { kind: 'dynamic', id: s };
  return null;
}

/**
 * 从任意文本提取 BV 号（用于消息内容里识别视频链接）。
 */
export function extractBvid(text) {
  const m = String(text || '').match(BV_RE);
  return m ? m[1] : null;
}
