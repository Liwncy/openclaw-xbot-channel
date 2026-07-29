import { randomUUID } from 'node:crypto';
import { resolveBotWechatId, resolveBotWechatName } from './accounts.ts';
import {
  buildOutboundResult,
  type XbotOutboundResult,
} from './outbound/delivery.ts';
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
import { recordSilkError } from './outbound/http-outbox.ts';
import { markVoiceRecentlySent } from './outbound/voice-narrative-guard.ts';
import type { XbotChannelConfigRoot, XbotReplyTarget, XbotRoute } from './types.ts';

export type { XchatbotReply };
export type { XbotOutboundResult };

type XchatbotOutboundResponse = {
  ok?: boolean;
  sentCount?: number;
  failedCount?: number;
  results?: Array<{ replyIndex?: number; sent?: boolean; error?: string }>;
};

/** Worker 出站 HTTP 超时；卡住时宁可 failed 进 outbox，别无限挂起 */
const OUTBOUND_FETCH_TIMEOUT_MS = 90_000;

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
  const channelCfg = getChannelConfig(cfg);
  return asString(
    replyTarget?.xchatbotApiBaseUrl
    || channelCfg.chatLogApiBaseUrl
    || channelCfg.wechatApiBaseUrl,
  );
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

export function isXchatbotOutboundConfigured(
  cfg: XbotChannelConfigRoot,
  replyTarget?: Pick<XbotReplyTarget, 'xchatbotApiBaseUrl' | 'xchatbotAdminToken'>,
): boolean {
  return Boolean(
    resolveXchatbotApiBaseUrl(cfg, replyTarget)
    && resolveXchatbotAdminToken(cfg, replyTarget),
  );
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
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      args.onWarn?.(`[xbot] skip voice after local silk convert failed: ${message}`);
      void recordSilkError(message);
    }
  }
  return out;
}

function replyNeedsXchatbot(reply: XchatbotReply): boolean {
  if (reply.type === 'voice') return true;
  if (reply.type === 'text' || reply.type === 'news') return false;
  const mediaId = (reply.mediaId || '').trim();
  if (!mediaId) return false;
  if (/^https?:\/\//i.test(mediaId)) return false;
  // 本地路径 / 内联 base64 必须走 Worker
  return true;
}

export function repliesRequireXchatbot(replies: XchatbotReply[]): boolean {
  return replies.some((item) => replyNeedsXchatbot(item));
}

/**
 * 经 xchatbot `/admin/xbot/outbound` 发送。
 * 返回结构化投递结果；未配置时 stage=unconfigured（由上层决定是否直连降级）。
 */
export async function sendViaXchatbotIfConfigured(args: {
  cfg: XbotChannelConfigRoot;
  replyTarget: XbotReplyTarget;
  replies: XchatbotReply[];
  onWarn?: (message: string) => void;
}): Promise<XbotOutboundResult> {
  const messageId = randomUUID();
  const apiBaseUrl = resolveXchatbotApiBaseUrl(args.cfg, args.replyTarget);
  const adminToken = resolveXchatbotAdminToken(args.cfg, args.replyTarget);
  if (!apiBaseUrl || !adminToken) {
    return buildOutboundResult({
      stage: 'unconfigured',
      messageId,
      detail: 'xchatbot outbound not configured',
    });
  }
  if (args.replies.length === 0) {
    return buildOutboundResult({
      stage: 'wechat-ok',
      messageId,
      detail: 'empty replies',
    });
  }

  const url = new URL('/admin/xbot/outbound', apiBaseUrl).toString();
  const to = args.replyTarget.route.groupId
    || args.replyTarget.route.userId
    || args.replyTarget.to;

  try {
    const resolved = await resolveLocalMediaInReplies(args.replies);
    const voiceIn = resolved.filter((item) => item.type === 'voice').length;
    const mediaIn = resolved.filter((item) => item.type !== 'text').length;
    const withSilk = await ensureLocalSilkForVoiceReplies({
      replies: resolved,
      onWarn: args.onWarn,
    });
    const voiceOut = withSilk.filter((item) => item.type === 'voice').length;
    if (voiceIn > 0 && voiceOut === 0) {
      const detail = `all ${voiceIn} voice item(s) failed local convert`;
      args.onWarn?.(`[xbot] xchatbot outbound failed: ${detail}`);
      return buildOutboundResult({
        stage: 'failed',
        messageId,
        failedCount: voiceIn,
        errors: [detail],
        detail,
      });
    }

    const { replies, skipped } = filterDuplicateReplies({ to, replies: withSilk });
    if (skipped > 0) {
      args.onWarn?.(`[xbot] skip ${skipped} duplicate reply item(s) within 45s`);
    }
    if (replies.length === 0) {
      if (voiceIn > 0) markVoiceRecentlySent(to);
      return buildOutboundResult({
        stage: 'deduped',
        messageId,
        voiceSent: voiceIn > 0,
        mediaSent: mediaIn > 0,
        detail: `skipped ${skipped} duplicate reply item(s)`,
      });
    }

    const mediaKinds = replies
      .filter((item) => item.type !== 'text')
      .map((item) => item.type)
      .join(',');
    if (mediaKinds) {
      args.onWarn?.(`[xbot] outbound media kinds=${mediaKinds} count=${replies.length}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OUTBOUND_FETCH_TIMEOUT_MS);
    let response: Response;
    let responseText = '';
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(buildOutboundBody({ ...args, replies })),
        signal: controller.signal,
      });
      responseText = await response.text().catch(() => '');
    } catch (error) {
      const aborted = controller.signal.aborted
        || (error instanceof Error && /abort/i.test(error.message));
      const detail = aborted
        ? `fetch timeout after ${OUTBOUND_FETCH_TIMEOUT_MS}ms`
        : (error instanceof Error ? error.message : String(error));
      throw new Error(detail);
    } finally {
      clearTimeout(timer);
    }
    let responseJson: XchatbotOutboundResponse | null = null;
    try {
      responseJson = responseText
        ? JSON.parse(responseText) as XchatbotOutboundResponse
        : null;
    } catch {
      responseJson = null;
    }

    const results = responseJson?.results || [];
    const sentIndexes = new Set(
      results
        .filter((item) => item?.sent === true)
        .map((item) => Number(item.replyIndex))
        .filter((index) => Number.isFinite(index) && index >= 0),
    );
    const hasIndexResults = results.some(
      (item) => Number.isFinite(Number(item?.replyIndex)),
    );
    const sentCount = sentIndexes.size || Number(responseJson?.sentCount || 0);
    const failedCount = Number(
      responseJson?.failedCount
      ?? results.filter((item) => item && item.sent === false).length,
    );
    const errors = results
      .filter((item) => item && item.sent === false && item.error)
      .map((item) => String(item.error))
      .slice(0, 5);
    // 有分项索引才精确筛未送达；部分成功但无索引时宁可不整批重入队
    const unsentReplies = hasIndexResults
      ? replies.filter((_, index) => !sentIndexes.has(index))
      : (sentCount > 0 ? [] : replies);

    const voiceSent = replies.some(
      (item, index) => item.type === 'voice' && sentIndexes.has(index),
    ) || (
      // Worker 未回 results 时，整批 ok 且含语音
      response.ok
      && responseJson?.ok !== false
      && failedCount === 0
      && replies.some((item) => item.type === 'voice')
    );
    const mediaSent = replies.some(
      (item, index) => item.type !== 'text' && sentIndexes.has(index),
    ) || (
      response.ok
      && responseJson?.ok !== false
      && failedCount === 0
      && replies.some((item) => item.type !== 'text')
    );

    if (voiceSent) markVoiceRecentlySent(to);

    const allOk = response.ok
      && responseJson?.ok !== false
      && failedCount === 0
      && (results.length === 0 || sentCount >= replies.length);

    if (allOk) {
      rememberRepliesSent({ to, replies });
      return buildOutboundResult({
        stage: 'wechat-ok',
        messageId,
        sentCount: replies.length,
        failedCount: 0,
        voiceSent,
        mediaSent,
      });
    }

    const sentReplies = replies.filter((_, index) => sentIndexes.has(index));
    if (sentReplies.length > 0) {
      rememberRepliesSent({ to, replies: sentReplies });
    }

    const detail = `HTTP ${response.status} failedCount=${failedCount}`;
    args.onWarn?.(
      `[xbot] xchatbot outbound ${sentCount > 0 ? 'partial' : 'failed'}: ${detail}${
        errors.length ? ` ${errors.join(' | ')}` : (responseText ? ` ${responseText.slice(0, 300)}` : '')
      }`,
    );

    if (sentCount > 0) {
      return buildOutboundResult({
        stage: 'partial',
        messageId,
        sentCount,
        failedCount: Math.max(failedCount, replies.length - sentCount),
        errors,
        voiceSent,
        mediaSent,
        detail,
        unsentReplies,
      });
    }

    return buildOutboundResult({
      stage: 'failed',
      messageId,
      sentCount: 0,
      failedCount: Math.max(failedCount, replies.length),
      errors,
      detail,
      unsentReplies,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    args.onWarn?.(`[xbot] xchatbot outbound failed: ${detail}`);
    return buildOutboundResult({
      stage: 'failed',
      messageId,
      failedCount: args.replies.length,
      errors: [detail],
      detail,
      unsentReplies: args.replies,
    });
  }
}
