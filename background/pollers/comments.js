/**
 * 评论区轮询：我的视频、我的动态、指定视频/动态。
 * type: 1=视频稿件(oid=aid)  17=动态(oid=动态id)
 */
import { getNav, getMyArchives, getVideoInfo, getComments, getReplies, getMyDynamics, getDynamicDetail } from '../bilibili/api.js';
import { processFeed } from './util.js';
import { handleIncoming, getMyUid } from '../dispatch.js';
import { chatKeyForComment, addLog, getScanState, setScanState, patchInbox } from '../store.js';
import {
  shouldBackoff, reportRateLimit, reportOk, isRateLimitMessage, reportRateLimitMessage,
} from '../backoff.js';

/** 评论区 type 常量 */
export const TYPE_VIDEO = 1;
export const TYPE_DYNAMIC = 17;

/** 扫描间隔：串行 + 随机抖动，避免并发请求触发 -412/-509 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function scanGap() {
  await sleep(1200 + Math.random() * 1800);
}

/** 动态类 oid 的候选评论区 type（不同动态类型 comment_type 不同，实测兜底） */
const DYNAMIC_TYPE_CANDIDATES = [17, 11, 1, 12];

/**
 * 把一条评论（含楼中楼预览）解析成待处理消息列表。
 * 根评论：独立会话（chatKey 取自身 rpid）；楼中楼：挂到根会话。
 */
/** 清洗楼中楼文本：去掉 B 站自动加的「回复 @某人 :」前缀，避免模型复述用户名 */
function stripReplyPrefix(text) {
  return String(text || '').replace(/^回复\s*@[^:：]*[:：]\s*/, '').trim();
}

function collectFromReplies(replies, oid, type, title) {
  const out = [];
  for (const r of replies || []) {
    const rpid = String(r.rpid_str || r.rpid || '');
    const root = String(r.root_str || r.root || '0');
    const parent = String(r.parent_str || r.parent || '0');
    const isSub = root !== '0';
    const threadRoot = isSub ? root : rpid;
    const text = stripReplyPrefix(r.content?.message);
    if (!text || !rpid) continue;

    out.push({
      dedupeId: `c:${oid}:${rpid}`,
      ts: Number(r.ctime) * 1000 || 0, // ctime 是秒级，转毫秒供时间基线判断新旧
      text,
      speakerName: r.member?.uname,
      speakerUid: r.mid,
      chatKey: chatKeyForComment(oid, threadRoot),
      scene: { kind: 'comment', title },
      sceneLabel: `评论[${title || oid}]`,
      replyPayload: { replyType: type, oid, root: threadRoot, parent: rpid },
    });
  }
  return out;
}

/**
 * 扫描一个评论区（视频或动态）。
 * 动态类的 comment_type 因动态类型而异：type 指定失败（-404）时自动换候选 type 重试。
 */
async function scanCommentArea({ oid, type, title, probeTypes = null, source = 'comments' }) {
  const tArea = Date.now();
  let tFetch = Date.now();
  let resp = await getComments(String(oid), type);
  let fetchMs = Date.now() - tFetch;
  let usedType = type;

  // -404 = 这个 type 下没有评论区，换候选 type 重试（动态常见）
  if (resp?.code === -404 && probeTypes) {
    for (const t of probeTypes) {
      if (t === type) continue;
      tFetch = Date.now();
      const r2 = await getComments(String(oid), t);
      fetchMs += Date.now() - tFetch;
      if (r2?.code === 0) {
        resp = r2;
        usedType = t;
        await addLog('info', '评论区 type 已修正', `oid=${oid} ${type}→${t}，标题「${title || ''}」`, {
          source, oid, fromType: type, toType: t, elapsedMs: fetchMs,
        });
        break;
      }
    }
  }

  if (resp?.code !== 0) {
    // 限流码：上报退避，暂停扫描
    if (shouldBackoff(resp?.code)) {
      const mins = reportRateLimit(source, resp?.code, resp?.message);
      await addLog('warn', '评论接口限流，暂停扫描', `oid=${oid} code=${resp?.code} ${resp?.message || ''}，退避约 ${mins} 分钟`, {
        source,
        api: '/x/v2/reply/wbi/main',
        oid: String(oid),
        type: usedType,
        code: resp?.code,
        message: resp?.message,
        backoffMin: mins,
        nextRetryAt: Date.now() + mins * 60_000,
        elapsedMs: Date.now() - tArea,
      });
      return;
    }
    // -404（无此评论区）对动态/视频都属正常（已删、无人评论、无权限），静默跳过不刷屏
    if (resp?.code !== -404) {
      await addLog('warn', '拉取评论失败', `oid=${oid} type=${type} code=${resp?.code} ${resp?.message || ''}`, {
        source, api: '/x/v2/reply/wbi/main', oid: String(oid), type: usedType,
        code: resp?.code, message: resp?.message, elapsedMs: Date.now() - tArea,
      });
    }
    return;
  }
  reportOk(source);
  const items = [];
  let subFetchCount = 0;
  const MAX_SUB_FETCH = 5; // 每轮最多主动拉 5 个楼中楼
  for (const r of resp.data?.replies || []) {
    items.push(...collectFromReplies([r], oid, usedType, title));
    // 楼中楼预览（最多 3 条）
    items.push(...collectFromReplies(r.replies, oid, usedType, title));
    // 对有回复的根评论，主动拉最新楼中楼（预览会漏新回复），限量 + 只处理时间基线后的
    const rootRpid = String(r.rpid_str || r.rpid || '');
    const replyCount = Number(r.rcount) || 0;
    // 二级回复不能只看预览：有回复就主动拉最新一页（预览可能只有旧的/自己的）
    if (rootRpid && replyCount > 0 && subFetchCount < MAX_SUB_FETCH) {
      subFetchCount++;
      const tSub = Date.now();
      try {
        const sub = await getReplies(String(oid), usedType, rootRpid, 1, 20);
        if (sub?.code === 0) {
          items.push(...collectFromReplies(sub.data?.replies, oid, usedType, title));
        } else {
          await addLog('warn', '楼中楼拉取失败', `oid=${oid} root=${rootRpid} code=${sub?.code} ${sub?.message || ''}`, {
            source, api: '/x/v2/reply/reply', oid: String(oid), root: rootRpid, type: usedType,
            code: sub?.code, message: sub?.message, elapsedMs: Date.now() - tSub,
          });
        }
      } catch (e) {
        await addLog('warn', '楼中楼拉取异常', `oid=${oid} root=${rootRpid} ${String(e.message || e)}`, {
          source, api: '/x/v2/reply/reply', oid: String(oid), root: rootRpid, type: usedType,
          error: String(e.message || e), elapsedMs: Date.now() - tSub,
        });
      }
    }
  }

  await processFeed(`comments:${oid}:${usedType}`, items, async (item) => {
    if (Number(item.speakerUid) === (await getMyUid())) {
      await patchInbox(item.dedupeId, { status: 'skipped', reason: '自己的评论' });
      return { skipped: '自己的评论' };
    }
    return handleIncoming(item);
  }, { sinceField: 'ts' });

  await addLog('info', '评论区扫描完成', `oid=${oid} type=${usedType} 评论 ${resp.data?.replies?.length || 0} 条`, {
    source,
    oid: String(oid),
    type: usedType,
    title,
    replies: resp.data?.replies?.length || 0,
    items: items.length,
    subFetches: subFetchCount,
    fetchElapsedMs: fetchMs,
    elapsedMs: Date.now() - tArea,
  });
}

/** 我的视频评论区（串行 + 限量，避免一上来并发十几条请求） */
export async function scanMyVideos(config = {}) {
  const tSource = Date.now();
  const nav = await getNav();
  const mid = nav?.data?.mid;
  if (!mid) {
    await addLog('warn', '未登录', '无法扫描我的视频', { source: 'comments:video', stage: 'nav' });
    return;
  }
  const state = await getScanState();
  const tList = Date.now();
  let all = [];
  let listMs = 0;
  let cached = false;
  if (state.videoList?.mid === mid && Date.now() - (state.videoList.at || 0) < 6 * 3600_000) {
    all = state.videoList.list || [];
    cached = true;
  } else {
    const resp = await getMyArchives(mid, 1, 50);
    listMs = Date.now() - tList;
    if (resp?.code !== 0) {
      if (shouldBackoff(resp?.code) || isRateLimitMessage(resp?.message)) {
        const mins = reportRateLimit('comments:video', resp?.code, resp?.message);
        await addLog('warn', '视频列表限流，暂停扫描', `code=${resp?.code} ${resp?.message || ''}，退避约 ${mins} 分钟`, {
          source: 'comments:video', api: '/x/space/wbi/arc/search', mid,
          code: resp?.code, message: resp?.message, backoffMin: mins,
          nextRetryAt: Date.now() + mins * 60_000, elapsedMs: listMs,
        });
      } else {
        await addLog('warn', '视频列表获取失败', `code=${resp?.code} ${resp?.message || ''}`, {
          source: 'comments:video', api: '/x/space/wbi/arc/search', mid,
          code: resp?.code, message: resp?.message, elapsedMs: listMs,
        });
      }
      return;
    }
    all = (resp?.data?.list?.vlist || []).map((v) => ({ aid: String(v.aid), bvid: v.bvid, title: v.title }));
    await setScanState({ videoList: { mid, at: Date.now(), list: all } });
  }

  if (!all.length) {
    await addLog('warn', '视频列表为空', '没有可扫描的稿件', { source: 'comments:video', mid });
    return;
  }
  const limit = Math.min(Math.max(1, Number(config?.limits?.maxVideosPerScan) || 3), all.length);
  const start = (Number(state.videoCursor) || 0) % all.length;
  // 最新 2 个每轮必扫（新评论主要在这里），剩余名额按游标轮转覆盖旧视频
  const vlist = all.slice(0, Math.min(2, limit));
  const seen = new Set(vlist.map((v) => v.aid));
  let cursorStep = 0;
  for (let i = 0; vlist.length < limit && i < all.length; i++) {
    const v = all[(start + i) % all.length];
    if (seen.has(v.aid)) continue;
    vlist.push(v);
    seen.add(v.aid);
    cursorStep++;
  }
  const nextCursor = (start + cursorStep) % all.length;
  await addLog('info', '视频列表获取完成', `共 ${all.length} 个，本轮取 ${vlist.length} 个（游标 ${start}→${nextCursor}）${cached ? '，缓存' : `，${listMs}ms`}`, {
    source: 'comments:video', mid, total: all.length, limit, cursor: start, nextCursor, cached, elapsedMs: listMs,
  });
  let ok = 0;
  let failed = 0;
  for (const v of vlist) {
    const tVideo = Date.now();
    try {
      await scanCommentArea({ oid: String(v.aid), type: TYPE_VIDEO, title: v.title, source: 'comments:video' });
      ok++;
      await addLog('info', '视频扫描完成', `${String(v.title || '').slice(0, 40)} ${Date.now() - tVideo}ms`, {
        source: 'comments:video', aid: String(v.aid), bvid: v.bvid, title: v.title,
        elapsedMs: Date.now() - tVideo,
      });
    } catch (e) {
      failed++;
      const message = String(e.message || e);
      if (isRateLimitMessage(message)) {
        const info = reportRateLimitMessage('comments:video', message);
        await addLog('warn', '视频扫描限流', `${String(v.title || '').slice(0, 30)}：${message.slice(0, 80)}`, {
          source: 'comments:video', aid: String(v.aid), title: v.title,
          reason: 'rate-limit', message, backoffMin: info?.minutes || 0,
          nextRetryAt: info?.blockedUntil || 0, elapsedMs: Date.now() - tVideo,
        });
      } else {
        await addLog('error', '视频扫描失败', `${String(v.title || '').slice(0, 30)}：${message}`, {
          source: 'comments:video', aid: String(v.aid), title: v.title,
          stage: 'comments', error: message, elapsedMs: Date.now() - tVideo,
        });
      }
    }
    await scanGap();
  }
  await setScanState({ videoCursor: nextCursor, lastScanAt: Date.now() });
  await addLog('info', '我的视频扫描完成', `成功 ${ok} 失败 ${failed}，总 ${Date.now() - tSource}ms`, {
    source: 'comments:video', videos: vlist.length, ok, failed, cursor: nextCursor, elapsedMs: Date.now() - tSource,
  });
}

/** 解析 opus/动态的评论区真实 oid + type（来自 basic.rid_str / basic.comment_type） */
async function resolveDynamicCommentTarget(d) {
  const dynId = String(d.id_str || d.id || '');
  let basic = d.basic || {};
  // feed 列表可能不含完整 basic，兜底调详情
  if (!basic.rid_str && !basic.comment_id_str) {
    try {
      const det = await getDynamicDetail(dynId);
      basic = det?.data?.item?.basic || {};
    } catch {
      /* 忽略，走默认 */
    }
  }
  const oid = String(basic.comment_id_str || basic.rid_str || '');
  const type = Number(basic.comment_type) || TYPE_DYNAMIC;
  return { dynId, oid, type, hasCommentTarget: !!oid };
}

/** 我的动态评论区（文字/图文动态） */
export async function scanMyDynamics() {
  const tSource = Date.now();
  const nav = await getNav();
  const mid = nav?.data?.mid;
  if (!mid) return;
  const tList = Date.now();
  const resp = await getMyDynamics(mid);
  const listMs = Date.now() - tList;
  if (resp?.code !== 0) {
    if (shouldBackoff(resp?.code)) {
      const mins = reportRateLimit('comments:dyn', resp?.code, resp?.message);
      await addLog('warn', '动态列表限流，暂停扫描', `code=${resp?.code} ${resp?.message || ''}，退避约 ${mins} 分钟`, {
        source: 'comments:dyn', api: '/x/polymer/web-dynamic/v1/feed/all', mid,
        code: resp?.code, message: resp?.message, backoffMin: mins,
        nextRetryAt: Date.now() + mins * 60_000, elapsedMs: listMs,
      });
    } else {
      await addLog('warn', '动态列表获取失败', `code=${resp?.code} ${resp?.message || ''}`, {
        source: 'comments:dyn', api: '/x/polymer/web-dynamic/v1/feed/all', mid,
        code: resp?.code, message: resp?.message, elapsedMs: listMs,
      });
    }
    return;
  }
  const items = resp?.data?.items || [];
  const candidates = items.filter((d) => /WORD|DRAW|OPUS/.test(d.type || ''));
  const state = await getScanState();
  const limit = Math.min(3, candidates.length);
  const start = candidates.length ? (Number(state.dynamicCursor) || 0) % candidates.length : 0;
  const selected = [];
  for (let i = 0; i < limit; i++) selected.push(candidates[(start + i) % candidates.length]);
  const nextCursor = candidates.length ? (start + selected.length) % candidates.length : 0;
  let scanned = 0;
  let skipped = items.length - candidates.length;
  for (const d of selected) {
    const desc = d.modules?.module_dynamic?.desc?.text || '';
    const tDyn = Date.now();
    try {
      const target = await resolveDynamicCommentTarget(d);
      if (!target.hasCommentTarget) {
        skipped++;
        continue; // 无评论区标识，跳过
      }
      await scanCommentArea({
        oid: target.oid,
        type: target.type,
        title: desc.slice(0, 20),
        probeTypes: DYNAMIC_TYPE_CANDIDATES,
        source: 'comments:dyn',
      });
      scanned++;
      await addLog('info', '动态扫描完成', `${String(desc || target.oid).slice(0, 30)} ${Date.now() - tDyn}ms`, {
        source: 'comments:dyn', dynId: d.id_str || d.id, oid: target.oid, type: target.type,
        elapsedMs: Date.now() - tDyn,
      });
    } catch (e) {
      const message = String(e.message || e);
      if (isRateLimitMessage(message)) {
        const info = reportRateLimitMessage('comments:dyn', message);
        await addLog('warn', '动态扫描限流', `${d.id_str || ''}：${message.slice(0, 80)}`, {
          source: 'comments:dyn', dynId: d.id_str || d.id, reason: 'rate-limit', message,
          backoffMin: info?.minutes || 0, nextRetryAt: info?.blockedUntil || 0, elapsedMs: Date.now() - tDyn,
        });
      } else {
        await addLog('error', '扫描动态失败', `${d.id_str || ''}: ${message}`, {
          source: 'comments:dyn', dynId: d.id_str || d.id, stage: 'comments', error: message,
          elapsedMs: Date.now() - tDyn,
        });
      }
    }
    await scanGap();
  }
  await setScanState({ dynamicCursor: nextCursor, lastScanAt: Date.now() });
  await addLog('info', '我的动态扫描完成', `动态 ${items.length} 条，本轮扫描 ${selected.length}，成功 ${scanned}，跳过 ${skipped}（游标 ${start}→${nextCursor}），${Date.now() - tSource}ms`, {
    source: 'comments:dyn', total: items.length, selected: selected.length, scanned, skipped,
    cursor: start, nextCursor, listElapsedMs: listMs, elapsedMs: Date.now() - tSource,
  });
}

/** 配置里指定的额外视频/动态（串行，避免并发触发风控） */
export async function scanWatchList(config) {
  const tSource = Date.now();
  let ok = 0;
  let failed = 0;
  for (const w of config.watch?.videos || []) {
    const t = Date.now();
    try {
      const info = await getVideoInfo(w.id.startsWith('av') ? { aid: w.id.slice(2) } : { bvid: w.id });
      if (info?.code !== 0) {
        failed++;
        await addLog('warn', '视频信息获取失败', `${w.id} code=${info?.code}`, {
          source: 'comments:watch', kind: 'video', id: w.id, code: info?.code,
          message: info?.message, elapsedMs: Date.now() - t,
        });
      } else {
        await scanCommentArea({ oid: String(info.data.aid), type: TYPE_VIDEO, title: info.data.title, source: 'comments:watch' });
        ok++;
        await addLog('info', '指定视频扫描完成', `${w.id} ${Date.now() - t}ms`, {
          source: 'comments:watch', kind: 'video', id: w.id, aid: String(info.data.aid),
          elapsedMs: Date.now() - t,
        });
      }
    } catch (e) {
      failed++;
      await addLog('error', '扫描指定视频失败', `${w.id}: ${String(e.message || e)}`, {
        source: 'comments:watch', kind: 'video', id: w.id,
        stage: 'comments', error: String(e.message || e), elapsedMs: Date.now() - t,
      });
    }
    await scanGap();
  }
  for (const w of config.watch?.dynamics || []) {
    const t = Date.now();
    try {
      const target = await resolveDynamicCommentTarget({ id_str: String(w.id) });
      if (target.hasCommentTarget) {
        await scanCommentArea({
          oid: target.oid,
          type: target.type,
          title: '动态',
          probeTypes: DYNAMIC_TYPE_CANDIDATES,
          source: 'comments:watch',
        });
        ok++;
        await addLog('info', '指定动态扫描完成', `${w.id} ${Date.now() - t}ms`, {
          source: 'comments:watch', kind: 'dynamic', id: w.id, oid: target.oid,
          elapsedMs: Date.now() - t,
        });
      } else {
        await addLog('info', '指定动态跳过', `${w.id} 无可识别评论区`, {
          source: 'comments:watch', kind: 'dynamic', id: w.id, reason: 'no-comment-target',
        });
      }
    } catch (e) {
      failed++;
      await addLog('error', '扫描指定动态失败', `${w.id}: ${String(e.message || e)}`, {
        source: 'comments:watch', kind: 'dynamic', id: w.id,
        stage: 'comments', error: String(e.message || e), elapsedMs: Date.now() - t,
      });
    }
    await scanGap();
  }
  await addLog('info', '指定目标扫描完成', `成功 ${ok} 失败 ${failed}，${Date.now() - tSource}ms`, {
    source: 'comments:watch', ok, failed, elapsedMs: Date.now() - tSource,
  });
}
