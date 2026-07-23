import {
  queryChatLogApi,
  resolveChatLogAdminToken,
  resolveChatLogApiBaseUrl,
  resolveSessionIdFromPeer,
  toBoundedInteger,
  type ChatLogMessageView,
} from '../chat-log-client.ts';
import type { ParsedXbotInbound, XbotChannelConfigRoot } from '../types.ts';
import { formatXbotSpeakerLabel } from './group-history.ts';

const DEFAULT_CONTEXT_HISTORY_LIMIT = 20;
const DEFAULT_CONTEXT_MAX_CHARS = 4000;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTextBody(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function resolveInjectChatContextEnabled(channelCfg: Record<string, unknown> | undefined): boolean {
  const value = channelCfg?.injectChatContext;
  if (typeof value === 'boolean') return value;
  return true;
}

export function resolveContextHistoryLimit(channelCfg: Record<string, unknown> | undefined): number {
  return toBoundedInteger(channelCfg?.contextHistoryLimit, DEFAULT_CONTEXT_HISTORY_LIMIT, 1, 200);
}

export function resolveContextMaxChars(channelCfg: Record<string, unknown> | undefined): number {
  return toBoundedInteger(channelCfg?.contextMaxChars, DEFAULT_CONTEXT_MAX_CHARS, 200, 20000);
}

function formatContextLine(args: {
  peerKind: 'direct' | 'group';
  message: ChatLogMessageView;
}): string {
  const body = normalizeTextBody(asString(args.message.contentText)) || `[${asString(args.message.msgType) || '消息'}]`;
  const actorType = asString(args.message.actorType).toLowerCase();
  const direction = asString(args.message.direction).toLowerCase();

  if (actorType === 'bot' || direction === 'outbound') {
    return `机器人：${body}`;
  }

  const label = formatXbotSpeakerLabel(
    asString(args.message.senderName),
    asString(args.message.senderId),
  );
  if (args.peerKind === 'group') {
    return `群成员「${label}」说：${body}`;
  }
  return `「${label}」说：${body}`;
}

export function formatChatContextBlock(args: {
  peerKind: 'direct' | 'group';
  messages: ChatLogMessageView[];
  excludeMessageId?: string;
  currentSenderName: string;
  currentSenderId: string;
  currentBody: string;
}): string | null {
  const excludeId = asString(args.excludeMessageId);
  const historyLines = (args.messages || [])
    .filter((message) => {
      const messageId = asString(message.messageId);
      if (excludeId && messageId && messageId === excludeId) return false;
      return Boolean(normalizeTextBody(asString(message.contentText)) || asString(message.msgType));
    })
    .map((message) => formatContextLine({ peerKind: args.peerKind, message }));

  const currentLine = args.peerKind === 'group'
    ? `群成员「${formatXbotSpeakerLabel(args.currentSenderName, args.currentSenderId)}」说：${normalizeTextBody(args.currentBody) || '[空消息]'}`
    : (normalizeTextBody(args.currentBody) || '[空消息]');

  if (historyLines.length === 0) {
    return null;
  }

  return [
    '[近期聊天上下文，供理解；请回复最后一条]',
    ...historyLines,
    '',
    '[当前消息]',
    currentLine,
  ].join('\n');
}

/**
 * 从 D1 拉取近期聊天并拼成 Agent 可见正文。
 * 失败返回 null，由调用方回退旧逻辑。
 */
export async function loadInjectedChatContextBody(args: {
  cfg: XbotChannelConfigRoot;
  channelCfg: Record<string, unknown>;
  parsed: ParsedXbotInbound;
  onWarn?: (message: string) => void;
}): Promise<string | null> {
  if (!resolveInjectChatContextEnabled(args.channelCfg)) {
    return null;
  }

  const apiBaseUrl = resolveChatLogApiBaseUrl(args.cfg, args.parsed.xchatbotApiBaseUrl);
  if (!apiBaseUrl) {
    args.onWarn?.('[xbot] inject chat context skipped: chatLogApiBaseUrl/wechatApiBaseUrl missing');
    return null;
  }

  const adminToken = resolveChatLogAdminToken(args.cfg, args.parsed.xchatbotAdminToken);
  const sessionId = resolveSessionIdFromPeer(args.parsed.peer);
  if (!sessionId) {
    args.onWarn?.('[xbot] inject chat context skipped: sessionId empty');
    return null;
  }

  try {
    const result = await queryChatLogApi({
      apiBaseUrl,
      adminToken: adminToken || undefined,
      payload: {
        sessionId,
        limit: resolveContextHistoryLimit(args.channelCfg),
        maxChars: resolveContextMaxChars(args.channelCfg),
        textOnly: false,
      },
    });

    return formatChatContextBlock({
      peerKind: args.parsed.peer.kind,
      messages: Array.isArray(result.messages) ? result.messages : [],
      excludeMessageId: args.parsed.messageId,
      currentSenderName: args.parsed.senderName,
      currentSenderId: args.parsed.senderId,
      currentBody: args.parsed.rawBody,
    });
  } catch (error) {
    args.onWarn?.(
      `[xbot] inject chat context failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
