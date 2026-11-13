/* popup 交互逻辑 */
const $ = (sel) => document.querySelector(sel);

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2200);
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function send(msg, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error('后台响应超时'));
      }
    }, timeoutMs);
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(resp);
      });
    } catch (e) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(e);
      }
    }
  });
}

/** 快速探活：SW 崩溃时 sendMessage 会永久 pending，用 2s 超时暴露它 */
function pingBackground(timeoutMs = 2000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
      }
    }, timeoutMs);
    try {
      chrome.runtime.sendMessage({ type: 'ping' }, (resp) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(chrome.runtime.lastError ? null : resp);
      });
    } catch {
      clearTimeout(timer);
      if (!done) {
        done = true;
        resolve(null);
      }
    }
  });
}

let state = null;
let showSkippedInbox = false;

async function refresh() {
  state = await send({ type: 'get-state' });
  if (state?.error && !state.config) {
    toast('加载失败: ' + state.error);
    return;
  }
  try {
    const r = await send({ type: 'get-inbox' }, 10000);
    state.inbox = r?.inbox || [];
    state.inboxStats = r?.stats || state.inboxStats;
  } catch {
    state.inbox = [];
  }
  render();
}

function render() {
  const { config, outbox = [], logs = [], stats = {}, circuit = {}, login, apiStatus } = state;

  // 第三方 Agent 接口状态
  const apiBadge = $('#api-badge');
  if (apiStatus?.connected) {
    apiBadge.textContent = 'Agent 接口';
    apiBadge.className = 'badge ok';
    apiBadge.title = apiStatus.url || '';
  } else if (config.api?.enabled) {
    apiBadge.textContent = '接口离线';
    apiBadge.className = 'badge err';
    apiBadge.title = apiStatus?.lastError || '桥接服务未启动';
  } else {
    apiBadge.className = 'badge hidden';
  }

  // SW 启动时刻（确认重载是否生效）
  const swBadge = $('#sw-badge');
  pingBackground().then((p) => {
    if (p?.swStartedAt) {
      const t = new Date(p.swStartedAt);
      swBadge.textContent = `后台 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
      swBadge.className = 'badge';
      swBadge.title = `Service Worker 启动于 ${t.toLocaleString('zh-CN')}（重载后此时间会变）`;
    } else {
      swBadge.textContent = '后台未连接';
      swBadge.className = 'badge err';
    }
  });

  // 登录状态
  const badge = $('#login-badge');
  if (login) {
    badge.textContent = login.uname;
    badge.className = 'badge ok';
    badge.title = `UID ${login.mid}`;
  } else {
    badge.textContent = '未登录';
    badge.className = 'badge err';
  }

  // 开关与模式
  $('#enabled-toggle').checked = !!config.enabled;
  document.querySelectorAll('.seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === config.mode);
  });

  // 统计与熔断
  $('#stat-day').textContent = stats.sentDay ?? 0;
  $('#stat-hour').textContent = stats.sentHour ?? 0;
  const cb = $('#circuit-badge');
  const rc = $('#reset-circuit');
  if (circuit.open) {
    cb.textContent = '已熔断';
    cb.className = 'badge err';
    cb.title = circuit.reason || '';
    rc.classList.remove('hidden');
  } else {
    cb.className = 'badge hidden';
    rc.classList.add('hidden');
  }

  // 草稿队列
  const list = $('#draft-list');
  const drafts = outbox.filter((o) => o.status !== 'failed');
  const failed = outbox.filter((o) => o.status === 'failed');
  const all = drafts.concat(failed);
  $('#draft-count').textContent = all.length;
  if (!all.length) {
    list.innerHTML = '<p class="empty">暂无草稿</p>';
  } else {
    list.innerHTML = '';
    for (const d of all) {
      const div = document.createElement('div');
      div.className = 'draft';
      div.innerHTML = `
        <div class="meta">
          <span>${d.sceneLabel || d.chatKey}${d.status === 'failed' ? '（发送失败）' : d.status === 'queued' ? '（排队）' : ''}</span>
          <span>${fmtTime(d.createdAt)}</span>
        </div>
        <div class="incoming">对方：${escapeHtml(String(d.incomingText || '').slice(0, 200))}</div>
        <textarea></textarea>
        <div class="btns">
          <button class="danger btn-discard">丢弃</button>
          <button class="primary btn-send">${d.status === 'failed' ? '重试发送' : '确认发送'}</button>
        </div>`;
      div.querySelector('textarea').value = d.text;
      div.querySelector('.btn-send').addEventListener('click', async () => {
        const btn = div.querySelector('.btn-send');
        const idleLabel = d.status === 'failed' ? '重试发送' : '确认发送';
        const text = div.querySelector('textarea').value.trim();
        if (!text) return toast('内容为空');
        if (!(await pingBackground())) {
          toast('后台无响应。请在 edge://extensions 对本插件点🔄刷新后重试');
          return;
        }
        btn.disabled = true;
        btn.textContent = '发送中…';
        try {
          const r = await send({ type: 'outbox-confirm', id: d.id, text }, 35000);
          toast(r?.sent ? '已发送' : r?.error || '发送失败');
        } catch (err) {
          toast('发送' + (String(err.message).includes('超时') ? '超时，请稍后在日志确认结果' : '出错: ' + err.message));
        }
        btn.disabled = false;
        btn.textContent = idleLabel;
        refresh();
      });
      div.querySelector('.btn-discard').addEventListener('click', async () => {
        try {
          await send({ type: 'outbox-discard', id: d.id });
          toast('已丢弃');
        } catch (err) {
          toast('丢弃出错: ' + (err?.message || err));
        }
        refresh();
      });
      list.appendChild(div);
    }
  }

  renderInbox();

  // 日志：最近 100 条，附耗时/结果/限流等结构化摘要
  const ll = $('#log-list');
  const recent = logs.slice(-100).reverse();
  if (!recent.length) {
    ll.innerHTML = '<p class="empty">暂无</p>';
  } else {
    ll.innerHTML = recent
      .map((l) => {
        const summary = metaSummary(l.meta);
        const detail = l.detail || '';
        const extra = [detail, summary].filter(Boolean).join(' · ');
        return `<div class="log-item ${l.level}"><span class="t">${fmtTime(l.ts)}</span>${escapeHtml(l.msg)}${extra ? ' · ' + escapeHtml(extra) : ''}</div>`;
      })
      .join('');
  }
}

/** 未回复/待处理清单 */
function renderInbox() {
  const listEl = $('#inbox-list');
  const countEl = $('#inbox-count');
  if (!listEl) return;
  const inbox = Array.isArray(state?.inbox) ? state.inbox : [];
  const openSet = new Set(['pending', 'error', 'draft', 'queued', 'failed']);
  const open = inbox
    .filter((x) => openSet.has(x.status))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const skippedAll = inbox
    .filter((x) => x.status === 'skipped')
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const skipped = showSkippedInbox ? skippedAll.slice(0, 50) : [];
  const items = open.concat(skipped);
  countEl.textContent = String(open.length);

  const note = $('#inbox-skipped-note');
  const toggle = $('#btn-toggle-skipped');
  if (note) note.textContent = skippedAll.length ? `已忽略 ${skippedAll.length} 条` : '';
  if (toggle) {
    toggle.classList.toggle('hidden', skippedAll.length === 0);
    toggle.textContent = showSkippedInbox ? '收起已忽略' : '查看已忽略';
    toggle.onclick = () => {
      showSkippedInbox = !showSkippedInbox;
      renderInbox();
    };
  }

  if (!items.length) {
    listEl.innerHTML = '<p class="empty">没有未回复消息</p>';
    return;
  }
  const labels = {
    pending: '处理中', error: '生成失败', draft: '待确认',
    queued: '排队中', failed: '发送失败', skipped: '已忽略',
  };
  listEl.innerHTML = '';
  for (const it of items.slice(0, 50)) {
    const isSkipped = it.status === 'skipped';
    const div = document.createElement('div');
    div.className = 'draft';
    div.innerHTML = `
      <div class="meta">
        <span>${escapeHtml(it.sceneLabel || it.source || '')}</span>
        <span>${fmtTime(it.ts || it.updatedAt || Date.now())}</span>
      </div>
      <div class="incoming">${escapeHtml(it.speakerName || '')}：${escapeHtml(String(it.incomingText || '').slice(0, 200))}</div>
      <div class="meta">
        <span class="badge ${isSkipped ? '' : 'err'}">${labels[it.status] || it.status}</span>
        <span>${escapeHtml(String(it.reason || '').slice(0, 300))}</span>
      </div>
      <div class="btns">
        ${isSkipped ? '' : '<button class="danger btn-ignore">忽略</button>'}
        <button class="primary btn-retry">${it.status === 'draft' || it.status === 'failed' ? '去发送' : '重试'}</button>
      </div>`;
    div.querySelector('.btn-retry').addEventListener('click', async () => {
      const btn = div.querySelector('.btn-retry');
      btn.disabled = true;
      btn.textContent = '处理中…';
      const r = await send({ type: 'inbox-retry', id: it.id }, 60000);
      toast(r?.sent ? '已发送' : r?.queued ? '已排队' : r?.drafted ? '已生成草稿' : r?.error || '重试失败');
      refresh();
    });
    const ignoreBtn = div.querySelector('.btn-ignore');
    if (ignoreBtn) {
      ignoreBtn.addEventListener('click', async () => {
        await send({ type: 'inbox-ignore', id: it.id });
        toast('已忽略');
        refresh();
      });
    }
    listEl.appendChild(div);
  }
}

/** 把结构化 meta 压成一行，方便面板直接看结果/耗时/限流 */
function metaSummary(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const parts = [];
  if (meta.elapsedMs != null) parts.push(`耗时${(meta.elapsedMs / 1000).toFixed(1)}s`);
  if (meta.apiElapsedMs != null && meta.apiElapsedMs !== meta.elapsedMs) {
    parts.push(`接口${(meta.apiElapsedMs / 1000).toFixed(1)}s`);
  }
  if (meta.totalElapsedMs != null && meta.totalElapsedMs !== meta.elapsedMs) {
    parts.push(`总${(meta.totalElapsedMs / 1000).toFixed(1)}s`);
  }
  if (meta.ok === true) parts.push('成功');
  if (meta.ok === false) parts.push('失败');
  if (meta.stage) parts.push(`阶段:${meta.stage}`);
  if (meta.code != null) parts.push(`code=${meta.code}`);
  if (meta.channel) parts.push(meta.channel);
  if (meta.backoffMin) parts.push(`退避${meta.backoffMin}m`);
  if (meta.nextRetryAt) parts.push(`重试${fmtTime(meta.nextRetryAt)}`);
  if (meta.rpid) parts.push(`rpid=${meta.rpid}`);
  if (meta.msgKey) parts.push(`msgKey=${String(meta.msgKey).slice(0, 12)}`);
  return parts.join(' · ');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** ---------------- 事件绑定 ---------------- */

$('#enabled-toggle').addEventListener('change', async (e) => {
  await send({ type: 'save-config', patch: { enabled: e.target.checked } });
  toast(e.target.checked ? '已开启' : '已暂停');
});

document.querySelectorAll('.seg-btn').forEach((b) => {
  b.addEventListener('click', async () => {
    await send({ type: 'save-config', patch: { mode: b.dataset.mode } });
    toast(b.dataset.mode === 'auto' ? '已切换：全自动' : '已切换：先确认再发');
    refresh();
  });
});

$('#btn-probe').addEventListener('click', async (e) => {
  const btn = e.target;
  if (!(await pingBackground())) {
    toast('后台无响应。请在 edge://extensions 对本插件点🔄刷新后重试');
    return;
  }
  btn.disabled = true;
  btn.textContent = '读取中…';
  try {
    const r = await send({ type: 'probe-params' });
    $('#probe-result').value = JSON.stringify(r, null, 2);
    $('#probe-card').classList.remove('hidden');
    toast('已读取，请复制参数发我');
  } catch (err) {
    toast('读取失败: ' + (err?.message || err));
  }
  btn.disabled = false;
  btn.textContent = '读取参数';
});

$('#btn-smoke').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = '测试中…';
  const alive = await pingBackground();
  if (!alive) {
    btn.disabled = false;
    btn.textContent = '冒烟测试';
    toast('后台无响应。请在 edge://extensions 对本插件点🔄刷新后重试');
    return;
  }
  try {
    const r = await send({ type: 'smoke-test' });
    const card = $('#smoke-card');
    const box = $('#smoke-result');
    if (!r?.steps) {
      box.innerHTML = '<p class="empty">无结果</p>';
    } else {
      box.innerHTML = r.steps
        .map(
          (s) =>
            `<div class="smoke-item ${s.ok ? 'ok' : 'err'}"><b>${s.ok ? '✅' : '❌'} ${escapeHtml(s.name)}</b><span>${escapeHtml(s.detail)}</span></div>`
        )
        .join('');
    }
    card.classList.remove('hidden');
    toast(r?.passed != null ? `冒烟：${r.passed}/${r.total} 通过` : '冒烟完成');
  } catch (err) {
    toast('冒烟失败: ' + (err?.message || err));
  }
  btn.disabled = false;
  btn.textContent = '冒烟测试';
});

$('#btn-reload').addEventListener('click', () => {
  // chrome.runtime.reload() = 官方扩展重载：重启 SW + 重载全部代码，等价 edge://extensions 的🔄，但无需移除
  toast('正在重载后台…');
  try {
    chrome.runtime.reload();
  } catch (e) {
    toast('重载失败: ' + (e?.message || e));
  }
});

$('#btn-scan').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = '扫描中…';
  // 先探活：SW 崩溃/未启动时立刻报明确原因，不干等 60s
  const alive = await pingBackground();
  if (!alive) {
    btn.disabled = false;
    btn.textContent = '立即扫描';
    toast('后台无响应（Service Worker 未运行）。请在 edge://extensions 对本插件点🔄刷新后重试');
    return;
  }
  // 触发即返回，然后轮询任务状态（长任务不阻塞 sendMessage，规避消息丢失）
  let r;
  try {
    r = await send({ type: 'scan-now' });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '立即扫描';
    toast('触发失败: ' + (err?.message || err));
    return;
  }
  if (r?.skipped) {
    btn.disabled = false;
    btn.textContent = '立即扫描';
    toast(r.skipped);
    return;
  }
  // 轮询任务结果（最多 70s）
  const start = Date.now();
  const poll = setInterval(async () => {
    const { task } = (await send({ type: 'get-task' })) || {};
    const elapsed = Date.now() - start;
    if (task?.type === 'scan' && task.status === 'done') {
      clearInterval(poll);
      btn.disabled = false;
      btn.textContent = '立即扫描';
      const res = task.result || {};
      toast(res.error ? '扫描出错: ' + res.error : `扫描完成（${Math.round((res.elapsedMs || elapsed) / 1000)}s）`);
      refresh();
    } else if (elapsed > 70000) {
      clearInterval(poll);
      btn.disabled = false;
      btn.textContent = '立即扫描';
      toast('扫描超时，请查看日志');
      refresh();
    }
  }, 1500);
});

$('#btn-test-ai').addEventListener('click', async () => {
  toast('测试中…');
  const r = await send({ type: 'test-ai' });
  toast(r?.error ? 'AI 失败: ' + r.error : 'AI 正常: ' + (r.reply || ''));
});

$('#btn-test-bili').addEventListener('click', async () => {
  const r = await send({ type: 'test-bili' });
  toast(r?.ok ? `已登录：${r.uname}` : `未登录（code=${r?.code}）`);
});

$('#btn-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

$('#reset-circuit').addEventListener('click', async () => {
  await send({ type: 'reset-circuit' });
  toast('熔断已重置');
  refresh();
});

refresh();
