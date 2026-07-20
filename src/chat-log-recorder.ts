import { resolveBotWechatId, resolveBotWechatName } from './accounts.ts';
import type { XbotChannelConfigRoot, XbotReplyTarget } from './types.ts';
import type { WechatSendTextResult } from './wechat-api.ts';

type OutboundReplyRecord =
  | { type: 'text'; content: string }
  | { type: 'image'; mediaId: string; originalUrl?: string };

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

function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return undefined;
}

function pickRecord(source: unknown): Record<string, unknown> | null {
  return source && typeof source === 'object' && !Array.isArray(source)
    ? source as Record<string, unknown>
    : null;
}

function findRevokeFieldsInRecord(
  source: unknown,
  maxDepth = 3,
): {
  clientId?: string;
  newId?: string;
  createTime?: number;
} | null {
  const root = pickRecord(source);
  if (!root || maxDepth < 0) return null;

  const queue: Array<{ record: Record<string, unknown>; depth: number }> = [{ record: root, depth: 0 }];
  const seen = new Set<object>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current.record)) continue;
    seen.add(current.record);

    const newId = asString(
      current.record.new_id
      || current.record.new_msg_id
      || current.record.newId
      || current.record.msgid,
    );
    const clientId = asString(
      current.record.client_id
      || current.record.clientId
      || current.record.msg_id
      || current.record.id,
    ) || newId;
    const createTime = parseNumber(
      current.record.create_time
      || current.record.createTime
      || current.record.createtime
      || current.record.server_time,
    );

    if (newId) {
      return {
        newId,
        ...(clientId ? { clientId } : {}),
        ...(createTime != null ? { createTime } : {}),
      };
    }

    if (current.depth >= maxDepth) continue;
    for (const value of Object.values(current.record)) {
      const nested = pickRecord(value);
      if (nested) {
        queue.push({ record: nested, depth: current.depth + 1 });
      }
    }
  }

  return null;
}

function buildWechatRevoke(receiver: string, result: WechatSendTextResult) {
  const fromRaw = findRevokeFieldsInRecord(result.raw);
  if (fromRaw?.newId) {
    return {
      receiver,
      new_id: fromRaw.newId,
      ...(fromRaw.clientId ? { client_id: fromRaw.clientId } : {}),
      ...(fromRaw.createTime != null ? { create_time: fromRaw.createTime } : {}),
    };
  }
  const messageId = asString(result.messageId);
  if (!messageId) return undefined;
  return {
    receiver,
    new_id: messageId,
    client_id: messageId,
  };
}

function buildOutboundBody(args: {
  cfg: XbotChannelConfigRoot;
  replyTarget: XbotReplyTarget;
  reply: OutboundReplyRecord;
  replyIndex: number;
  wechatResult: WechatSendTextResult;
}) {
  const route = args.replyTarget.route;
  const source = route.kind === 'group' ? 'group' : 'private';
  const from = route.userId || route.to;
  const roomId = route.kind === 'group' ? (route.groupId || route.to) : '';
  const receiver = route.kind === 'group' ? roomId : from;
  return {
    source,
    from,
    ...(roomId ? { roomId } : {}),
    causedByMessageId: args.replyTarget.replyToMessageId,
    replyIndex: args.replyIndex,
    pluginName: 'openclaw-xbot',
    replyStatus: 'sent',
    botSenderId: resolveBotWechatId(args.cfg) || undefined,
    botSenderName: resolveBotWechatName(args.cfg) || undefined,
    reply: args.reply,
    wechatRevoke: buildWechatRevoke(receiver, args.wechatResult),
  };
}

export async function recordOutboundChatLogIfConfigured(args: {
  cfg: XbotChannelConfigRoot;
  replyTarget: XbotReplyTarget;
  reply: OutboundReplyRecord;
  replyIndex: number;
  wechatResult: WechatSendTextResult;
  onWarn?: (message: string) => void;
}): Promise<void> {
  const apiBaseUrl = resolveChatLogApiBaseUrl(args.cfg);
  if (!apiBaseUrl || !args.replyTarget.replyToMessageId) return;

  const url = new URL('/admin/chat-log/outbound', apiBaseUrl).toString();
  const headers = new Headers({ 'content-type': 'application/json' });
  const adminToken = resolveChatLogAdminToken(args.cfg);
  if (adminToken) {
    headers.set('authorization', `Bearer ${adminToken}`);
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildOutboundBody(args)),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      args.onWarn?.(
        `[xbot] outbound chat-log record failed: HTTP ${response.status}${text ? ` ${text}` : ''}`,
      );
    }
  } catch (error) {
    args.onWarn?.(
      `[xbot] outbound chat-log record failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
