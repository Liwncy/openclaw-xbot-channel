import type { XbotChannelConfigRoot } from './types.ts';

export type ChatLogQueryParams = {
  sessionId: string;
  limit?: number;
  maxChars?: number;
  textOnly?: boolean;
  direction?: 'inbound' | 'outbound';
  actorType?: 'member' | 'bot' | 'system';
  since?: string | number;
  until?: string | number;
};

export type ChatLogMessageView = {
  id?: number;
  messageId?: string;
  createdAt?: number;
  createdAtIso?: string;
  direction?: string;
  actorType?: string;
  senderId?: string;
  senderName?: string;
  msgType?: string;
  contentText?: string;
  pluginName?: string;
  replyStatus?: string;
};

export type XchatbotChatLogResponse = {
  ok?: boolean;
  sessionId?: string;
  sessionType?: string;
  filters?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  messages?: ChatLogMessageView[];
  error?: string;
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getChannelConfig(cfg: XbotChannelConfigRoot | null | undefined) {
  return cfg?.channels?.xbot || {};
}

export function resolveChatLogApiBaseUrl(
  cfg: XbotChannelConfigRoot | null | undefined,
  override?: string,
): string {
  const channelCfg = getChannelConfig(cfg);
  return asString(override || channelCfg.chatLogApiBaseUrl || channelCfg.wechatApiBaseUrl);
}

export function resolveChatLogAdminToken(
  cfg: XbotChannelConfigRoot | null | undefined,
  override?: string,
): string {
  return asString(override || getChannelConfig(cfg).chatLogAdminToken);
}

export function toBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

export async function queryChatLogApi(args: {
  apiBaseUrl: string;
  adminToken?: string;
  payload: ChatLogQueryParams;
}): Promise<XchatbotChatLogResponse> {
  const apiBaseUrl = asString(args.apiBaseUrl);
  if (!apiBaseUrl) {
    throw new Error('chat log apiBaseUrl is empty');
  }

  const url = new URL('/admin/chat-log/query', apiBaseUrl).toString();
  const headers = new Headers({
    'content-type': 'application/json',
  });
  const adminToken = asString(args.adminToken);
  if (adminToken) {
    headers.set('authorization', `Bearer ${adminToken}`);
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

export function resolveSessionIdFromPeer(peer: { kind: 'direct' | 'group'; id: string }): string {
  const id = asString(peer.id);
  if (!id) return '';
  if (peer.kind === 'group') return id;
  if (id.startsWith('private:')) return id;
  return `private:${id}`;
}
