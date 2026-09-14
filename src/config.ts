import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

export const CHANNEL_ID = 'xbot';
export const DEFAULT_ACCOUNT_ID = 'Primary';
export const GATEWAY_METHODS = [
  'xbot.connect',
  'xbot.inbound',
  'xbot.diagnostics',
] as const;

export type XbotAccountConfig = {
  enabled?: boolean;
  name?: string;
};

export type XbotChannelConfigSection = {
  enabled?: boolean;
  xchatbotApiBaseUrl?: string;
  xchatbotToken?: string;
  botName?: string;
  accounts?: Record<string, XbotAccountConfig | undefined>;
};

export type XbotChannelConfigRoot = {
  channels?: {
    xbot?: XbotChannelConfigSection;
  };
};

export type XbotPeer = {
  kind: 'direct' | 'group';
  id: string;
};

export type XbotRoute = {
  kind: 'direct' | 'group';
  platform: string;
  to: string;
  groupId?: string;
  userId?: string;
};

export type ParsedXbotInbound = {
  accountId: string;
  messageId: string;
  platform: string;
  peer: XbotPeer;
  route: XbotRoute;
  msgType: string;
  rawBody: string;
  mediaUrl?: string;
  mediaKind?: 'image' | 'video' | 'emoji' | 'voice';
  videoUrl?: string;
  senderId: string;
  senderName: string;
  timestamp: number;
};

export type XbotReplyTarget = {
  accountId: string;
  to: string;
  route: XbotRoute;
  replyToMessageId?: string;
};

export type XchatbotReply =
  | { type: 'text'; content: string }
  | { type: 'image'; url: string }
  | { type: 'voice'; url: string; format?: string; duration?: number }
  | { type: 'video'; url: string; duration?: number }
  | { type: 'link'; title: string; url: string; description?: string; picUrl?: string };

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

export const XbotConfigSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    enabled: { type: 'boolean' },
    xchatbotApiBaseUrl: { type: 'string' },
    xchatbotToken: { type: 'string' },
    botName: { type: 'string' },
    accounts: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: true,
        properties: {
          enabled: { type: 'boolean' },
          name: { type: 'string' },
        },
      },
    },
  },
} as const;

export function getOpenClawRuntimeConfig(api: OpenClawPluginApi): XbotChannelConfigRoot {
  const config = api?.runtime?.config;
  if (!config || typeof config !== 'object') {
    throw new Error('OpenClaw runtime config API is unavailable');
  }
  const typed = config as { current?: () => XbotChannelConfigRoot; get?: () => XbotChannelConfigRoot };
  if (typeof typed.current === 'function') return typed.current();
  if (typeof typed.get === 'function') return typed.get();
  throw new Error('OpenClaw runtime config read API is unavailable');
}

export function normalizeAccountId(accountId?: string | null): string {
  const value = asString(accountId).trim();
  if (!value) return DEFAULT_ACCOUNT_ID;
  const lower = value.toLowerCase();
  if (lower === 'default' || lower === 'primary') return DEFAULT_ACCOUNT_ID;
  return value;
}

export function resolveDefaultDisplayName(rawName: unknown, accountId: string): string {
  const raw = asString(rawName).trim();
  if (!raw || raw === accountId || /^xbot$/i.test(raw)) return 'xchatbot';
  return raw;
}

function getChannelConfig(cfg: XbotChannelConfigRoot | null | undefined) {
  return cfg?.channels?.[CHANNEL_ID] || {};
}

export function resolveAccount(cfg: XbotChannelConfigRoot | null | undefined, accountId?: string | null) {
  const accounts = getChannelConfig(cfg).accounts || {};
  let key = normalizeAccountId(accountId);
  if (!accounts[key]) {
    const first = Object.keys(accounts)[0];
    if (first) key = first;
  }
  const account = accounts[key] || {};
  return {
    accountId: key,
    name: resolveDefaultDisplayName(account?.name, key),
    enabled: account?.enabled !== false,
  };
}

export function listAccountIds(cfg: XbotChannelConfigRoot | null | undefined): string[] {
  const ids = Object.keys(getChannelConfig(cfg).accounts || {});
  return ids.length ? ids : [DEFAULT_ACCOUNT_ID];
}

export function resolveXchatbotApiBaseUrl(cfg: XbotChannelConfigRoot | null | undefined): string {
  return asString(getChannelConfig(cfg).xchatbotApiBaseUrl).trim();
}

export function resolveXchatbotToken(cfg: XbotChannelConfigRoot | null | undefined): string {
  return asString(getChannelConfig(cfg).xchatbotToken).trim();
}

export function resolveBotName(cfg: XbotChannelConfigRoot | null | undefined): string {
  return asString(getChannelConfig(cfg).botName).trim() || '小聪明儿';
}

export function resolveXbotConfigWarnings(cfg: XbotChannelConfigRoot | null | undefined): string[] {
  if (resolveXchatbotApiBaseUrl(cfg)) return [];
  return [`channels.${CHANNEL_ID}.xchatbotApiBaseUrl is not configured`];
}
