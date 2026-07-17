import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/core';
import { jsonResult } from 'openclaw/plugin-sdk/core';
import { parseExplicitTarget } from './targets.ts';
import type { XbotChannelConfigRoot } from './types.ts';

type ChatLogToolParams = {
  roomId?: string;
  sessionId?: string;
  limit?: number;
  maxChars?: number;
  textOnly?: boolean;
  direction?: 'all' | 'inbound' | 'outbound';
  actorType?: 'all' | 'member' | 'bot' | 'system';
  hours?: number;
  since?: string;
  until?: string;
};

type XchatbotChatLogResponse = {
  ok?: boolean;
  sessionId?: string;
  sessionType?: string;
  filters?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  messages?: unknown[];
  error?: string;
};

const XBOT_CHAT_HISTORY_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    roomId: {
      type: 'string',
      description: '微信群 roomId，例如 123456@chatroom；不填时优先默认当前群',
    },
    sessionId: {
      type: 'string',
      description: '显式会话 id；需要查私聊或指定会话时可传',
    },
    limit: {
      type: 'number',
      minimum: 1,
      maximum: 200,
      description: '最多返回多少条，默认 40',
    },
    maxChars: {
      type: 'number',
      minimum: 200,
      maximum: 20000,
      description: '消息文本总字数上限，默认 6000',
    },
    textOnly: {
      type: 'boolean',
      description: '只看有文本内容的消息，默认 true',
    },
    direction: {
      type: 'string',
      enum: ['all', 'inbound', 'outbound'],
      description: '消息方向，默认 all',
    },
    actorType: {
      type: 'string',
      enum: ['all', 'member', 'bot', 'system'],
      description: '发言者类型，默认 all',
    },
    hours: {
      type: 'number',
      minimum: 1,
      maximum: 720,
      description: '查最近多少小时；未传 since 时可用这个快速取时间窗',
    },
    since: {
      type: 'string',
      description: '起始时间，支持 ISO 时间字符串或 Unix 时间戳字符串',
    },
    until: {
      type: 'string',
      description: '结束时间，支持 ISO 时间字符串或 Unix 时间戳字符串',
    },
  },
} as const;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getChannelConfig(cfg: XbotChannelConfigRoot | null | undefined) {
  return cfg?.channels?.xbot || {};
}

function resolveChatLogApiBaseUrl(cfg: XbotChannelConfigRoot | null | undefined): string {
  const channelCfg = getChannelConfig(cfg);
  return asString(channelCfg.chatLogApiBaseUrl || channelCfg.wechatApiBaseUrl);
}

function resolveChatLogAdminToken(cfg: XbotChannelConfigRoot | null | undefined): string {
  return asString(getChannelConfig(cfg).chatLogAdminToken);
}

function resolveCurrentSessionId(toolContext: OpenClawPluginToolContext): string {
  const candidates = [
    toolContext.deliveryContext?.to,
  ];
  for (const candidate of candidates) {
    const raw = asString(candidate);
    if (!raw) continue;
    const parsed = parseExplicitTarget(raw);
    if (parsed?.route.kind === 'group') {
      return parsed.route.groupId || parsed.route.to;
    }
    if (raw.endsWith('@chatroom')) {
      return raw;
    }
  }
  return '';
}

function toBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function buildQueryPayload(params: ChatLogToolParams, toolContext: OpenClawPluginToolContext) {
  const sessionId = asString(params.sessionId) || asString(params.roomId) || resolveCurrentSessionId(toolContext);
  if (!sessionId) {
    throw new Error('xbot_chat_history 需要 roomId/sessionId，或者在当前微信群会话里调用');
  }

  const limit = toBoundedInteger(params.limit, 40, 1, 200);
  const maxChars = toBoundedInteger(params.maxChars, 6000, 200, 20000);
  const textOnly = toBoolean(params.textOnly, true);
  const direction = asString(params.direction).toLowerCase();
  const actorType = asString(params.actorType).toLowerCase();
  const since = asString(params.since);
  const until = asString(params.until);

  const payload: Record<string, unknown> = {
    sessionId,
    limit,
    maxChars,
    textOnly,
  };

  if (direction === 'inbound' || direction === 'outbound') {
    payload.direction = direction;
  }
  if (actorType === 'member' || actorType === 'bot' || actorType === 'system') {
    payload.actorType = actorType;
  }
  if (since) {
    payload.since = since;
  } else if (typeof params.hours === 'number' && Number.isFinite(params.hours) && params.hours > 0) {
    payload.since = Math.floor(Date.now() / 1000) - Math.floor(params.hours * 3600);
  }
  if (until) {
    payload.until = until;
  }
  return payload;
}

async function queryChatLogApi(args: {
  apiBaseUrl: string;
  adminToken?: string;
  payload: Record<string, unknown>;
}): Promise<XchatbotChatLogResponse> {
  const url = new URL('/admin/chat-log/query', args.apiBaseUrl).toString();
  const headers = new Headers({
    'content-type': 'application/json',
  });
  if (args.adminToken) {
    headers.set('authorization', `Bearer ${args.adminToken}`);
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(args.payload),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await response.text();
  const data = raw ? JSON.parse(raw) as XchatbotChatLogResponse : {};
  if (!response.ok || data.ok === false) {
    const reason = asString(data?.error) || `HTTP ${response.status}`;
    throw new Error(`xchatbot chat log query failed: ${reason}`);
  }
  return data;
}

export function registerXbotChatHistoryTool(api: OpenClawPluginApi): void {
  api.registerTool((toolContext) => {
    const tool: AnyAgentTool = {
      name: 'xbot_chat_history',
      label: 'Xbot Chat History',
      description: 'Query recent xchatbot chat history for the current WeChat group or an explicit session, then analyze or summarize it.',
      parameters: XBOT_CHAT_HISTORY_PARAMETERS as never,
      async execute(_toolCallId: string, rawParams: ChatLogToolParams) {
        const cfg = (toolContext.getRuntimeConfig?.() as XbotChannelConfigRoot | undefined)
          || (toolContext.runtimeConfig as XbotChannelConfigRoot | undefined)
          || (toolContext.config as XbotChannelConfigRoot | undefined)
          || {};
        const apiBaseUrl = resolveChatLogApiBaseUrl(cfg);
        if (!apiBaseUrl) {
          throw new Error('xbot_chat_history 需要配置 channels.xbot.chatLogApiBaseUrl，或至少配置 channels.xbot.wechatApiBaseUrl');
        }

        const payload = buildQueryPayload(rawParams || {}, toolContext);
        const result = await queryChatLogApi({
          apiBaseUrl,
          adminToken: resolveChatLogAdminToken(cfg) || undefined,
          payload,
        });

        return jsonResult(result);
      },
    };
    return tool;
  });
}
