# openclaw-xbot-channel

OpenClaw 的 **xchatbot 微信频道**插件（`channelId=xbot`）。

把 [xchatbot](https://github.com/lwc--/xchatbot) 的微信入站推送接到 OpenClaw Agent，出站通过 xchatbot 的 `WECHAT_API_BASE_URL` 发回微信（私聊 + 群聊）。

## 架构

```text
微信消息 → xchatbot Worker (/webhook/wechat)
         → OpenClaw Gateway (xbot.inbound)
         → Agent 推理
         → xbot 出站 HTTP (/api/message/text)
         → 微信回复
```

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
| `requireMention` | 群聊是否必须 @ 机器人才分发（默认 `true`） |

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
