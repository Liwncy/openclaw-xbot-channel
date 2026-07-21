import { normalizeAccountId, resolveBotWechatId } from '../accounts.ts';
import type { ParsedXbotInbound, XbotChannelConfigRoot, XbotRoute } from '../types.ts';

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

function asBoolean(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const raw = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(raw)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(raw)) return false;
  }
  return fallback;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((item) => asString(item).trim()).filter(Boolean);
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function resolveSource(raw: unknown): 'private' | 'group' {
  const value = asString(raw).trim().toLowerCase();
  if (value === 'group' || value === 'chatroom') return 'group';
  return 'private';
}

function detectBotMention(args: {
  cfg: XbotChannelConfigRoot | null | undefined;
  content: string;
  mentions: string[];
  explicit?: boolean;
}): boolean {
  if (args.explicit === true) return true;
  const botId = resolveBotWechatId(args.cfg);
  const botName = asString(args.cfg?.channels?.xbot?.botWechatName).trim();
  if (botId && args.mentions.includes(botId)) return true;
  if (botId && args.content.includes(`@${botId}`)) return true;
  if (botId && args.content.includes(botId)) return true;
  if (botName && args.content.includes(botName)) return true;
  if (botName && args.content.includes(`@${botName}`)) return true;
  return false;
}

function buildRoute(peerKind: 'direct' | 'group', peerId: string, senderId: string): XbotRoute {
  if (peerKind === 'group') {
    return {
      kind: 'group',
      to: peerId,
      platform: 'wechat',
      groupId: peerId,
      userId: senderId,
    };
  }
  return {
    kind: 'direct',
    to: senderId,
    platform: 'wechat',
    userId: senderId,
  };
}

export function parseXbotInboundParams(
  params: unknown,
  cfg: XbotChannelConfigRoot | null | undefined,
): ParsedXbotInbound {
  const input = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  const accountId = normalizeAccountId(asString(input.accountId));
  const messageId = asString(input.messageId || input.msgId || input.id).trim();
  const source = resolveSource(input.source ?? input.chatType ?? input.kind);
  const senderId = asString(input.from || input.senderId || input.userId).trim();
  const senderName = asString(input.senderName || input.userName || input.nickname || senderId).trim();
  const roomId = asString(input.roomId || input.groupId || input.conversationId).trim();
  const conversationId = asString(input.conversationId).trim();
  const msgType = asString(input.type || input.msgType || 'text').trim().toLowerCase() || 'text';
  const content = asString(input.content || input.text || input.body);
  const mediaUrl = asString(input.mediaUrl || input.media || input.imageUrl).trim();
  const mediaKindRaw = asString(input.mediaKind || input.mediaType).trim().toLowerCase();
  const mediaKind =
    mediaKindRaw === 'video' || mediaKindRaw === 'emoji' || mediaKindRaw === 'image'
      ? mediaKindRaw as 'image' | 'video' | 'emoji'
      : undefined;
  const timestampRaw = Number(input.timestamp ?? input.ts ?? Date.now());
  const timestamp =
    Number.isFinite(timestampRaw) && timestampRaw > 0
      ? timestampRaw > 1_000_000_000_000
        ? Math.floor(timestampRaw)
        : Math.floor(timestampRaw * 1000)
      : Date.now();
  const mentions = asStringArray(input.mentions);
  const botMentioned = detectBotMention({
    cfg,
    content,
    mentions,
    explicit: asBoolean(input.botMentioned ?? input.atBot ?? input.mentioned),
  });

  const peer =
    source === 'group'
      ? {
          kind: 'group' as const,
          id: roomId || conversationId,
        }
      : {
          kind: 'direct' as const,
          id: senderId,
        };

  if (!messageId) {
    throw new Error('messageId is required');
  }
  if (!senderId) {
    throw new Error('from/senderId is required');
  }
  if (peer.kind === 'group' && !peer.id) {
    throw new Error('roomId/groupId is required for group messages');
  }

  const route = buildRoute(peer.kind, peer.id, senderId);
  const rawBody = content.trim() || `[${msgType}]`;

  return {
    accountId,
    messageId,
    peer,
    route,
    msgType,
    rawBody,
    ...(mediaUrl ? { mediaUrl } : {}),
    ...(mediaUrl && mediaKind ? { mediaKind } : {}),
    senderId,
    senderName,
    botMentioned,
    timestamp,
    clientId: asString(input.clientId).trim() || undefined,
    connId: asString(input.connId).trim() || undefined,
    xchatbotApiBaseUrl: asString(input.xchatbotApiBaseUrl).trim() || undefined,
    xchatbotAdminToken: asString(input.xchatbotAdminToken).trim() || undefined,
  };
}
