/**
 * 配置读写：chrome.storage.sync 保存配置（小体积），提供默认值与深度合并。
 */

export const CONFIG_VERSION = 2;
const OLD_DEFAULT_POLL_SEC = 120;
const NEW_DEFAULT_POLL_SEC = 1800;

export const DEFAULT_CONFIG = {
  configVersion: CONFIG_VERSION,
  enabled: true,
  mode: 'confirm', // 'auto' = 直接发送 | 'confirm' = 草稿确认后发送
  ai: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.8,
    maxTokens: 16384,
    frequencyPenalty: 0.35,
    presencePenalty: 0.25,
    topP: 0.95,
    systemPrompt:
      '你是一个友好的 B 站网友，正在评论区/私信里和别人自然地聊天。' +
      '要求：口语化、简短（一般 1~3 句）、有网感，可以适度用语气词；' +
      '不要像 AI 助手，不要说教，不确定的事情不要编造；' +
      '根据聊天上下文接话，只回应当前这条消息所在的对话。',
  },
  sources: {
    myVideos: true, // 自己视频评论区（新一级评论 + 楼中楼）
    myDynamics: true, // 自己动态评论区
    msgfeedReply: true, // 消息中心：回复我的
    msgfeedAt: true, // 消息中心：@我的
    dm: true, // 私信
  },
  watch: {
    videos: [], // 额外指定的视频：[{ kind:'video', id:'BV...' }]
    dynamics: [], // 额外指定的动态：[{ kind:'dynamic', id:'123...' }]
  },
  limits: {
    pollIntervalSec: NEW_DEFAULT_POLL_SEC, // 默认每半小时一轮
    sendIntervalSec: 15, // 两次发送间隔（代码里还有 10s 下限）
    maxSendPerHour: 8,
    maxSendPerDay: 50,
    maxVideosPerScan: 3, // 每轮最新 2 个 + 轮转 1 个
    maxReplyAgeMin: 120, // 只回复最近 2 小时的消息，避免历史积压
    maxHistoryTurns: 6, // 每个会话带入模型的历史轮数
    maxReplyLength: 800, // 回复截断长度（B 站评论上限 1000，留余量）
  },
  filter: {
    skipKeywords: ['广告', '加微信', '代练'], // 命中即不回复
    blacklistUsers: [], // UID 数字列表
    onlyQuestion: false, // true = 只回复带 ?？ 的消息
  },
  // 第三方 Agent 接口（本地桥接服务，token 必填）
  api: {
    enabled: false,
    url: 'ws://127.0.0.1:8765/ws',
    token: '',
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (isPlainObject(v) && isPlainObject(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 一次性迁移：
 * - 旧版没写 configVersion；
 * - 旧默认轮询 120s → 1800s（自定义值不动）；
 * - 旧的 maxVideosPerScan=5 → 2（用户没改过时；新轮转策略每轮只扫 2 个）。
 */
async function migrateConfig(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  if (raw.configVersion) return raw;
  const limits = { ...(raw.limits || {}) };
  const poll = limits.pollIntervalSec;
  if (poll === undefined || Number(poll) === OLD_DEFAULT_POLL_SEC) {
    limits.pollIntervalSec = NEW_DEFAULT_POLL_SEC;
  }
  if (limits.maxVideosPerScan === undefined || Number(limits.maxVideosPerScan) === 5) {
    limits.maxVideosPerScan = 3;
  }
  const next = { ...raw, configVersion: CONFIG_VERSION, limits };
  await chrome.storage.sync.set({ config: next });
  try {
    console.info('[config] 已迁移到 v2：pollIntervalSec=' + limits.pollIntervalSec + 's');
  } catch { /* ignore */ }
  return next;
}

export async function getConfig() {
  const { config } = await chrome.storage.sync.get('config');
  const migrated = await migrateConfig(config);
  return deepMerge(DEFAULT_CONFIG, migrated);
}

export async function saveConfig(patch) {
  const cur = await getConfig();
  const next = deepMerge(cur, patch);
  await chrome.storage.sync.set({ config: next });
  return next;
}
