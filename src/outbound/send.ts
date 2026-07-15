import { randomUUID } from 'node:crypto';
import type { ChannelMessageSendResult } from 'openclaw/plugin-sdk/channel-message';
import { createMessageReceiptFromOutboundResults } from 'openclaw/plugin-sdk/channel-outbound';
import { normalizeAccountId, resolveWechatApiBaseUrl } from '../accounts.ts';
import { parseExplicitTarget, resolveOutboundReceiver } from '../targets.ts';
import type { XbotChannelConfigRoot, XbotReplyTarget, XbotRoute } from '../types.ts';
import { sendWechatImageUrl, sendWechatText } from '../wechat-api.ts';

function buildSendResult(messageId?: string): ChannelMessageSendResult {
  const id = messageId || randomUUID();
  return {
    messageId: id,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ messageId: id, channel: 'xbot' }],
      sentAt: Date.now(),
    }),
  };
}

export async function sendXbotText(args: {
  cfg: XbotChannelConfigRoot;
  accountId?: string | null;
  to: string;
  text: string;
  wechatApiBaseUrl?: string;
  route?: XbotRoute;
}): Promise<ChannelMessageSendResult> {
  const accountId = normalizeAccountId(args.accountId);
  const apiBase = (args.wechatApiBaseUrl || resolveWechatApiBaseUrl(args.cfg)).trim();
  const parsed = parseExplicitTarget(args.to);
  const route = args.route || parsed?.route;
  if (!route) throw new Error(`invalid target: ${args.to}`);
  const receiver = resolveOutboundReceiver(route);
  const result = await sendWechatText(apiBase, receiver, args.text);
  return buildSendResult(result.messageId);
}

export async function sendXbotMedia(args: {
  cfg: XbotChannelConfigRoot;
  accountId?: string | null;
  to: string;
  text?: string;
  mediaUrl?: string;
  wechatApiBaseUrl?: string;
  route?: XbotRoute;
}): Promise<ChannelMessageSendResult> {
  const accountId = normalizeAccountId(args.accountId);
  void accountId;
  const apiBase = (args.wechatApiBaseUrl || resolveWechatApiBaseUrl(args.cfg)).trim();
  const parsed = parseExplicitTarget(args.to);
  const route = args.route || parsed?.route;
  if (!route) throw new Error(`invalid target: ${args.to}`);
  const receiver = resolveOutboundReceiver(route);
  const mediaUrl = String(args.mediaUrl || '').trim();
  if (!mediaUrl) throw new Error('mediaUrl is required');
  const result = await sendWechatImageUrl(apiBase, receiver, mediaUrl, args.text);
  return buildSendResult(result.messageId);
}

export function rememberReplyTarget(
  store: Map<string, XbotReplyTarget>,
  sessionKey: string,
  target: XbotReplyTarget,
): void {
  const key = sessionKey.trim();
  if (!key) return;
  store.set(key, target);
}

export function resolveReplyTargetBySession(
  store: Map<string, XbotReplyTarget>,
  sessionKey: string,
): XbotReplyTarget | null {
  return store.get(sessionKey.trim()) || null;
}
