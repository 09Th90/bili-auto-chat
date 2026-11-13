/**
 * 回复引擎：组装上下文 → 调模型 → 清洗输出。
 * 会话隔离的关键：历史只取当前 chatKey 的 context，绝不混入其他聊天。
 */
import { chatCompletion } from './openai.js';
import { getContext } from '../store.js';

function buildSystemPrompt(config, scene) {
  const parts = [config.ai.systemPrompt];
  if (scene?.kind === 'comment') {
    parts.push(`场景：B站${scene.title ? `视频/动态《${scene.title}》` : '内容'}的评论区，你正在楼中楼里回复对方的评论。`);
    parts.push('注意：这是公开评论区，回复会展示给所有人，保持简短自然。');
  } else if (scene?.kind === 'dm') {
    parts.push('场景：B站私信聊天，对方正在和你私聊。');
    parts.push('注意：私信回复可以稍长一点，但仍要口语化、像真人。');
  }
  return parts.join('\n');
}

/** 句末标点：截断时优先在这些位置断开 */
const SENTENCE_BOUNDARY = /[。！？!?…～~\n；;]/;

/** 输出清洗：去包装引号、按句边界优雅截断（按码点，不劈开 emoji） */
export function cleanReply(text, maxLen) {
  let t = String(text || '').trim();
  // 去掉模型偶尔加的外层引号/书名号
  t = t.replace(/^[「『"'“]+/, '').replace(/[」』"'”]+$/, '').trim();
  // 去掉"好的，这是我的回复："之类的前缀
  t = t.replace(/^(好的|行|没问题)[，,]?\s*(以下是|这是)?(我的)?(回复|回答)[：:]\s*/u, '');

  const limit = Number(maxLen);
  if (!Number.isFinite(limit) || limit <= 0) return t; // 未配置上限则不截断

  const chars = Array.from(t); // 按码点切，避免把 emoji 劈成半个代理对
  if (chars.length <= limit) return t;

  // 保留 limit-1 个码点以内，从后往前找句末标点（位置须在后半段，避免切得太碎）
  const head = chars.slice(0, limit - 1);
  let cut = -1;
  for (let i = head.length - 1; i >= Math.floor(head.length * 0.5); i--) {
    if (SENTENCE_BOUNDARY.test(head[i])) {
      cut = i;
      break;
    }
  }
  const kept = cut >= 0 ? head.slice(0, cut + 1) : head;
  return kept.join('').replace(/\s+$/, '') + '…';
}

/**
 * 生成一条回复。
 * @param {object} p
 * @param {object} p.config       运行配置
 * @param {string} p.chatKey      会话 key（隔离上下文）
 * @param {object} p.scene        { kind:'comment'|'dm', title? }
 * @param {string} p.incomingText 对方消息
 * @param {string} [p.speakerName] 对方昵称（拼进 user 消息便于模型感知）
 * @returns {Promise<string>} 回复文本（已清洗）
 */
export async function generateReply({ config, chatKey, scene, incomingText, speakerName }) {
  const ctx = await getContext(chatKey);
  const history = ctx.history.slice(-config.limits.maxHistoryTurns * 2);

  // 只用说话人名做身份标注，明确告知模型这是"谁说的"而非内容
  const userContent = speakerName
    ? `（${speakerName} 说）${incomingText}`
    : incomingText;

  // 把最近几条自己的回复显式列出来，要求本轮换开头，抑制固定口癖/句式复读
  const recentAssistant = history
    .filter((h) => h.role === 'assistant')
    .slice(-4)
    .map((h) => String(h.content || '').replace(/\s+/g, ' ').slice(0, 40));
  const avoidHint = recentAssistant.length
    ? `\n【本轮去重】最近你说过：${recentAssistant.map((s) => `「${s}」`).join('；')}。本轮必须换一种开头，不要复用这些句子、口癖或句式。`
    : '';
  const openingStyles = [
    '直接回答对方，不要用口癖开场',
    '用一个轻微的反问开场',
    '先短促应一声（如“嗯”“哈”），再补一句',
    '先吐槽一句，再给一句轻描淡写的真心话',
    '先承认或否认，再转移话题',
  ];
  const styleHint = `\n【本轮开头】${openingStyles[Math.floor(Math.random() * openingStyles.length)]}。不要复用最近说过的开头。`;

  const messages = [
    {
      role: 'system',
      content:
        buildSystemPrompt(config, scene) +
        styleHint +
        avoidHint +
        '\n【重要】括号里的「某某 说」只是标注说话人昵称，不是消息内容，不要复述或提及对方昵称，直接回应冒号后的话即可。',
    },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: userContent },
  ];

  const params = {
    baseUrl: config.ai.baseUrl,
    apiKey: config.ai.apiKey,
    model: config.ai.model,
    temperature: config.ai.temperature,
    maxTokens: config.ai.maxTokens,
    frequencyPenalty: config.ai.frequencyPenalty,
    presencePenalty: config.ai.presencePenalty,
    topP: config.ai.topP,
    messages,
  };

  let raw = await chatCompletion(params);
  if (!String(raw || '').trim()) {
    // 推理模型偶尔把 token 全花在 reasoning 上，内容为空；提高预算再试一次
    raw = await chatCompletion({
      ...params,
      temperature: Math.min(1, Number(params.temperature) + 0.1),
      maxTokens: Math.max(32768, Number(params.maxTokens) || 0),
    });
  }
  if (!String(raw || '').trim()) throw new Error('AI 返回空内容（推理 token 用尽）');

  return cleanReply(raw, config.limits.maxReplyLength);
}
