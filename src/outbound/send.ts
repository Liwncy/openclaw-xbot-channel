import { randomUUID } from 'node:crypto';
import type { ChannelMessageSendResult } from 'openclaw/plugin-sdk/channel-message';
import { createMessageReceiptFromOutboundResults } from 'openclaw/plugin-sdk/channel-outbound';
import { normalizeAccountId } from '../accounts.ts';
import { parseExplicitTarget } from '../targets.ts';
import type { XbotChannelConfigRoot, XbotReplyTarget, XbotRoute } from '../types.ts';
import type { XbotDeliveryStage, XbotOutboundResult } from './delivery.ts';
import { mapOpenClawPayloadToReplies } from './map-reply.ts';
import { normalizeWechatOutboundText } from './normalize-text.ts';
import { persistReplyTarget } from './reply-target-store.ts';
import { assertAgentOutboundOk, sendRepliesPipeline } from './send-pipeline.ts';

export type XbotChannelSendResult = ChannelMessageSendResult & {
  ok: boolean;
  deliveryStage: XbotDeliveryStage;
  sentCount: number;
  failedCount: number;
  errors: string[];
  voiceSent: boolean;
  mediaSent: boolean;
};

function buildChannelSendResult(result: XbotOutboundResult): XbotChannelSendResult {
  const id = result.messageId || randomUUID();
  return {
    messageId: id,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{
        messageId: id,
        channel: 'xbot',
        // SDK 若忽略未知字段也无妨；诊断靠顶层 deliveryStage
      }],
      sentAt: Date.now(),
    }),
    ok: result.ok,
    deliveryStage: result.stage,
    sentCount: result.sentCount,
    failedCount: result.failedCount,
    errors: result.errors,
    voiceSent: result.voiceSent,
    mediaSent: result.mediaSent,
  };
}

function resolveRoute(to: string, route?: XbotRoute): XbotRoute {
  if (route) return route;
  const parsed = parseExplicitTarget(to);
  if (!parsed?.route) throw new Error(`invalid target: ${to}`);
  return parsed.route;
}

export async function sendXbotText(args: {
  cfg: XbotChannelConfigRoot;
  accountId?: string | null;
  to: string;
  text: string;
  wechatApiBaseUrl?: string;
  route?: XbotRoute;
}): Promise<XbotChannelSendResult> {
  void normalizeAccountId(args.accountId);
  const route = resolveRoute(args.to, args.route);
  const text = normalizeWechatOutboundText(args.text);
  if (!text) throw new Error('text is required');

  const outbound = await sendRepliesPipeline({
    cfg: args.cfg,
    accountId: args.accountId,
    route,
    replies: [{ type: 'text', content: text }],
    wechatApiBaseUrl: args.wechatApiBaseUrl,
    onWarn: (message) => console.warn(message),
  });
  assertAgentOutboundOk(outbound);
  return buildChannelSendResult(outbound);
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
}): Promise<XbotChannelSendResult> {
  void normalizeAccountId(args.accountId);
  const route = resolveRoute(args.to, args.route);
  const mediaUrl = String(args.mediaUrl || '').trim();
  const audioAsVoice = args.audioAsVoice === true || args.asVoice === true;
  if (!mediaUrl) {
    throw new Error(
      audioAsVoice
        ? 'send voice requires media (tts audio path or mediaUrl); asVoice alone is not enough'
        : 'mediaUrl is required',
    );
  }

  const caption = normalizeWechatOutboundText(String(args.text || ''));
  const mapped = mapOpenClawPayloadToReplies({
    text: caption,
    mediaUrl,
    mimeType: args.mimeType,
    fileName: args.fileName,
    type: args.type,
    audioAsVoice,
  });

  const outbound = await sendRepliesPipeline({
    cfg: args.cfg,
    accountId: args.accountId,
    route,
    replies: mapped,
    wechatApiBaseUrl: args.wechatApiBaseUrl,
    onWarn: (message) => console.warn(message),
  });
  assertAgentOutboundOk(outbound);
  return buildChannelSendResult(outbound);
}

export function rememberReplyTarget(
  store: Map<string, XbotReplyTarget>,
  sessionKey: string,
  target: XbotReplyTarget,
): void {
  const key = sessionKey.trim();
  if (!key) return;
  store.set(key, target);
  void persistReplyTarget(key, target);
}

export function resolveReplyTargetBySession(
  store: Map<string, XbotReplyTarget>,
  sessionKey: string,
): XbotReplyTarget | null {
  return store.get(sessionKey.trim()) || null;
}
