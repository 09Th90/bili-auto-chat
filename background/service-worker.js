/**
 * 入口：定时调度 + popup/options/content 消息路由。
 */
import { getConfig, saveConfig } from './config.js';
import {
  getOutbox, updateOutbox, removeOutbox, getLogs, addLog,
  getSendStats, getCircuit, getCircuits, resetCircuit,
  getScanState, setScanState, patchInbox,
  getInbox, getInboxStats, markProcessed, unmarkProcessed, upsertInbox,
} from './store.js';
import { confirmSend, flushQueue, handleIncoming, getMyUid, reconcileOutbox, sendReply } from './dispatch.js';
import { startBridge, ensureBridge, getBridgeStatus } from './api-bridge.js';
import { testAi, chatCompletion } from './ai/openai.js';
import { generateReply } from './ai/reply-engine.js';
import { runSmokeTest, probeParams } from './smoke.js';
import {
  getNav, getDmHistory, getReplyMe, getAtMe, setRequestGapMs,
  cookieLoginTest,
} from './bilibili/api.js';
import { scanMyVideos, scanMyDynamics, scanWatchList } from './pollers/comments.js';
import { scanMsgfeedReply, scanMsgfeedAt } from './pollers/msgfeed.js';
import { scanDm } from './pollers/dm.js';
import { parseTarget } from '../lib/bvid.js';
import {
  backoffRemainingSec, getBackoffInfo, isRateLimitMessage, reportRateLimitMessage,
  readCooldownRemainingSec, clearReadLimit,
} from './backoff.js';

const ALARM_NAME = 'bili-auto-chat-poll';
const BRIDGE_ALARM = 'bili-agent-bridge';

let scanning = false;
// SW 每次被加载/唤醒都会重新执行此模块，记录启动时刻供 popup 确认重载是否生效
const SW_STARTED_AT = Date.now();

/** 任务状态落盘，popup 轮询读取（避免长任务阻塞 sendMessage 响应） */
async function setTask(task) {
  await chrome.storage.local.set({ task: { ...task, at: Date.now() } });
}

/** 一轮完整扫描（来源互相隔离，单个失败不影响其他） */
async function runScan() {
  if (scanning) return { skipped: '扫描进行中' };
  scanning = true;
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();
  const budgetMs = 50_000;
  await setTask({ type: 'scan', status: 'running', runId });
  try {
    const config = await getConfig();
    if (!config.enabled) return { skipped: '总开关关闭' };

    // 回收上次 SW 被终止时卡在 pending 的草稿
    await reconcileOutbox();

    // 每个来源独立退避：source key 前缀对应 backoff 里的 key
    const steps = [];
    if (config.sources.myVideos) steps.push(['我的视频', () => scanMyVideos(config), 'comments:video']);
    if (config.sources.myDynamics) steps.push(['我的动态', scanMyDynamics, 'comments:dyn']);
    if ((config.watch?.videos?.length || 0) + (config.watch?.dynamics?.length || 0) > 0) {
      steps.push(['指定目标', () => scanWatchList(config), 'comments:watch']);
    }
    if (config.sources.msgfeedReply) steps.push(['回复我的', scanMsgfeedReply, 'msgfeed:reply']);
    if (config.sources.msgfeedAt) steps.push(['@我的', scanMsgfeedAt, 'msgfeed:at']);
    if (config.sources.dm) steps.push(['私信', scanDm, 'dm']);

    const scanState = await getScanState();
    const startIdx = steps.length ? (Number(scanState.sourceCursor) || 0) % steps.length : 0;
    const ordered = steps.length
      ? steps.map((s, idx) => ({ step: s, idx })).slice(startIdx).concat(steps.map((s, idx) => ({ step: s, idx })).slice(0, startIdx))
      : [];

    await addLog('info', '扫描开始', `来源 ${steps.length} 个，从第 ${startIdx + 1} 个开始，预算 ${budgetMs / 1000}s`, {
      runId,
      startedAt,
      sources: steps.map(([name, , source]) => ({ name, source })),
      sourceCursor: startIdx,
      pollIntervalSec: config.limits.pollIntervalSec,
      maxVideosPerScan: config.limits.maxVideosPerScan,
      budgetMs,
    });

    const deadline = startedAt + budgetMs;
    const sourceStats = [];

    // 全局读取冷却：rate-limited-self 期间不继续撞读取接口
    const cooldownSec = await readCooldownRemainingSec();
    if (cooldownSec > 0) {
      setRequestGapMs(2000);
      await addLog('warn', 'B站读取冷却中', `剩余约 ${Math.ceil(cooldownSec / 60)} 分钟，本轮跳过读取来源`, {
        runId, reason: 'cooldown', remainingSec: cooldownSec,
      });
      sourceStats.push({ source: 'all', name: '读取冷却', elapsedMs: 0, ok: false, skippedReason: 'cooldown', remainingSec: cooldownSec });
    } else {
      setRequestGapMs(700);
    }

    for (const { step, idx } of (cooldownSec > 0 ? [] : ordered)) {
      const [name, fn, source] = step;
      if (Date.now() > deadline) {
        await setScanState({ sourceCursor: idx });
        const skippedSources = ordered.filter((x) => x.idx >= idx || x.idx < startIdx).map((x) => ({ name: x.step[0], source: x.step[2], reason: 'budget' }));
        await addLog('warn', '扫描预算用尽', `已保存续扫点，剩余 ${skippedSources.length} 个来源下轮继续`, {
          runId,
          budgetMs,
          elapsedMs: Date.now() - startedAt,
          nextSourceCursor: idx,
          skippedSources,
        });
        sourceStats.push(...skippedSources.map((x) => ({ ...x, elapsedMs: 0, ok: false })));
        break;
      }

      // 该来源在退避期则跳过，其他来源照常
      const backoff = backoffRemainingSec(source);
      if (backoff > 0) {
        const info = getBackoffInfo(source);
        await addLog('info', '扫描来源跳过', `${name}：退避中 ${backoff}s`, {
          runId,
          source,
          name,
          reason: 'backoff',
          remainingSec: backoff,
          nextRetryAt: info.blockedUntil || Date.now() + backoff * 1000,
        });
        sourceStats.push({ source, name, elapsedMs: 0, ok: false, skippedReason: 'backoff', remainingSec: backoff });
        await setScanState({ sourceCursor: (idx + 1) % steps.length });
        continue;
      }

      const t0 = Date.now();
      try {
        await fn();
        const elapsedMs = Date.now() - t0;
        await addLog('info', '扫描来源完成', `${name} ${elapsedMs}ms`, { runId, source, name, elapsedMs, ok: true });
        sourceStats.push({ source, name, elapsedMs, ok: true });
      } catch (e) {
        const elapsedMs = Date.now() - t0;
        const message = String(e.message || e);
        if (isRateLimitMessage(message)) {
          const info = reportRateLimitMessage(source, message);
          const backoffMin = info?.minutes || 0;
          await addLog('warn', '扫描来源限流', `${name}：${message.slice(0, 80)}，退避 ${backoffMin} 分钟`, {
            runId,
            source,
            name,
            stage: 'scan',
            reason: 'rate-limit',
            code: e.code ?? null,
            message,
            backoffMin,
            nextRetryAt: info?.blockedUntil || 0,
            elapsedMs,
          });
          sourceStats.push({ source, name, elapsedMs, ok: false, rateLimited: true, message, backoffMin });
        } else {
          await addLog('error', '扫描来源失败', `${name}：${message}`, {
            runId,
            source,
            name,
            stage: 'scan',
            error: message,
            elapsedMs,
          });
          sourceStats.push({ source, name, elapsedMs, ok: false, error: message });
        }
      }
      await setScanState({ sourceCursor: (idx + 1) % steps.length });
    }

    // 本轮没有触发限流则复位读取冷却等级与请求间隔
    if ((await readCooldownRemainingSec()) === 0) {
      await clearReadLimit();
      setRequestGapMs(700);
    }

    // auto 模式：尝试补发排队中的
    const tFlush = Date.now();
    const flushed = await flushQueue();
    if (flushed) {
      await addLog('info', '队列补发完成', `尝试 ${flushed.attempted} 成功 ${flushed.sent} 失败 ${flushed.failed}`, {
        runId,
        elapsedMs: Date.now() - tFlush,
        ...flushed,
      });
    }

    const elapsedMs = Date.now() - startedAt;
    const counts = {
      ok: sourceStats.filter((s) => s.ok).length,
      failed: sourceStats.filter((s) => s.ok === false && !s.skippedReason && !s.rateLimited).length,
      skipped: sourceStats.filter((s) => s.skippedReason).length,
      rateLimited: sourceStats.filter((s) => s.rateLimited).length,
    };
    await addLog('info', '扫描完成', `${elapsedMs}ms，来源 ${counts.ok}/${sourceStats.length}`, {
      runId,
      elapsedMs,
      budgetMs,
      counts,
      sources: sourceStats,
      flushed: flushed || null,
    });

    const result = { ok: true, runId, elapsedMs, sources: sourceStats };
    await setTask({ type: 'scan', status: 'done', result });
    return result;
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    await addLog('error', '扫描异常', String(e.message || e), { runId, elapsedMs, stage: 'scan' });
    await setTask({ type: 'scan', status: 'done', result: { error: String(e.message || e), runId, elapsedMs } });
    throw e;
  } finally {
    scanning = false;
  }
}

async function setupAlarm(config) {
  await chrome.alarms.clear(ALARM_NAME);
  // 注意：chrome.alarms 有硬限制，periodInMinutes 最小 0.5（30 秒），无法更快
  // 防风控：在基准间隔上加 ±25% 随机抖动，避免固定频率被识别为机器人
  const sec = Math.min(7200, Math.max(300, Number(config.limits.pollIntervalSec) || 1800));
  const jitter = sec * (0.9 + Math.random() * 0.2); // ±10%，约 27–33 分钟
  const minutes = Math.max(0.5, jitter / 60);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
  await addLog('info', '扫描定时器已设置', `基准 ${Math.round(sec)}s，本次约 ${Math.round(minutes * 60)}s`, {
    source: 'alarm',
    baseSec: Math.round(sec),
    periodSec: Math.round(minutes * 60),
    jitterPct: 25,
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const config = await getConfig();
  await setupAlarm(config);
  await setupBridgeWatchdog();
  await startBridge(handleMsg).catch(() => {});
  await addLog('info', '插件已安装/更新', `v${chrome.runtime.getManifest().version}`);
});

chrome.runtime.onStartup?.addListener(async () => {
  await setupAlarm(await getConfig());
  await setupBridgeWatchdog();
  await startBridge(handleMsg).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    runScan().catch((e) => addLog('error', '扫描异常', String(e.message || e)));
  }
  if (alarm.name === BRIDGE_ALARM) {
    ensureBridge(handleMsg).catch(() => {});
  }
});

/**
 * 外部命令通道：通过 chrome.storage.local 写入 extCmd 触发，SW 监听并执行。
 * 命令格式 { type: 'run-full', id: <uuid> } → 执行完整「扫描→生成→发送」。
 * 结果写入 extCmdResult，供外部读取。外部无需打开任何窗口。
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.extCmd || !changes.extCmd.newValue) return;
  const cmd = changes.extCmd.newValue;
  runExternalCommand(cmd).catch((e) => {
    chrome.storage.local.set({ extCmdResult: { id: cmd.id, error: String(e.message || e), ts: Date.now() } });
  });
});

async function runExternalCommand(cmd) {
  await addLog('info', '外部命令', `收到 ${cmd.type} (id=${cmd.id})`);
  let result;
  if (cmd.type === 'run-full') {
    // 完整流程：扫描 → 对最新待回复消息生成并发送（auto 模式）
    result = await runScan();
    // 扫描后把队列里的排队/草稿全部尝试发送（模拟"全自动立即发送"）
    await flushQueue();
    const outbox = await getOutbox();
    const logs = await getLogs();
    result = { ...(result || {}), outbox: outbox.length, lastLogs: logs.slice(-5).map((l) => l.msg + ':' + (l.detail || '')) };
  } else if (cmd.type === 'send-outbox') {
    // 对指定草稿立即发送
    result = await confirmSend(cmd.outboxId, cmd.text);
  } else {
    result = { error: 'unknown command: ' + cmd.type };
  }
  await chrome.storage.local.set({ extCmdResult: { id: cmd.id, result, ts: Date.now() } });
  await addLog('info', '外部命令完成', `${cmd.type} → ${JSON.stringify(result).slice(0, 300)}`);
}

/** ---------------- 消息路由 ---------------- */

/** 对外接口不返回真实密钥 */
function redactConfig(config) {
  return {
    ...config,
    ai: { ...config.ai, apiKey: config.ai.apiKey ? '***' : '' },
    api: { ...config.api, token: config.api.token ? '***' : '' },
  };
}

function isInternalSender(sender) {
  if (!sender) return true;
  if (sender.external) return false;
  return !sender.url || sender.url.startsWith(chrome.runtime.getURL(''));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMsg(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String(e.message || e) }));
  return true; // 异步响应
});

async function handleMsg(msg, sender) {
  switch (msg?.type) {
    case 'ping': {
      return { ok: true, version: chrome.runtime.getManifest().version, swStartedAt: SW_STARTED_AT };
    }

    case 'get-state': {
      const [config, outbox, logs, stats, circuits, legacy, inboxStats] = await Promise.all([
        getConfig(), getOutbox(), getLogs(), getSendStats(), getCircuits(), getCircuit(), getInboxStats(),
      ]);
      let nav = null;
      try {
        nav = await getNav();
      } catch (e) {
        nav = { error: String(e.message || e) };
      }
      const merged = { ...circuits };
      if (legacy?.open && !merged.global) merged.global = legacy;
      const openCircuit = Object.values(merged).find((c) => c?.open) || { open: false, fails: 0, reason: '' };
      return {
        config: msg.includeSecrets || isInternalSender(sender) ? config : redactConfig(config),
        outbox,
        logs,
        stats,
        circuit: openCircuit,
        circuits: merged,
        inboxStats,
        apiStatus: getBridgeStatus(),
        login: nav?.data?.isLogin ? { mid: nav.data.mid, uname: nav.data.uname } : null,
      };
    }

    case 'save-config': {
      const config = await saveConfig(msg.patch);
      await setupAlarm(config);
      await setupBridgeWatchdog();
      await startBridge(handleMsg).catch(() => {});
      await addLog('info', '配置已保存');
      return { ok: true, config: isInternalSender(sender) ? config : redactConfig(config) };
    }

    case 'scan-now': {
      // 异步触发，立即返回；popup 通过 get-task 轮询结果（避免长任务阻塞/消息丢失）
      if (scanning) return { skipped: '扫描进行中' };
      runScan().catch(async (e) => {
        await setTask({ type: 'scan', status: 'done', result: { error: String(e.message || e) } });
      });
      return { started: true };
    }

    case 'get-task': {
      const { task } = await chrome.storage.local.get('task');
      return { task: task || null };
    }

    case 'smoke-test': {
      return runSmokeTest();
    }

    case 'probe-params': {
      return probeParams();
    }

    case 'test-ai': {
      const config = await getConfig();
      const reply = await testAi(config);
      return { ok: true, reply };
    }

    case 'test-bili': {
      const nav = await getNav();
      return {
        ok: !!nav?.data?.isLogin,
        uname: nav?.data?.uname,
        mid: nav?.data?.mid,
        code: nav?.code,
      };
    }

    case 'outbox-confirm': {
      return confirmSend(msg.id, msg.text);
    }

    case 'outbox-discard': {
      const outbox = await getOutbox();
      const item = outbox.find((o) => o.id === msg.id);
      await removeOutbox(msg.id);
      if (item?.dedupeId) {
        await patchInbox(item.dedupeId, { status: 'skipped', reason: '草稿已丢弃', outboxId: item.id });
        await markProcessed([item.dedupeId]);
      }
      await addLog('info', '草稿已丢弃');
      return { ok: true };
    }

    case 'outbox-send-later':
    case 'outbox-retry': {
      // 手动重试：直接发送，不再依赖 auto 模式
      return confirmSend(msg.id, msg.text);
    }

    case 'reset-circuit': {
      await resetCircuit(msg.kind);
      await addLog('info', '熔断已重置', msg.kind ? `通道=${msg.kind}` : '全部通道');
      return { ok: true };
    }

    case 'manual-reply': {
      // 手动对单条消息生成回复（走 handleIncoming 的草稿流程）
      return handleIncoming({
        chatKey: msg.chatKey,
        text: msg.text,
        speakerName: msg.speakerName,
        speakerUid: msg.speakerUid,
        scene: msg.scene,
        replyPayload: msg.replyPayload,
        sceneLabel: msg.sceneLabel,
      });
    }

    case 'quick-chat': {
      // popup 临时对话（调试用）：不发送，只看模型回复
      const config = await getConfig();
      const reply = await generateReply({
        config,
        chatKey: msg.chatKey || `tmp:${Date.now()}`,
        scene: { kind: msg.scene || 'dm' },
        incomingText: msg.text,
      });
      return { reply };
    }

    case 'api-status': {
      return getBridgeStatus();
    }

    case 'get-outbox': {
      return { outbox: await getOutbox() };
    }

    case 'get-logs': {
      return { logs: await getLogs() };
    }

    case 'get-dm-history': {
      // 私信回读：直连优先（与私信扫描一致），-101 时 biliFetch 会自动降级页面桥
      return { resp: await getDmHistory(String(msg.talkerId), Number(msg.size) || 20) };
    }

    case 'get-cookies': {
      // 仅供带 token 的本地桥接服务取 Cookie 做本地发送；不返回给普通外部调用
      const all = await chrome.cookies.getAll({ domain: 'bilibili.com' });
      const cookies = {};
      for (const c of all) cookies[c.name] = c.value;
      return { cookies };
    }

    case 'get-inbox': {
      const [inbox, stats] = await Promise.all([getInbox(), getInboxStats()]);
      return { inbox, stats };
    }

    case 'get-scan-state': {
      return await getScanState();
    }

    case 'test-cookie-direct': {
      // 诊断：DNR 注入 Cookie 后读 nav（只读）
      return { resp: await cookieLoginTest() };
    }

    
    case 'get-msgfeed': {
      const kind = msg.kind === 'at' ? 'at' : 'reply';
      const cursor = msg.cursor || 0;
      const resp = kind === 'at' ? await getAtMe(cursor) : await getReplyMe(cursor);
      return { kind, cursor, resp };
    }

    case 'mark-replied': {
      if (!msg.dedupeId) return { error: '缺少 dedupeId' };
      await upsertInbox({
        id: msg.dedupeId,
        source: msg.source || 'agent',
        chatKey: msg.chatKey,
        kind: msg.kind || 'comment',
        incomingText: msg.incomingText,
        speakerName: msg.speakerName,
        speakerUid: msg.speakerUid,
        ts: msg.ts,
        sceneLabel: msg.sceneLabel,
        replyPayload: msg.replyPayload,
        status: 'sent',
        replyText: msg.replyText || msg.text,
        verifiedAt: Date.now(),
        reason: '',
      });
      await markProcessed([msg.dedupeId]);
      return { ok: true };
    }

    case 'reload': {
      // 供本地桥远程触发重载（先返回响应，再重载）
      setTimeout(() => { try { chrome.runtime.reload(); } catch { /* ignore */ } }, 300);
      return { ok: true };
    }

    case 'inbox-retry': {
      const inbox = await getInbox();
      const item = inbox.find((x) => x.id === msg.id);
      if (!item) return { error: '清单项不存在' };
      if (item.status === 'sent') return { error: '这条已经回复过了' };
      if (item.outboxId) {
        const outbox = await getOutbox();
        if (outbox.some((o) => o.id === item.outboxId)) {
          return confirmSend(item.outboxId, msg.text);
        }
      }
      if (!item.replyPayload) return { error: '缺少发送目标，无法重试' };
      await unmarkProcessed(item.id);
      await patchInbox(item.id, { status: 'pending', reason: '手动重试' });
      return handleIncoming({
        chatKey: item.chatKey,
        dedupeId: item.id,
        source: item.source,
        text: item.incomingText,
        speakerName: item.speakerName,
        speakerUid: item.speakerUid,
        scene: item.kind === 'dm' ? { kind: 'dm' } : { kind: 'comment' },
        replyPayload: item.replyPayload,
        sceneLabel: item.sceneLabel,
      });
    }

    case 'inbox-ignore': {
      const inbox = await getInbox();
      const item = inbox.find((x) => x.id === msg.id);
      if (!item) return { error: '清单项不存在' };
      if (item.outboxId) await removeOutbox(item.outboxId).catch(() => {});
      await patchInbox(item.id, { status: 'skipped', reason: '手动忽略' });
      await markProcessed([item.id]);
      await addLog('info', '已忽略消息', item.sceneLabel || item.chatKey, { dedupeId: item.id, source: item.source });
      return { ok: true };
    }

    case 'send-reply': {
      // 第三方 Agent 直接发送给定文本（不生成）
      return sendReply(msg);
    }

    case 'agent-chat': {
      // 面向 Agent 的通用对话：用插件配置的 AI 接口，messages 由调用方给
      const config = await getConfig();
      const messages = Array.isArray(msg.messages) && msg.messages.length
        ? msg.messages
        : [{ role: 'user', content: String(msg.text || '') }];
      const reply = await chatCompletion({
        baseUrl: config.ai.baseUrl,
        apiKey: config.ai.apiKey,
        model: config.ai.model,
        temperature: msg.temperature ?? config.ai.temperature,
        maxTokens: msg.maxTokens ?? config.ai.maxTokens,
        messages,
      });
      return { reply, model: config.ai.model };
    }

    default:
      return { error: `unknown message: ${msg?.type}` };
  }
}

/** ---------------- 第三方 Agent ---------------- */

async function setupBridgeWatchdog() {
  const config = await getConfig();
  if (config.api?.enabled) {
    chrome.alarms.create(BRIDGE_ALARM, { periodInMinutes: 0.5 });
  } else {
    chrome.alarms.clear(BRIDGE_ALARM);
  }
}

async function handleExternal(msg, sender) {
  const origin = sender?.origin || sender?.url || '';
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(origin)) {
    return { error: '来源不允许', code: 403 };
  }
  const action = msg?.action || msg?.type;
  const config = await getConfig();

  // 首次配对：本机桥接页面把 token 写进扩展（已配置后必须带正确 token 才能改）
  if (action === 'api-config') {
    const token = String(msg?.token || '');
    const url = String(msg?.url || 'ws://127.0.0.1:8765/ws');
    if (!token) return { error: '缺少 token', code: 400 };
    if (config.api?.enabled && config.api?.token && token !== config.api.token) {
      return { error: 'token 无效', code: 401 };
    }
    await saveConfig({ api: { enabled: true, url, token } });
    await setupBridgeWatchdog();
    await startBridge(handleMsg).catch(() => {});
    await addLog('info', 'Agent 接口已配对', `url=${url}`);
    return { ok: true, api: { enabled: true, url } };
  }

  if (!config.api?.enabled) return { error: 'Agent 接口未启用', code: 403 };
  if (!config.api.token) return { error: '未配置 token', code: 403 };
  const token = msg?.token || msg?.apiToken || '';
  if (token !== config.api.token) return { error: 'token 无效', code: 401 };
  return handleMsg(
    { ...msg, type: action },
    { external: true, url: origin }
  );
}

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  handleExternal(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String(e.message || e) }));
  return true;
});

// SW 每次启动都回收一次卡死的发送中草稿，并按配置恢复 Agent 通道
reconcileOutbox().catch(() => {});
setupBridgeWatchdog().catch(() => {});
startBridge(handleMsg).catch(() => {});

// 确保扫描 alarm 与当前配置一致（重载后即使 onInstalled 未触发也能更新间隔）
(async () => {
  try {
    const config = await getConfig();
    const sec = Math.min(7200, Math.max(300, Number(config.limits.pollIntervalSec) || 1800));
    const alarm = chrome.alarms.get ? await chrome.alarms.get(ALARM_NAME) : null;
    if (!alarm || Math.abs((alarm.periodInMinutes || 0) - sec / 60) > 5) {
      await setupAlarm(config);
    }
  } catch { /* ignore */ }
})();
