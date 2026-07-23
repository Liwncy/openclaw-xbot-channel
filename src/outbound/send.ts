import { randomUUID } from 'node:crypto';
import type { ChannelMessageSendResult } from 'openclaw/plugin-sdk/channel-message';
import { createMessageReceiptFromOutboundResults } from 'openclaw/plugin-sdk/channel-outbound';
import { normalizeAccountId, resolveWechatApiBaseUrl } from '../accounts.ts';
import { parseExplicitTarget, resolveOutboundReceiver } from '../targets.ts';
import type { XbotChannelConfigRoot, XbotReplyTarget, XbotRoute } from '../types.ts';
import {
  sendWechatImageUrl,
  sendWechatLink,
  sendWechatText,
  sendWechatVideoUrl,
  sendWechatVoiceUrl,
} from '../wechat-api.ts';
import { mapOpenClawPayloadToReplies, resolveOpenClawMediaKind } from './map-reply.ts';

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
  void accountId;
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
  const receiver = resolveOutboundReceiver(route);
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
  const caption = String(args.text || '').trim();

  // 复用统一映射，拿 news 标题等；直连网关时按 kind 分发
  const mapped = mapOpenClawPayloadToReplies({
    text: caption,
    mediaUrl,
    mimeType: args.mimeType,
    fileName: args.fileName,
    type: args.type,
    audioAsVoice,
  });
  const mediaReply = mapped.find((item) => item.type !== 'text');

  let result;
  switch (kind) {
    case 'voice':
      try {
        result = await sendWechatVoiceUrl(apiBase, receiver, mediaUrl, { caption });
      } catch {
        // 直连网关无 SILK 转换时，语音常失败，降级链接
        result = await sendWechatLink(apiBase, receiver, {
          url: mediaUrl,
          title: '语音',
          desc: '点击收听/下载',
        }, caption);
      }
      break;
    case 'video':
      result = await sendWechatVideoUrl(apiBase, receiver, mediaUrl, { caption });
      break;
    case 'audio':
    case 'file': {
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
