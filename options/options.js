/* 设置页逻辑 */
const $ = (sel) => document.querySelector(sel);

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function splitLines(s) {
  return String(s || '')
    .split(/[\n,，]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 解析数值：0 合法；只有空/非法才回退 def；低于 min 时钳到 min */
function numInput(sel, def, min = 0) {
  const raw = document.querySelector(sel).value.trim();
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n)) return def;
  return Math.max(min, n);
}

function loadIntoForm(config) {
  $('#ai-baseUrl').value = config.ai.baseUrl || '';
  $('#ai-apiKey').value = config.ai.apiKey || '';
  $('#ai-model').value = config.ai.model || '';
  $('#ai-temperature').value = config.ai.temperature ?? 0.8;
  $('#ai-maxTokens').value = config.ai.maxTokens ?? 400;
  $('#ai-systemPrompt').value = config.ai.systemPrompt || '';

  $('#src-myVideos').checked = !!config.sources.myVideos;
  $('#src-myDynamics').checked = !!config.sources.myDynamics;
  $('#src-msgfeedReply').checked = !!config.sources.msgfeedReply;
  $('#src-msgfeedAt').checked = !!config.sources.msgfeedAt;
  $('#src-dm').checked = !!config.sources.dm;

  $('#watch-videos').value = (config.watch?.videos || []).map((v) => v.id).join('\n');
  $('#watch-dynamics').value = (config.watch?.dynamics || []).map((v) => v.id).join('\n');

  $('#lim-pollIntervalSec').value = config.limits.pollIntervalSec;
  $('#lim-sendIntervalSec').value = config.limits.sendIntervalSec;
  $('#lim-maxSendPerHour').value = config.limits.maxSendPerHour;
  $('#lim-maxSendPerDay').value = config.limits.maxSendPerDay;
  $('#lim-maxVideosPerScan').value = config.limits.maxVideosPerScan ?? 3;
  $('#lim-maxReplyAgeMin').value = config.limits.maxReplyAgeMin ?? 120;
  $('#lim-maxHistoryTurns').value = config.limits.maxHistoryTurns;
  $('#lim-maxReplyLength').value = config.limits.maxReplyLength;

  $('#filter-skipKeywords').value = (config.filter?.skipKeywords || []).join(', ');
  $('#filter-blacklistUsers').value = (config.filter?.blacklistUsers || []).join(', ');
  $('#filter-onlyQuestion').checked = !!config.filter?.onlyQuestion;

  $('#api-enabled').checked = !!config.api?.enabled;
  $('#api-url').value = config.api?.url || 'ws://127.0.0.1:8765/ws';
  $('#api-token').value = config.api?.token || '';
}

function collectPatch() {
  return {
    ai: {
      baseUrl: $('#ai-baseUrl').value.trim(),
      apiKey: $('#ai-apiKey').value.trim(),
      model: $('#ai-model').value.trim(),
      temperature: numInput('#ai-temperature', 0.8),
      maxTokens: numInput('#ai-maxTokens', 400, 50),
      systemPrompt: $('#ai-systemPrompt').value.trim(),
    },
    sources: {
      myVideos: $('#src-myVideos').checked,
      myDynamics: $('#src-myDynamics').checked,
      msgfeedReply: $('#src-msgfeedReply').checked,
      msgfeedAt: $('#src-msgfeedAt').checked,
      dm: $('#src-dm').checked,
    },
    watch: {
      videos: splitLines($('#watch-videos').value).map((id) => ({ kind: 'video', id })),
      dynamics: splitLines($('#watch-dynamics').value).map((id) => ({ kind: 'dynamic', id })),
    },
    limits: {
      pollIntervalSec: numInput('#lim-pollIntervalSec', 1800, 300),
      sendIntervalSec: numInput('#lim-sendIntervalSec', 15, 0), // 代码里仍有 10s 下限
      maxSendPerHour: numInput('#lim-maxSendPerHour', 8, 1),
      maxSendPerDay: numInput('#lim-maxSendPerDay', 50, 1),
      maxVideosPerScan: numInput('#lim-maxVideosPerScan', 3, 1),
      maxReplyAgeMin: numInput('#lim-maxReplyAgeMin', 120, 0),
      maxHistoryTurns: numInput('#lim-maxHistoryTurns', 6, 1),
      maxReplyLength: numInput('#lim-maxReplyLength', 500, 10),
    },
    filter: {
      skipKeywords: splitLines($('#filter-skipKeywords').value),
      blacklistUsers: splitLines($('#filter-blacklistUsers').value).map(Number).filter((n) => Number.isFinite(n)),
      onlyQuestion: $('#filter-onlyQuestion').checked,
    },
    api: {
      enabled: $('#api-enabled').checked,
      url: $('#api-url').value.trim() || 'ws://127.0.0.1:8765/ws',
      token: $('#api-token').value.trim(),
    },
  };
}

/** 请求 AI API 域名的 host 权限（optional_host_permissions） */
async function ensureAiPermission(baseUrl) {
  try {
    const origin = new URL(baseUrl).origin + '/*';
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

$('#btn-save').addEventListener('click', async () => {
  const patch = collectPatch();
  const result = $('#save-result');
  result.textContent = '保存中…';
  result.className = 'hint';

  if (patch.ai.baseUrl) {
    const okPerm = await ensureAiPermission(patch.ai.baseUrl);
    if (!okPerm) {
      result.textContent = '未授予 AI 域名访问权限，AI 调用可能失败';
      result.className = 'hint err';
      return;
    }
  }

  const r = await send({ type: 'save-config', patch });
  if (r?.error) {
    result.textContent = '保存失败: ' + r.error;
    result.className = 'hint err';
  } else {
    result.textContent = '已保存';
    result.className = 'hint ok';
  }
});

/** 导入内置人设预设（达妮娅） */
$('#btn-import-persona').addEventListener('click', () => {
  const preset = window.PERSONA_PRESETS?.denia;
  if (!preset) return toastLike('预设未加载');
  $('#ai-systemPrompt').value = preset.systemPrompt;

  // API 字段为空时顺带填入配套推荐配置（本地 denia 模型）
  const sug = preset.suggestApi || {};
  if (!$('#ai-baseUrl').value.trim() && sug.baseUrl) $('#ai-baseUrl').value = sug.baseUrl;
  if (!$('#ai-model').value.trim() && sug.model) $('#ai-model').value = sug.model;
  if (!$('#ai-apiKey').value.trim() && sug.apiKey) $('#ai-apiKey').value = sug.apiKey;
  if (sug.temperature) $('#ai-temperature').value = sug.temperature;
  if (sug.maxTokens) $('#ai-maxTokens').value = sug.maxTokens;

  const el = $('#ai-test-result');
  el.textContent = `已导入「${preset.name}」，记得点保存`;
  el.className = 'hint ok';
});

function toastLike(msg) {
  const el = $('#ai-test-result');
  el.textContent = msg;
  el.className = 'hint err';
}

$('#btn-test-ai').addEventListener('click', async () => {
  const el = $('#ai-test-result');
  // 先保存再测试，确保测的是当前表单内容
  const patch = collectPatch();
  if (patch.ai.baseUrl) await ensureAiPermission(patch.ai.baseUrl);
  await send({ type: 'save-config', patch });
  el.textContent = '测试中…';
  el.className = 'hint';
  const r = await send({ type: 'test-ai' });
  if (r?.error) {
    el.textContent = '失败: ' + r.error;
    el.className = 'hint err';
  } else {
    el.textContent = `成功，模型回复：${r.reply}`;
    el.className = 'hint ok';
  }
});

/** 生成与桥接服务一致的随机 token */
$('#btn-gen-token').addEventListener('click', () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  $('#api-token').value = token;
  const el = $('#api-test-result');
  el.textContent = '已生成，记得点「保存设置」';
  el.className = 'hint ok';
});

$('#btn-test-api').addEventListener('click', async () => {
  const el = $('#api-test-result');
  const api = {
    enabled: $('#api-enabled').checked,
    url: $('#api-url').value.trim() || 'ws://127.0.0.1:8765/ws',
    token: $('#api-token').value.trim(),
  };
  if (!api.enabled) {
    el.textContent = '请先勾选「启用本地桥接接口」';
    el.className = 'hint err';
    return;
  }
  if (!api.token) {
    el.textContent = '请先填写 token（可点「生成随机 token」，并同步到 server/token.txt）';
    el.className = 'hint err';
    return;
  }
  el.textContent = '保存并连接中…';
  el.className = 'hint';
  await send({ type: 'save-config', patch: { api } });
  await new Promise((r) => setTimeout(r, 1500));
  const r = await send({ type: 'api-status' });
  if (r?.connected) {
    el.textContent = `已连接：${r.url}`;
    el.className = 'hint ok';
  } else {
    el.textContent = `未连接：${r?.lastError || '桥接服务未启动（先运行 tools/start-bridge.cmd）'}`;
    el.className = 'hint err';
  }
});

(async function init() {
  const state = await send({ type: 'get-state' });
  if (state?.config) loadIntoForm(state.config);
})();
