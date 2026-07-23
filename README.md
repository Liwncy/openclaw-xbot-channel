# openclaw-xbot-channel

OpenClaw 的 **xchatbot 微信频道**插件（`channelId=xbot`）。

把 [xchatbot](https://github.com/lwc--/xchatbot) 的微信入站推送接到 OpenClaw Agent，出站通过 xchatbot 的 `WECHAT_API_BASE_URL` 发回微信（私聊 + 群聊）。

## 架构

```text
微信消息 → xchatbot Worker (/webhook/wechat)
         → OpenClaw Gateway (xbot.inbound)
         → Agent 推理
         → xchatbot /admin/xbot/outbound
         → 微信回复（文本 / 图片 / 语音 / 视频；文件·普通音频降级为链接卡片）
```

出站媒体按 URL 后缀、`mimeType`、`audioAsVoice` 自动分类；Agent 主路径走 xchatbot（含语音 SILK 转换），工具直发走微信网关。

与 `agent-bridge` 插件的区别：

- **agent-bridge**：用户手动触发「聪明办事」，单向拉 OpenClaw
- **xbot channel**：全量入站（按策略过滤）+ 标准 OpenClaw 频道出站

## 安装

```bash
# 本地路径安装（开发）
openclaw plugins install /path/to/openclaw-xbot-channel
openclaw plugins enable xbot
openclaw gateway restart
```

## 配置示例

在 OpenClaw 配置中加入：

```json
{
  "channels": {
    "xbot": {
      "enabled": true,
      "wechatApiBaseUrl": "https://your-xchatbot-worker.example.com",
      "botWechatId": "wxid_your_bot",
      "botWechatName": "小聪明儿",
      "dmPolicy": "open",
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["12345678@chatroom"],
      "requireMention": true,
      "groupReplyMode": "mention",
      "historyLimit": 50,
      "historyForce": true,
      "accounts": {
        "Primary": {
          "enabled": true,
          "name": "WeChat Bot"
        }
      }
    }
  }
}
```

| 字段 | 说明 |
|------|------|
| `wechatApiBaseUrl` | xchatbot 对外 API 根地址（与 Worker 环境变量 `WECHAT_API_BASE_URL` 一致） |
| `botWechatId` | 机器人 wxid，用于群聊 @ 检测 |
| `dmPolicy` | 私聊：`open` / `allowlist` / `disabled` |
| `groupPolicy` | 群聊：`open` / `allowlist` / `disabled` |
| `requireMention` | 兼容字段；未设 `groupReplyMode` 时：`true`→`mention`，`false`→`all` |
| `groupReplyMode` | `mention`（默认）：群消息都攒历史，仅点名/提到昵称才回复；`all`：每条都回复 |
| `historyLimit` | 群 pending 历史条数上限（默认 `50`） |
| `historyForce` | 窗满是否静默 flush 进 session（默认 `true`）；`false` 则只滑动丢旧消息 |
| `blockStreaming` | 是否把中间回复发到微信（如调技能前的说明），默认 `true` |
| `allowTool` | 是否把 tool 结果也发到微信，默认 `false` |

### 群聊行为（对齐 BNCR）

- **`mention`**：白名单群里每条消息都会进插件；未点名 → 只写入内存 pending（带昵称 + wxid）；点名 → 把 pending 拼进上下文再跑 Agent，然后清空窗口。
- **`all`**：每条都跑 Agent，不攒 pending。
- **`historyForce`**（默认开）：pending 满 `historyLimit` 时，自动跑一轮 Agent 把这批写进 session，要求输出 `NO_REPLY`，**微信不发消息**；然后清空窗口继续攒。关掉则只丢最老消息。
- Agent 看到的正文类似：`群成员「张三(wxid_xxx)」说：…`，大群能区分人。

注意：pending 是 **Gateway 进程内存**里的短窗（默认 50），重启会丢；静默 flush 会把批次沉进 OpenClaw session。当天全量统计仍靠 xchatbot D1 `chat_log`。

默认会开启 **block streaming**（`text_end` 断点、`minChars: 1`），调 Skill/工具前的说明句会先发一条微信，最终答案再发一条。若要关闭中间消息、只发最终回复：

```json
{
  "channels": {
    "xbot": {
      "blockStreaming": false
    }
  }
}
```

## Gateway 方法

xchatbot Worker 通过 **Gateway HTTP 路由**（推荐）或 WebSocket RPC 推送消息。

### HTTP 路由（推荐，适合 Cloudflare Worker）

需 Gateway Bearer Token（与 `AGENT_BRIDGE_TOKEN` 相同）：

| 路由 | 说明 |
|------|------|
| `POST /api/channels/xbot/connect` | 登记推送端在线 |
| `POST /api/channels/xbot/inbound` | 推送入站消息 |
| `POST /api/channels/xbot/activity` | 可选心跳 |

```bash
curl -sS http://<gateway-host>:<port>/api/channels/xbot/inbound \
  -H "Authorization: Bearer <gateway-token>" \
  -H "Content-Type: application/json" \
  -d '{"messageId":"1","source":"private","from":"wxid_x","conversationId":"wxid_x","type":"text","content":"你好"}'
```

xchatbot 在 `XBOT_CHANNEL_ENABLED=true` 时会自动调用以上路由。

### WebSocket RPC（可选）

若客户端支持长连接，也可直接调用 `xbot.connect` / `xbot.inbound` / `xbot.activity`。

### `xbot.connect`

Worker 启动或定时心跳时调用，登记推送端在线状态。

```json
{
  "accountId": "Primary",
  "clientId": "xchatbot-worker",
  "connId": "xchatbot-worker-1",
  "wechatApiBaseUrl": "https://your-xchatbot-worker.example.com"
}
```

`wechatApiBaseUrl` 可覆盖配置里的值（适合 Worker 自报地址）。

### `xbot.inbound`

推送标准化入站消息：

```json
{
  "accountId": "Primary",
  "clientId": "xchatbot-worker",
  "connId": "xchatbot-worker-1",
  "messageId": "1234567890",
  "source": "group",
  "from": "wxid_sender",
  "senderName": "张三",
  "roomId": "12345678@chatroom",
  "type": "text",
  "content": "wxid_sender:\n@小聪明儿 你好",
  "timestamp": 1710000000000,
  "mentions": ["wxid_bot"],
  "botMentioned": true
}
```

私聊示例：

```json
{
  "messageId": "9876543210",
  "source": "private",
  "from": "wxid_friend",
  "senderName": "李四",
  "conversationId": "wxid_friend",
  "type": "text",
  "content": "在吗"
}
```

### `xbot.activity`

可选心跳，刷新连接 `lastActivityAt`。

## xchatbot 侧对接

在 xchatbot Worker 环境变量中配置：

```bash
XBOT_CHANNEL_ENABLED=true
# 可选，默认同 AGENT_BRIDGE_BASE_URL / AGENT_BRIDGE_TOKEN
XBOT_CHANNEL_GATEWAY_URL=http://127.0.0.1:18789
XBOT_CHANNEL_GATEWAY_TOKEN=<gateway-token>
```

启用后，webhook 会：

1. 调用 `xbot.connect`（附带 `wechatApiBaseUrl`）
2. 对每条白名单消息调用 `xbot.inbound`
3. 若 OpenClaw 已分发（`dispatched=true`），跳过本地插件，避免双回复
4. 若策略忽略或转发失败，回退本地插件链（点歌等仍可用）

## 开发

```bash
npm install
npm run typecheck
npm run build
```

## 兼容

- `openclaw >= 2026.5.27`
- 参照 [openclaw-bncr-channel](https://github.com/xmoxmo/openclaw-bncr-channel) 的频道插件结构

## License

MIT
