import { randomUUID } from 'node:crypto';
import { resolveBotWechatId, resolveBotWechatName } from './accounts.ts';
import type { XchatbotReply } from './outbound/map-reply.ts';
import { resolveLocalMediaInReplies } from './outbound/resolve-local-media.ts';
import {
  filterDuplicateReplies,
  rememberRepliesSent,
} from './outbound/send-dedupe.ts';
import {
  convertAudioToSilkBase64,
  isLikelyAlreadySilk,
} from './outbound/local-silk-convert.ts';
import { markVoiceRecentlySent } from './outbound/voice-narrative-guard.ts';
import type { XbotChannelConfigRoot, XbotReplyTarget, XbotRoute } from './types.ts';

export type { XchatbotReply };

type XchatbotOutboundResponse = {
  ok?: boolean;
  failedCount?: number;
  results?: Array<{ replyIndex?: number; sent?: boolean; error?: string }>;
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getChannelConfig(cfg: XbotChannelConfigRoot | null | undefined) {
  return cfg?.channels?.xbot || {};
}

function resolveXchatbotApiBaseUrl(
  cfg: XbotChannelConfigRoot | null | undefined,
  replyTarget?: Pick<XbotReplyTarget, 'xchatbotApiBaseUrl'>,
): string {
  return asString(replyTarget?.xchatbotApiBaseUrl || getChannelConfig(cfg).chatLogApiBaseUrl);
}

function resolveXchatbotAdminToken(
  cfg: XbotChannelConfigRoot | null | undefined,
  replyTarget?: Pick<XbotReplyTarget, 'xchatbotAdminToken'>,
): string {
  return asString(replyTarget?.xchatbotAdminToken || getChannelConfig(cfg).chatLogAdminToken);
}

function buildOutboundBody(args: {
  cfg: XbotChannelConfigRoot;
  replyTarget: XbotReplyTarget;
  replies: XchatbotReply[];
}) {
  const route = args.replyTarget.route;
  const botSenderId = resolveBotWechatId(args.cfg);
  const botSenderName = resolveBotWechatName(args.cfg);
  const causedByMessageId = asString(args.replyTarget.replyToMessageId) || `xbot-outbound-${randomUUID()}`;
  return {
    source: route.kind === 'group' ? 'group' : 'private',
    from: route.userId || route.to,
    to: route.to,
    ...(route.kind === 'group' ? { roomId: route.groupId || route.to } : {}),
    causedByMessageId,
    pluginName: 'openclaw-xbot',
    ...(botSenderId ? { botSenderId } : {}),
    ...(botSenderName ? { botSenderName } : {}),
    replies: args.replies,
  };
}

export function buildReplyTargetForRoute(args: {
  cfg: XbotChannelConfigRoot;
  accountId?: string | null;
  route: XbotRoute;
  replyToMessageId?: string;
}): XbotReplyTarget {
  return {
    accountId: asString(args.accountId) || 'default',
    to: args.route.to,
    route: args.route,
    replyToMessageId: asString(args.replyToMessageId) || undefined,
    xchatbotApiBaseUrl: resolveXchatbotApiBaseUrl(args.cfg),
    xchatbotAdminToken: resolveXchatbotAdminToken(args.cfg),
  };
}

async function ensureLocalSilkForVoiceReplies(args: {
  replies: XchatbotReply[];
  onWarn?: (message: string) => void;
}): Promise<XchatbotReply[]> {
  const out: XchatbotReply[] = [];
  for (const reply of args.replies) {
    if (reply.type !== 'voice') {
      out.push(reply);
      continue;
    }
    const mediaId = (reply.mediaId || '').trim();
    if (!mediaId) {
      args.onWarn?.('[xbot] skip voice without mediaId');
      continue;
    }
    if (isLikelyAlreadySilk({ format: reply.format, mediaId })) {
      out.push({
        type: 'voice',
        mediaId,
        format: 4,
        duration: reply.duration,
      });
      continue;
    }
    try {
      const silk = await convertAudioToSilkBase64({ media: mediaId });
      args.onWarn?.(
        `[xbot] local silk convert ${silk.converted ? 'ok' : 'passthrough'} bytes≈${Math.floor(silk.base64.length * 0.75)}`,
      );
      out.push({
        type: 'voice',
        mediaId: silk.base64,
        format: 4,
        duration: reply.duration,
        // 已是内联 SILK；不带 failure fallback，避免成功后再被别的失败文案盖掉观感
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 单条坏媒体（如模型瞎写的 MEDIA:tts:）不拖垮同批已转好的语音
      args.onWarn?.(`[xbot] skip voice after local silk convert failed: ${message}`);
    }
  }
  return out;
}

export async function sendViaXchatbotIfConfigured(args: {
  cfg: XbotChannelConfigRoot;
  replyTarget: XbotReplyTarget;
  replies: XchatbotReply[];
  onWarn?: (message: string) => void;
}): Promise<boolean> {
  const apiBaseUrl = resolveXchatbotApiBaseUrl(args.cfg, args.replyTarget);
  const adminToken = resolveXchatbotAdminToken(args.cfg, args.replyTarget);
  if (!apiBaseUrl || !adminToken || args.replies.length === 0) {
    return false;
  }

  const url = new URL('/admin/xbot/outbound', apiBaseUrl).toString();
  const to = args.replyTarget.route.groupId
    || args.replyTarget.route.userId
    || args.replyTarget.to;

  try {
    const resolved = await resolveLocalMediaInReplies(args.replies);
    const voiceIn = resolved.filter((item) => item.type === 'voice').length;
    const withSilk = await ensureLocalSilkForVoiceReplies({
      replies: resolved,
      onWarn: args.onWarn,
    });
    const voiceOut = withSilk.filter((item) => item.type === 'voice').length;
    if (voiceIn > 0 && voiceOut === 0) {
      args.onWarn?.(`[xbot] xchatbot outbound failed: all ${voiceIn} voice item(s) failed local convert`);
      return false;
    }
    const { replies, skipped } = filterDuplicateReplies({ to, replies: withSilk });
    if (skipped > 0) {
      args.onWarn?.(`[xbot] skip ${skipped} duplicate reply item(s) within 45s`);
    }
    if (replies.length === 0) {
      // 全是短时重复：若刚发过语音，当作成功，别让模型改口说失败
      if (voiceIn > 0) markVoiceRecentlySent(to);
      return true;
    }

    const mediaKinds = replies
      .filter((item) => item.type !== 'text')
      .map((item) => item.type)
      .join(',');
    if (mediaKinds) {
      args.onWarn?.(`[xbot] outbound media kinds=${mediaKinds} count=${replies.length}`);
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildOutboundBody({ ...args, replies })),
    });
    const responseText = await response.text().catch(() => '');
    let responseJson: XchatbotOutboundResponse | null = null;
    try {
      responseJson = responseText
        ? JSON.parse(responseText) as XchatbotOutboundResponse
        : null;
    } catch {
      responseJson = null;
    }
    const results = responseJson?.results || [];
    const failedCount = Number(responseJson?.failedCount || 0);
    const voiceIndexes = new Set(
      replies
        .map((item, index) => (item.type === 'voice' ? index : -1))
        .filter((index) => index >= 0),
    );
    const anyVoiceSent = results.some(
      (item) => item?.sent === true && voiceIndexes.has(Number(item.replyIndex)),
    );
    const voiceErrors = results
      .filter((item) => item && item.sent === false && item.error)
      .map((item) => String(item.error))
      .slice(0, 3);

    // 只要有语音真实发出，就记一笔：后面模型的失败定论要丢掉
    if (anyVoiceSent || (response.ok && replies.some((item) => item.type === 'voice'))) {
      markVoiceRecentlySent(to);
    }

    if (!response.ok || responseJson?.ok === false || failedCount > 0) {
      const detail = voiceErrors.length > 0
        ? ` ${voiceErrors.join(' | ')}`
        : (responseText ? ` ${responseText.slice(0, 300)}` : '');
      args.onWarn?.(
        `[xbot] xchatbot outbound failed: HTTP ${response.status} failedCount=${failedCount}${detail}`,
      );
      // 部分成功（例如语音到了、旁白失败）按已送达处理，避免模型再报「没发出去」
      if (anyVoiceSent) {
        rememberRepliesSent({
          to,
          replies: replies.filter((_, index) =>
            results.some((item) => item?.sent === true && Number(item.replyIndex) === index)),
        });
        return true;
      }
      return false;
    }
    rememberRepliesSent({ to, replies });
    return true;
  } catch (error) {
    args.onWarn?.(
      `[xbot] xchatbot outbound failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
