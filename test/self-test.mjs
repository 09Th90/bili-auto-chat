/**
 * 基础库自测：node test/self-test.mjs
 * 覆盖 md5 标准向量、bvid 目标解析、WBI 签名的基本性质。
 */
import { md5 } from '../lib/md5.js';
import { parseTarget, extractBvid } from '../lib/bvid.js';
import { signParams, computeMixinKey } from '../background/bilibili/wbi.js';
import { cleanReply } from '../background/ai/reply-engine.js';
import { shouldSkip } from '../background/dispatch.js';
import { deepMerge, DEFAULT_CONFIG } from '../background/config.js';

let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ---- md5 标准测试向量（RFC 1321 附录） ----
check('md5("")', md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
check('md5("abc")', md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
check('md5("message digest")', md5('message digest'), 'f96b697d7cb7938d525a2f31aaf161d0');
check(
  'md5("abcdefghijklmnopqrstuvwxyz")',
  md5('abcdefghijklmnopqrstuvwxyz'),
  'c3fcd3d76192e4007dfb496cca67e13b'
);
check(
  'md5(数字串长度64)',
  md5('1234567890'.repeat(8)),
  '57edf4a22be3c955ac49da2e2107b67a'
);
check('md5 中文', md5('你好'), '7eca689f0d3389d9dea66ae112e5cfd7');

// ---- parseTarget ----
check('parseTarget BV 号', parseTarget('BV1xx411c7mD'), { kind: 'video', id: 'BV1xx411c7mD' });
check(
  'parseTarget 视频 URL',
  parseTarget('https://www.bilibili.com/video/BV1GJ411x7h7?p=1'),
  { kind: 'video', id: 'BV1GJ411x7h7' }
);
check('parseTarget av 号', parseTarget('av170001'), { kind: 'video', id: 'av170001' });
check(
  'parseTarget 动态 URL',
  parseTarget('https://t.bilibili.com/123456789012345678'),
  { kind: 'dynamic', id: '123456789012345678' }
);
check('extractBvid', extractBvid('看这个 BV1xx411c7mD 很有意思'), 'BV1xx411c7mD');

// ---- WBI ----
// mixin key：由 img/sub key 按重排表取前 32 位，验证长度与确定性
const mk = computeMixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');
check('mixin key 长度', mk.length, 32);
check('mixin key 确定性', computeMixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45'), mk);

// 同参数同 mixin key 同 wts → 签名结果一致；w_rid 为 32 位 hex
const signed = signParams({ foo: 'bar', baz: 123 }, mk, 1700000000);
check('签名包含 wts', signed.wts, '1700000000');
check('w_rid 格式', /^[0-9a-f]{32}$/.test(signed.w_rid), true);
check(
  '签名确定性',
  signParams({ baz: 123, foo: 'bar' }, mk, 1700000000).w_rid === signed.w_rid,
  true
);
check(
  '签名剔除特殊字符值',
  (() => {
    const s2 = signParams({ v: "it's (ok)!" }, mk, 1700000000);
    return !s2.w_rid.includes("'");
  })(),
  true
);

// ---- cleanReply ----
check('cleanReply 去引号', cleanReply('"你好呀"', 500), '你好呀');
check('cleanReply 去书名号', cleanReply('「没问题」', 500), '没问题');
check('cleanReply 超长硬切兜底', cleanReply('好'.repeat(600), 100).length, 100);
// 按句边界截断：在句号处断开并加省略号，不切在句中间
{
  const long = '第一句话。第二句话。第三句话。第四句话。第五句话。';
  const r = cleanReply(long, 12);
  check('cleanReply 按句边界截断', r.endsWith('…') && r.length <= 12, true);
  check('cleanReply 断在句号后', /[。！？!?…～~\n；;]…$/.test(r), true);
}
// 码点安全：emoji 不被劈成半个代理对
{
  const emojiStr = '😀'.repeat(200);
  const r = cleanReply(emojiStr, 10);
  check('cleanReply emoji 不劈开', Array.from(r).every((c) => c === '😀' || c === '…') && Array.from(r).length <= 10, true);
}
// 未配置上限 → 不截断
check('cleanReply 无上限不截断', cleanReply('好'.repeat(1000), undefined), '好'.repeat(1000));

// ---- shouldSkip ----
const cfg = { filter: { skipKeywords: ['广告'], blacklistUsers: [42], onlyQuestion: false } };
check('shouldSkip 黑名单', shouldSkip(cfg, '你好', 42), '黑名单用户');
check('shouldSkip 关键词', shouldSkip(cfg, '加我广告', 1), '命中过滤词「广告」');
check('shouldSkip 放行', shouldSkip(cfg, '你好呀', 1), null);
const cfgQ = { filter: { skipKeywords: [], blacklistUsers: [], onlyQuestion: true } };
check('shouldSkip 仅提问-放行', shouldSkip(cfgQ, '在哪看？', 1), null);
check('shouldSkip 仅提问-拦截', shouldSkip(cfgQ, '不错', 1), '未含提问（仅回复提问模式）');

// ---- deepMerge ----
check('deepMerge 保留默认', deepMerge(DEFAULT_CONFIG, { ai: { model: 'x' } }).ai.apiKey, DEFAULT_CONFIG.ai.apiKey);
check('deepMerge 覆盖', deepMerge(DEFAULT_CONFIG, { ai: { model: 'x' } }).ai.model, 'x');

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
