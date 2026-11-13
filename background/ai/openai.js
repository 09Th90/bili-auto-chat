/**
 * OpenAI 兼容接口调用（POST {baseUrl}/chat/completions）。
 * 适配 OpenAI / DeepSeek / Kimi / GLM / 通义 / Ollama 等一切兼容服务。
 */

/**
 * @param {object} p
 * @param {string} p.baseUrl   如 https://api.deepseek.com/v1
 * @param {string} p.apiKey
 * @param {string} p.model
 * @param {number} [p.temperature]
 * @param {number} [p.maxTokens]
 * @param {Array<{role:string, content:string}>} p.messages
 * @returns {Promise<string>} 模型输出文本
 */
export async function chatCompletion({
  baseUrl, apiKey, model, temperature = 0.8, maxTokens = 400, messages,
  frequencyPenalty, presencePenalty, topP,
}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 API 地址');
  const url = `${base}/chat/completions`;

  const payload = { model, messages, temperature, max_tokens: maxTokens };
  if (frequencyPenalty != null && frequencyPenalty !== '') payload.frequency_penalty = Number(frequencyPenalty);
  if (presencePenalty != null && presencePenalty !== '') payload.presence_penalty = Number(presencePenalty);
  if (topP != null && topP !== '') payload.top_p = Number(topP);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`AI 接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 800)}`);
  }
  if (!res.ok) {
    throw new Error(`AI 接口错误 HTTP ${res.status}：${data?.error?.message || text.slice(0, 800)}`);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('AI 接口响应缺少 choices[0].message.content');
  }
  return content;
}

/** 连通性测试 */
export async function testAi(cfg) {
  const reply = await chatCompletion({
    baseUrl: cfg.ai.baseUrl,
    apiKey: cfg.ai.apiKey,
    model: cfg.ai.model,
    temperature: 0.1,
    maxTokens: 512,
    messages: [{ role: 'user', content: '请只回复两个字：正常' }],
  });
  return reply.trim().slice(0, 200);
}
