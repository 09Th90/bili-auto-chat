/**
 * WBI 签名（B 站 web 接口防篡改参数）。
 * 流程：img_key/sub_key → mixin_key（固定重排表前 32 位）→ 参数排序拼接 → md5(query + mixin_key)。
 */
import { md5 } from '../../lib/md5.js';

// 官方固定重排表
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/**
 * 由 img_key + sub_key 派生 mixin_key（32 字符）。
 */
export function computeMixinKey(imgKey, subKey) {
  const raw = String(imgKey) + String(subKey);
  let out = '';
  for (const idx of MIXIN_KEY_ENC_TAB) {
    out += raw[idx] ?? '';
  }
  return out.slice(0, 32);
}

// value 中需剔除的字符（官方规则）
const FILTER_RE = /[!'()*]/g;

/**
 * 给参数对象签名，返回含 wts/w_rid 的新对象（原对象不改动）。
 * @param {Record<string, string|number>} params
 * @param {string} mixinKey
 * @param {number} [wts] 秒级时间戳，默认当前时间
 */
export function signParams(params, mixinKey, wts) {
  const ts = String(wts ?? Math.round(Date.now() / 1000));
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, String(v).replace(FILTER_RE, '')]);

  const query = entries
    .concat([['wts', ts]])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  return {
    ...Object.fromEntries(entries),
    wts: ts,
    w_rid: md5(query + mixinKey),
  };
}

/**
 * 从 nav 接口返回的 wbi_img 里提取 img_key/sub_key（取 URL 文件名去扩展名）。
 */
export function extractKeysFromNav(navData) {
  const img = navData?.wbi_img?.img_url || '';
  const sub = navData?.wbi_img?.sub_url || '';
  const pick = (url) => url.split('/').pop().split('.')[0];
  return { imgKey: pick(img), subKey: pick(sub) };
}
