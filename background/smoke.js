/**
 * 一键冒烟测试：全链路自检，返回结构化结果供 popup 展示。
 * 每步互不影响，任一失败继续跑完，方便一次定位所有问题。
 */
import { getConfig } from './config.js';
import { getOutbox, getSendStats, getCircuit } from './store.js';
import { testAi } from './ai/openai.js';
import { getNav, getMyArchives, getComments, getDmSessions, getReplyMe, getAtMe, getDmHistory } from './bilibili/api.js';

/**
 * 读取消息中心接口的真实返回参数（用登录态），用于校准字段解析。
 * 返回每个接口第一条 item 的完整字段结构。
 */
export async function probeParams() {
  const out = {};

  // 回复我的
  try {
    const r = await getReplyMe(0);
    const items = r?.data?.items || [];
    out.replyMe = {
      code: r?.code,
      count: items.length,
      firstItem: items[0] ? JSON.parse(JSON.stringify(items[0])) : null,
    };
  } catch (e) {
    out.replyMe = { error: String(e.message || e) };
  }

  // @我的
  try {
    const r = await getAtMe(0);
    const items = r?.data?.items || [];
    out.atMe = {
      code: r?.code,
      count: items.length,
      firstItem: items[0] ? JSON.parse(JSON.stringify(items[0])) : null,
    };
  } catch (e) {
    out.atMe = { error: String(e.message || e) };
  }

  // 私信会话（第一条的字段）
  try {
    const r = await getDmSessions();
    const sessions = r?.data?.session_list || [];
    out.dmSession = {
      code: r?.code,
      count: sessions.length,
      firstSession: sessions[0] ? JSON.parse(JSON.stringify(sessions[0])) : null,
    };
    // 如果有会话，拉第一条的私信历史看消息字段
    if (sessions[0]?.talker_id) {
      const h = await getDmHistory(sessions[0].talker_id, 3);
      const msgs = h?.data?.messages || [];
      out.dmMessage = {
        code: h?.code,
        count: msgs.length,
        firstMsg: msgs[0] ? JSON.parse(JSON.stringify(msgs[0])) : null,
      };
    }
  } catch (e) {
    out.dmSession = { error: String(e.message || e) };
  }

  return out;
}

export async function runSmokeTest() {
  const steps = [];
  const add = (name, ok, detail) => steps.push({ name, ok: !!ok, detail: String(detail ?? '') });

  // 1. 配置
  let config;
  try {
    config = await getConfig();
    add('配置加载', true, `模式=${config.mode === 'auto' ? '全自动' : '先确认再发'}，总开关=${config.enabled ? '开' : '关'}`);
    if (!config.enabled) add('总开关', false, '插件已暂停，扫描不会执行');
  } catch (e) {
    add('配置加载', false, e.message);
    return { steps };
  }

  // 2. B 站登录态
  let navData = null;
  try {
    const nav = await getNav();
    if (nav?.data?.isLogin) {
      navData = nav.data;
      add('B站登录态', true, `${nav.data.uname}（UID ${nav.data.mid}）`);
    } else {
      add('B站登录态', false, `code=${nav?.code}（请先在浏览器登录 B 站）`);
    }
  } catch (e) {
    add('B站登录态', false, `请求失败：${e.message}（请打开任意 B 站页面后重试）`);
  }

  // 3. AI 接口
  try {
    const reply = await testAi(config);
    add('AI 接口', true, `模型回复「${reply}」`);
  } catch (e) {
    add('AI 接口', false, e.message);
  }

  // 4. 评论链路（拿自己最新一条稿件实测）
  if (navData?.mid) {
    try {
      const resp = await getMyArchives(navData.mid, 1, 1);
      const v = resp?.data?.list?.vlist?.[0];
      if (!v) {
        add('评论链路', false, '未获取到自己的稿件（号里没有视频？）');
      } else {
        const c = await getComments(String(v.aid), 1);
        if (c?.code === 0) {
          add('评论链路', true, `《${v.title}》拉到 ${(c.data?.replies || []).length} 条评论`);
        } else {
          add('评论链路', false, `code=${c?.code} ${c?.message || ''}`);
        }
      }
    } catch (e) {
      add('评论链路', false, e.message);
    }
  } else {
    add('评论链路', false, '跳过（未登录）');
  }

  // 5. 私信通道
  try {
    const d = await getDmSessions();
    add('私信通道', d?.code === 0, d?.code === 0 ? `会话 ${(d.data?.session_list || []).length} 个` : `code=${d?.code} ${d?.message || ''}`);
  } catch (e) {
    add('私信通道', false, e.message);
  }

  // 6. 运行状态
  try {
    const [outbox, stats, circuit] = await Promise.all([getOutbox(), getSendStats(), getCircuit()]);
    const drafts = outbox.filter((o) => o.status !== 'failed').length;
    const failed = outbox.filter((o) => o.status === 'failed').length;
    add('草稿箱', drafts + failed === 0, `${drafts} 条待发 / ${failed} 条失败`);
    add('今日发送', true, `${stats.sentDay || 0} 条（本小时 ${stats.sentHour || 0}）`);
    add('熔断器', !circuit.open, circuit.open ? `已熔断：${circuit.reason}` : '正常');
  } catch (e) {
    add('运行状态', false, e.message);
  }

  return { steps, passed: steps.filter((s) => s.ok).length, total: steps.length };
}
