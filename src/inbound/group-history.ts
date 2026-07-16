import {
  createChannelHistoryWindow,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
} from 'openclaw/plugin-sdk/reply-history';
import type { ParsedXbotInbound } from '../types.ts';

export type XbotHistoryEntry = HistoryEntry & {
  senderId?: string;
};

export type XbotGroupHistoryMap = Map<string, XbotHistoryEntry[]>;

export function buildXbotGroupHistoryKey(parsed: ParsedXbotInbound): string | null {
  if (parsed.peer.kind !== 'group') return null;
  const groupId = String(parsed.peer.id || '').trim();
  if (!groupId) return null;
  return `xbot:group:${groupId}`;
}

function normalizeHistoryLimit(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return DEFAULT_GROUP_HISTORY_LIMIT;
}

function normalizeTextBody(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatXbotSpeakerLabel(senderName: string, senderId: string): string {
  const id = senderId.trim();
  const name = senderName.trim();
  if (id && name && name !== id) return `${name}(${id})`;
  if (id) return id;
  if (name) return name;
  return '未知成员';
}

export function formatXbotGroupMemberLine(args: {
  senderName: string;
  senderId: string;
  body: string;
}): string {
  const label = formatXbotSpeakerLabel(args.senderName, args.senderId);
  const body = normalizeTextBody(args.body);
  return `群成员「${label}」说：${body || '[空消息]'}`;
}

export function recordXbotPendingGroupText(args: {
  historyMap: XbotGroupHistoryMap;
  parsed: ParsedXbotInbound;
  historyLimit?: number;
}): void {
  const limit = normalizeHistoryLimit(args.historyLimit);
  const historyKey = buildXbotGroupHistoryKey(args.parsed);
  const body = normalizeTextBody(args.parsed.rawBody);
  if (!historyKey || !body) return;
  if (args.parsed.msgType !== 'text' && !body.startsWith('[')) return;

  const msgId = String(args.parsed.messageId || '').trim();
  if (msgId) {
    const existing = args.historyMap.get(historyKey) || [];
    if (existing.some((entry) => entry.messageId === msgId)) return;
  }

  createChannelHistoryWindow({ historyMap: args.historyMap }).record({
    historyKey,
    limit,
    entry: {
      sender: args.parsed.senderName || args.parsed.senderId,
      senderId: args.parsed.senderId,
      body,
      timestamp: args.parsed.timestamp || Date.now(),
      messageId: args.parsed.messageId,
    },
  });
}

export function readXbotPendingGroupHistorySnapshot(args: {
  historyMap: XbotGroupHistoryMap;
  parsed: ParsedXbotInbound;
  historyLimit?: number;
}): XbotHistoryEntry[] {
  const limit = normalizeHistoryLimit(args.historyLimit);
  const historyKey = buildXbotGroupHistoryKey(args.parsed);
  if (!historyKey) return [];
  const entries = args.historyMap.get(historyKey) || [];
  if (entries.length === 0) return [];
  return entries.slice(-limit).map((entry) => ({ ...entry }));
}

export function clearXbotPendingGroupHistory(args: {
  historyMap: XbotGroupHistoryMap;
  parsed: ParsedXbotInbound;
  historyLimit?: number;
}): void {
  const limit = normalizeHistoryLimit(args.historyLimit);
  const historyKey = buildXbotGroupHistoryKey(args.parsed);
  if (!historyKey) return;
  createChannelHistoryWindow({ historyMap: args.historyMap }).clear({
    historyKey,
    limit,
  });
}

/** 把 pending 历史 + 当前消息拼进 agent 可见正文（带昵称和 wxid）。 */
export function buildXbotAgentBodyWithHistory(args: {
  entries: readonly XbotHistoryEntry[];
  currentSenderName: string;
  currentSenderId: string;
  currentBody: string;
}): string {
  const currentLine = formatXbotGroupMemberLine({
    senderName: args.currentSenderName,
    senderId: args.currentSenderId,
    body: args.currentBody,
  });
  if (args.entries.length === 0) return currentLine;

  const historyText = args.entries
    .map((entry) =>
      formatXbotGroupMemberLine({
        senderName: String(entry.sender || ''),
        senderId: String(entry.senderId || ''),
        body: String(entry.body || ''),
      }),
    )
    .join('\n');

  return [
    '[以下是你上次回复后的群聊上下文，供理解气氛；请回复最后一条]',
    historyText,
    '',
    '[当前消息]',
    currentLine,
  ].join('\n');
}

export { DEFAULT_GROUP_HISTORY_LIMIT };
