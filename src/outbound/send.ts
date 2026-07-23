import { randomUUID } from 'node:crypto';
import type { ChannelMessageSendResult } from 'openclaw/plugin-sdk/channel-message';
import { createMessageReceiptFromOutboundResults } from 'openclaw/plugin-sdk/channel-outbound';
import { normalizeAccountId, resolveWechatApiBaseUrl } from '../accounts.ts';
import { parseExplicitTarget, resolveOutboundReceiver } from '../targets.ts';
import type { XbotChannelConfigRoot, XbotReplyTarget, XbotRoute } from '../types.ts';
import {
  buildReplyTargetForRoute,
  sendViaXchatbotIfConfigured,
} from '../xchatbot-outbound.ts';
import {
  sendWechatImageUrl,
  sendWechatLink,
  sendWechatText,
  sendWechatVideoUrl,
} from '../wechat-api.ts';
import { mapOpenClawPayloadToReplies, resolveOpenClawMediaKind } from './map-reply.ts';
import { normalizeWechatOutboundText } from './normalize-text.ts';

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

async function sendRepliesViaXchatbot(args: {
  cfg: XbotChannelConfigRoot;
  accountId?: string | null;
  route: XbotRoute;
  replies: import('./map-reply.ts').XchatbotReply[];
}): Promise<boolean> {
  const replyTarget = buildReplyTargetForRoute({
    cfg: args.cfg,
    accountId: args.accountId,
    route: args.route,
  });
  return sendViaXchatbotIfConfigured({
    cfg: args.cfg,
    replyTarget,
    replies: args.replies,
  });
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
  void accountId;
  const apiBase = (args.wechatApiBaseUrl || resolveWechatApiBaseUrl(args.cfg)).trim();
  const parsed = parseExplicitTarget(args.to);
  const route = args.route || parsed?.route;
  if (!route) throw new Error(`invalid target: ${args.to}`);
  const text = normalizeWechatOutboundText(args.text);
  if (!text) throw new Error('text is required');

  const relayed = await sendRepliesViaXchatbot({
    cfg: args.cfg,
    accountId: args.accountId,
    route,
    replies: [{ type: 'text', content: text }],
  });
  if (relayed) return buildSendResult();

  const receiver = resolveOutboundReceiver(route);
  const result = await sendWechatText(apiBase, receiver, text);
  return buildSendResult(result.messageId);
}

export async function sendXbotMedia(args: {
  cfg: XbotChannelConfigRoot;
  accountId?: string | null;
  to: string;
  text?: string;
  mediaUrl?: string;
  mimeType?: string;
  fileName?: string;
  type?: string;
  audioAsVoice?: boolean;
  asVoice?: boolean;
  wechatApiBaseUrl?: string;
  route?: XbotRoute;
}): Promise<ChannelMessageSendResult> {
  const accountId = normalizeAccountId(args.accountId);
  void accountId;
  const apiBase = (args.wechatApiBaseUrl || resolveWechatApiBaseUrl(args.cfg)).trim();
  const parsed = parseExplicitTarget(args.to);
  const route = args.route || parsed?.route;
  if (!route) throw new Error(`invalid target: ${args.to}`);
  const mediaUrl = String(args.mediaUrl || '').trim();
  if (!mediaUrl) throw new Error('mediaUrl is required');

  const audioAsVoice = args.audioAsVoice === true || args.asVoice === true;
  const kind = resolveOpenClawMediaKind({
    mediaUrl,
    mimeType: args.mimeType,
    fileName: args.fileName,
    hintedType: args.type,
    audioAsVoice,
  });
  const caption = normalizeWechatOutboundText(String(args.text || ''));

  const mapped = mapOpenClawPayloadToReplies({
    text: caption,
    mediaUrl,
    mimeType: args.mimeType,
    fileName: args.fileName,
    type: args.type,
    audioAsVoice,
  });

  // 语音/本地文件必须走 xchatbot（SILK + 读本地文件）；直连网关会变成无效链接卡片
  const relayed = await sendRepliesViaXchatbot({
    cfg: args.cfg,
    accountId: args.accountId,
    route,
    replies: mapped,
  });
  if (relayed) return buildSendResult();

  const receiver = resolveOutboundReceiver(route);
  const mediaReply = mapped.find((item) => item.type !== 'text');
  const httpMedia = /^https?:\/\//i.test(mediaUrl);

  let result;
  switch (kind) {
    case 'voice':
      // 无 xchatbot 时本地路径发不了语音，避免再发「语音链接」糊弄人
      if (!httpMedia) {
        throw new Error('voice send requires xchatbot outbound (local media / SILK conversion)');
      }
      throw new Error('voice send requires xchatbot outbound for SILK conversion');
    case 'video':
      if (!httpMedia) throw new Error('videoUrl must be an http(s) URL when xchatbot relay is unavailable');
      result = await sendWechatVideoUrl(apiBase, receiver, mediaUrl, { caption });
      break;
    case 'audio':
    case 'file': {
      if (!httpMedia) throw new Error('file url must be http(s) when xchatbot relay is unavailable');
      const article = mediaReply?.type === 'news' ? mediaReply.articles[0] : undefined;
      result = await sendWechatLink(apiBase, receiver, {
        url: mediaUrl,
        title: article?.title || '文件',
        desc: article?.description || '点击查看/下载',
      }, caption);
      break;
    }
    case 'image':
    default:
      if (!httpMedia) throw new Error('imageUrl must be an http(s) URL when xchatbot relay is unavailable');
      result = await sendWechatImageUrl(apiBase, receiver, mediaUrl, caption);
      break;
  }

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
