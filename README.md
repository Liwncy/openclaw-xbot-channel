# openclaw-xbot-channel

OpenClaw 只连 [xchatbot](https://github.com/lwc--/xchatbot)，不认微信 / Golem / 其它适配器。

哪个适配器进的消息，由 xchatbot 带 `platform`；回复也只 POST 回 xchatbot，再由对应适配器发出去。

```text
适配器 → xchatbot（过滤、点名、转 URL）
       → POST /api/channels/xbot/inbound
       → OpenClaw Agent
       → POST xchatbot /openclaw/outbound
       → 原适配器发出去
```

## 职责

| 谁 | 做什么 |
|---|---|
| **xchatbot** | 所有适配器进出、过滤、媒体 URL、`/openclaw/outbound` |
| **本频道** | 收 inbound、跑 Agent、把回复 POS 回 xchatbot |

## 配置

```json
{
  "channels": {
    "xbot": {
      "enabled": true,
      "xchatbotApiBaseUrl": "https://xbot.example.com",
      "xchatbotToken": "<same as AGENT_BRIDGE_TOKEN>",
      "botName": "小聪明儿",
      "accounts": {
        "Primary": { "enabled": true, "name": "小聪明儿" }
      }
    }
  }
}
```

`wechatApiBaseUrl` 已废弃，可以删。

## 入站

xchatbot POST `/api/channels/xbot/inbound`，必须带 `platform`（如 `golem`、`web`）。

## 出站

频道 POST `{xchatbotApiBaseUrl}/openclaw/outbound`，Bearer 为 `xchatbotToken`。

## 开发

```bash
npm install
npm run typecheck
npm run selfcheck
npm run build
```
