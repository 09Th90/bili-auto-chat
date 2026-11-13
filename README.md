# B站自动聊天（bili-auto-chat）

Chrome / Edge（Manifest V3）浏览器插件：用 OpenAI 兼容 API 自动回复 B 站评论、消息中心和私信，
支持多线程持续对话，**不同聊天之间上下文完全隔离**。

## 功能

| 来源 | 说明 |
| --- | --- |
| 我的视频评论区 | 自己投稿视频下的新评论（含楼中楼预览） |
| 我的动态评论区 | 文字/图文动态下的新评论 |
| 指定视频/动态 | 设置里填 BV 号 / av 号 / 动态链接 |
| 消息中心 | 回复我的、@我的（评论类） |
| 私信 | 每个会话独立上下文，连发多条自动合并接话 |

- **会话隔离**：每条评论楼中楼（`comment:{oid}:{root}`）/ 每个私信会话（`dm:{uid}`）独立保存对话历史，互不串台
- **两种发送模式**：`先确认再发`（生成草稿，popup 里可编辑确认）/ `全自动`（带频控直发），随时切换
- **风控保护**：发送间隔（带随机抖动，最低 10s）、请求串行降速、每小时/每天上限、按评论/私信通道分别熔断
- **发送可靠性**：评论/私信写接口带 WBI 签名与 `statistics`/`gaia_source`，DNR 注入正确 Referer；后台被回收时卡在 `pending` 的草稿会自动恢复为可重试
- **首次静默**：插件刚启用时只建立基线，不回复历史消息
- **未回复清单**：扫描到的每条消息都有状态（处理中/生成失败/待确认/排队/发送失败/已跳过/已发送），面板和 `/v1/inbox` 都能查，失败可重试；已忽略默认收起，只显示“已忽略 N 条 / 查看”，不再占用未回复列表
- **时效过滤**：默认只回复最近 2 小时的消息，更早的记为“已跳过”，避免重启/修复后批量补回旧通知；可在设置页调整
- **旧视频覆盖**：不在最近 50 个稿件内的视频（如很早的投稿）请在设置页加入“额外指定视频”，否则不会自动扫描其新评论
- **第三方 Agent 接口**：本地 HTTP + WebSocket 桥，支持 REST 与 OpenAI 兼容端点（见下文）

## 安装

1. 打开 `chrome://extensions`（Edge 用 `edge://extensions`）
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录 `bili-auto-chat/`

## 配置（设置页）

1. **AI 接口**：填 OpenAI 兼容的 Base URL、API Key、模型名（DeepSeek / Kimi / GLM / 通义 / Ollama 均可），点「测试 AI 连接」。
   内置达妮娅 v14 低重复人设：temperature 0.85、输出预算 16384、frequency/presence penalty，回复上限 80 字、上下文 10 轮；可在设置页一键导入
2. **监听来源**：勾选需要的入口；指定视频/动态每行一个
3. **频率与限制**：默认 30 分钟轮询（约 27–33 分钟抖动）、最低 10s 发送间隔、每小时 8 条 / 每天 50 条
4. **过滤规则**：关键词黑名单、UID 黑名单、可选「只回复提问」

保存时会请求 AI 域名的网络权限（浏览器弹窗，请允许）。

## 使用

- 左键点工具栏图标打开面板：总开关、模式切换、「立即扫描」、草稿确认队列、活动日志
- 建议先用「先确认再发」模式跑几天，观察草稿质量后再决定是否全自动
- B 站需要保持登录状态；若日志出现 `no-bilibili-tab`，打开任意 B 站页面即可（页面桥兜底需要）

## 第三方 Agent 接口

给 WorkBuddy、Kimi Code、Claude Code 或其他本地 Agent 用。扩展主动连本地桥接服务，Agent 走 HTTP。

### 启动

```bash
# 双击 tools/start-bridge.cmd，或：
node server/bridge.mjs
```

- 首次启动会生成 `server/token.txt`（也可用环境变量 `BILI_BRIDGE_TOKEN` 指定）。
- **首次配对（推荐）**：桥接启动后，在主浏览器打开
  `http://127.0.0.1:8765/pair?token=<server/token.txt 里的 token>`
  页面会自动把 token 写进扩展并建立连接，配对成功后可直接关闭。
- 也可以手动：扩展设置页 →「④ 第三方 Agent 接口」→ 勾选启用 → 填 `ws://127.0.0.1:8765/ws` 和同一个 token → 保存。
- 服务只监听 `127.0.0.1`；HTTP 必须带 `Authorization: Bearer <token>`；返回给外部的状态会脱敏 `apiKey`/`token`。
- **发送由桥接本地执行器完成**：扩展通过 `get-cookies` 把 B 站 Cookie 交给桥接，执行器用 WBI + 完整请求头直接请求 B 站。
  因此不再依赖 Edge 的「站点访问权限」、页面注入或 content script；只要扩展能连上桥接即可发送。
- `server/token.txt` 等同于发送权限，请不要外传；`/pair` 链接也包含 token。
- **桥接不是必须的**：桥接离线时，扩展会自动改用 DNR 注入 Cookie + background 直连发送，不需要页面权限，也不需要本地 Node 服务。
  桥接只用于第三方 Agent 的 HTTP/OpenAPI 接口；需要 Agent 调用时再启动即可。
- 想开机自启桥接可双击 `tools/install-bridge-autostart.cmd`（在启动目录创建快捷方式，删除快捷方式即取消）。

### HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 桥接服务和扩展连接状态（免鉴权） |
| GET | `/v1/state` | 配置（脱敏）、草稿、日志、统计、登录态 |
| POST | `/v1/scan` | 触发一轮扫描，`{"wait":true}` 等结果 |
| POST | `/v1/generate` | 只生成回复：`{"text":"对方说了什么","scene":"dm"}` |
| POST | `/v1/reply` | 生成并发送/入草稿：`{"text":"对方消息","chatKey":"dm:123","speakerName":"...","scene":{"kind":"dm"},"replyPayload":{"kind":"dm","senderUid":自己UID,"receiverId":123}}` |
| POST | `/v1/send` | 发送指定文本：`{"text":"回复","replyPayload":{"replyType":1,"oid":"414932549","root":"323415338400","parent":"323422071392"}}` |
| POST | `/v1/chat/completions` | OpenAI 兼容，任何 OpenAI SDK 可直接接 |
| GET | `/v1/dm/history?talker=UID&size=20` | 回读私信历史（需要登录态） |
| GET | `/v1/replies?oid=&type=&root=` | 回读楼中楼，验证评论是否真的发出 |
| GET | `/v1/inbox?status=open\|all\|skipped` | 未回复/待处理清单（open=pending/error/draft/queued/failed） |
| POST | `/v1/inbox/:id/retry` | 重试某条未回复消息，可带 `{"text":"改后的文本"}` |
| POST | `/v1/inbox/:id/ignore` | 忽略某条消息 |
| GET | `/v1/outbox` | 草稿/失败队列 |
| POST | `/v1/outbox/:id/confirm` | 确认/重试某条草稿，可带 `{"text":"改后的文本"}` |
| POST | `/v1/outbox/:id/discard` | 丢弃 |
| GET | `/v1/logs?limit=50` | 最近日志 |
| POST | `/v1/reset-circuit` | 重置熔断，`{"kind":"comment"}` 或 `{"kind":"dm"}` |
| POST | `/v1/config` | 改配置，`{"patch":{...}}` |

示例：

```bash
TOKEN=$(cat server/token.txt)
curl -s http://127.0.0.1:8765/health
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8765/v1/state
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"你好呀","scene":"dm"}' http://127.0.0.1:8765/v1/generate
```

OpenAI 兼容接入：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8765/v1", api_key="<server/token.txt 里的 token>")
print(client.chat.completions.create(
    model="bili-auto-chat",
    messages=[{"role": "user", "content": "你好呀"}],
).choices[0].message.content)
```

### 自带 CLI

```bash
node tools/bili-agent.mjs health
node tools/bili-agent.mjs state
node tools/bili-agent.mjs scan
node tools/bili-agent.mjs generate "你好呀"
node tools/bili-agent.mjs send '{"text":"回复内容","replyPayload":{"replyType":1,"oid":"414932549","root":"323415338400","parent":"323422071392"}}'
node tools/bili-agent.mjs inbox            # 未回复/待处理
node tools/bili-agent.mjs inbox-retry <id> # 重试单条
node tools/bili-agent.mjs inbox-ignore <id>
```

> 公开评论会展示给所有人、私信对方可见。第三方 Agent 调 `/v1/send` 是**直接发送**，不再询问确认；请自己控制频率和内容。
>
> `/v1/generate` 使用插件里配置的人设；`/v1/chat/completions` 使用调用方传入的 messages（通用 OpenAI 兼容对话），需要人设时请用 `/v1/generate` 或自己把 systemPrompt 放进 messages。

## 热重载（改代码后无需移除插件）

改完代码后，让新代码生效的最快方式（**不必移除/重装**）：

1. **popup 里点「🔄 重载后台」** —— 调用 `chrome.runtime.reload()`，一键重启 Service Worker 并重载全部后台代码，等价于 `edge://extensions` 的🔄刷新但更直接
2. 或去 `edge://extensions` → 本插件卡片 → 点 **🔄 刷新**

**如何确认重载生效**：popup 顶部有「后台 HH:MM:SS」徽章 = Service Worker 启动时刻。重载后这个时间会变成当前时间，一眼可辨。

**注意**（浏览器安全限制，无法绕过）：
- **popup / options 页面**：已打开的界面需关掉重开才会用新代码（reload 只刷新后台）
- **content script（页面桥）**：需刷新 B 站页面才会更新；但桥是稳定的兜底层，改动频率极低

## 开发自测

```bash
node test/self-test.mjs         # md5 / WBI / 解析 / 清洗等纯逻辑
node test/smoke-module.mjs      # 模块图与 dispatch 冒烟（mock chrome）
node test/test-baseline.mjs     # 私信基线/去重逻辑
node test/test-send-payload.mjs # 评论 WBI/statistics/gaia_source 载荷
node test/test-target-resolve.mjs # 消息中心 subject_type → 真实评论目标
node test/test-config-migration.mjs # 120→1800 配置迁移
node test/test-inbox.mjs        # 未回复清单/重试/限流冷却
```

## 日志字段

日志最多保留 500 条，每条包含 `ts / level / msg / detail / meta`。常用 `meta`：

| 字段 | 含义 |
| --- | --- |
| `runId` | 一轮扫描的编号 |
| `source` | 来源（`comments:video` / `comments:dyn` / `msgfeed:reply` / `dm` 等） |
| `elapsedMs` | 当前步骤/整轮耗时 |
| `apiElapsedMs` | 发送接口耗时 |
| `totalElapsedMs` | 从收到消息到发送完成的端到端耗时 |
| `ok` | 发送/处理是否成功 |
| `stage` | 失败阶段：`local-bridge` / `target-resolve` / `api` / `timeout` / `exception` / `scan` |
| `code` / `message` / `hint` | B 站返回码、原始信息、人话提示 |
| `channel` | `local-bridge` / `direct` / `bridge:<页面>` / `main:<页面>` |
| `rpid` / `msgKey` | 发送成功后 B 站返回的评论 rpid / 私信 msg_key |
| `backoffMin` / `nextRetryAt` | 限流退避分钟数与下一次可重试时间 |
| `skippedReason` / `reason` | 跳过/失败原因（退避、预算、首次基线、过滤等） |

关键日志：

- 扫描：`扫描开始`、`扫描来源完成`、`扫描来源限流`、`扫描预算用尽`、`扫描完成`
- 生成：`收到消息`、`AI 生成完成`、`AI 生成失败`、`跳过消息`
- 发送：`发送开始`、`发送接口返回`、`发送成功`、`发送失败`、`发送异常`
- 轮询：`评论区扫描完成`、`私信扫描完成`、`消息中心处理完成`、`来源处理完成`

HTTP 查询支持过滤：

```bash
curl -H "Authorization: Bearer <token>" \
  "http://127.0.0.1:8765/v1/logs?limit=50&level=error"
curl -H "Authorization: Bearer <token>" \
  "http://127.0.0.1:8765/v1/logs?since=1794200000000"
```

## 结构

```
lib/            md5、BV/动态目标解析
background/     service-worker（调度/路由）、config、store（会话历史/去重/草稿/熔断）
  bilibili/     wbi 签名 + 全部 B 站接口（双通道：background 直连 → 页面桥兜底）
  ai/           OpenAI 兼容调用 + 回复引擎
  pollers/      comments / msgfeed / dm
  api-bridge.js 第三方 Agent WebSocket 客户端
server/         本地 HTTP + WebSocket 桥（零依赖）
rules/          declarativeNetRequest 请求头规则（Referer/Origin）
popup/          控制面板
options/        设置页
content/        页面桥（转发 B 站请求）
tools/          启动桥接、Agent CLI
test/           自测脚本
```

## 已知注意点

- 消息中心的 `subject_type` **不是**评论区 `type`：现在会按 `subject_id` 反查视频/动态，再决定真实 `type/oid`
- 评论写接口需要 WBI 签名 + `statistics` + `gaia_source` + `csrf`；发送前会校验并修正目标类型
- 动态 ID / rpid 为 int64，全链路按字符串处理
- 楼中楼扫描依赖评论列表接口的 3 条预览 + 「回复我的」消息兜底
- 发送通道：本地桥执行器（首选）→ background 直连 → 页面桥；本地桥不可用时才会用到 B 站标签页
