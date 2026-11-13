/**
 * 页面桥兜底：background 直连若因 cookie（SameSite）问题拿不到登录态，
 * 由本脚本在 bilibili.com 页面上下文代发请求（同站 fetch 必带 cookie）。
 * 可被 scripting.executeScript 重复注入，用全局标志保证只注册一次。
 */
(() => {
  if (globalThis.__biliAutoChatBridge) return;
  globalThis.__biliAutoChatBridge = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'bili-fetch') return;

    (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000); // 12s 超时（< sendMessage 18s）
      try {
        const res = await fetch(msg.url, {
          method: msg.init?.method || 'GET',
          headers: msg.init?.headers || {},
          body: msg.init?.body || undefined,
          credentials: 'include',
          signal: controller.signal,
        });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = { code: -1, message: 'non-json response', raw: text.slice(0, 300) };
        }
        sendResponse({ ok: res.ok, status: res.status, json });
      } catch (e) {
        const msg2 = controller.signal.aborted ? 'bridge fetch timeout (15s)' : String(e.message || e);
        sendResponse({ ok: false, status: 0, json: { code: -1, message: msg2 } });
      } finally {
        clearTimeout(timer);
      }
    })();

    return true; // 异步 sendResponse
  });
})();
