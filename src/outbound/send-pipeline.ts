import { randomUUID } from 'node:crypto';
import { normalizeAccountId, resolveWechatApiBaseUrl } from '../accounts.ts';
import { resolveOutboundReceiver } from '../targets.ts';
import type { XbotChannelConfigRoot, XbotReplyTarget, XbotRoute } from '../types.ts';
import {
  buildReplyTargetForRoute,
  repliesRequireXchatbot,
  sendViaXchatbotIfConfigured,
} from '../xchatbot-outbound.ts';
import {
  sendWechatImageUrl,
  sendWechatLink,
  sendWechatText,
  sendWechatVideoUrl,
} from '../wechat-api.ts';
import {
  buildOutboundResult,
  formatOutboundFailure,
  type XbotOutboundResult,
} from './delivery.ts';
import {
  enqueueOutboundRetry,
  isRetryableOutboundError,
  recordOutboundError,
} from './http-outbox.ts';
import type { XchatbotReply } from './map-reply.ts';
import { preflightOutboundReplies } from './media-preflight.ts';

/**
 * 统一出站入口：deliver / message 工具 / channel.send 都走这里。
 *
 * 规则：
 * 1. 发送前 media preflight
 * 2. 已配置 xchatbot → 只走 Worker，失败不再静默切直连
 * 3. 可重试失败 → 入 HTTP outbox 后台重试
 * 4. 未配置时：仅文本 / http(s) 图视频链接可直连；语音与本地文件直接 failed
 */
export async function sendRepliesPipeline(args: {
  cfg: XbotChannelConfigRoot;
  accountId?: string | null;
  route: XbotRoute;
  replies: XchatbotReply[];
  replyTarget?: XbotReplyTarget;
  wechatApiBaseUrl?: string;
  onWarn?: (message: string) => void;
  /** outbox drain 回调时禁止再次入队，避免死循环 */
  skipOutboxEnqueue?: boolean;
}): Promise<XbotOutboundResult> {
  if (args.replies.length === 0) {
    return buildOutboundResult({
      stage: 'wechat-ok',
      messageId: randomUUID(),
      detail: 'empty replies',
    });
  }

  const replyTarget = args.replyTarget || buildReplyTargetForRoute({
    cfg: args.cfg,
    accountId: args.accountId,
    route: args.route,
  });

  const preflight = await preflightOutboundReplies({
    replies: args.replies,
    onWarn: args.onWarn,
  });
  if (preflight.replies.length === 0) {
    const detail = preflight.errors[0] || 'media preflight rejected all replies';
    await recordOutboundError(detail);
    return buildOutboundResult({
      stage: 'failed',
      messageId: randomUUID(),
      failedCount: args.replies.length,
      errors: preflight.errors,
      detail,
    });
  }

  const relayed = await sendViaXchatbotIfConfigured({
    cfg: args.cfg,
    replyTarget,
    replies: preflight.replies,
    onWarn: args.onWarn,
  });

  if (relayed.stage !== 'unconfigured') {
    if (
      !args.skipOutboxEnqueue
      && (relayed.stage === 'failed' || relayed.stage === 'partial')
      && isRetryableOutboundError(relayed.detail || relayed.errors.join(' '))
    ) {
      const retryReplies = relayed.unsentReplies?.length
        ? relayed.unsentReplies
        : (relayed.stage === 'failed' ? preflight.replies : []);
      if (retryReplies.length > 0) {
        const queued = await enqueueOutboundRetry({
          accountId: normalizeAccountId(args.accountId || replyTarget.accountId),
          replyTarget,
          replies: retryReplies,
          lastError: relayed.detail || relayed.errors[0] || relayed.stage,
          onWarn: args.onWarn,
        });
        if (queued && relayed.stage === 'failed') {
          return buildOutboundResult({
            stage: 'queued',
            messageId: queued.id,
            failedCount: relayed.failedCount,
            errors: relayed.errors,
            voiceSent: relayed.voiceSent,
            mediaSent: relayed.mediaSent,
            detail: `queued for retry: ${relayed.detail || relayed.stage}`,
          });
        }
      }
    }
    if (relayed.stage === 'failed' || relayed.stage === 'partial') {
      await recordOutboundError(relayed.detail || relayed.errors[0] || relayed.stage);
    }
    return relayed;
  }

  // 未配置 Worker：本地语音/文件不能糊弄成链接卡片
  if (repliesRequireXchatbot(args.replies)) {
    const detail = 'xchatbot outbound required for voice/local media but not configured';
    args.onWarn?.(`[xbot] ${detail}`);
    return buildOutboundResult({
      stage: 'failed',
      messageId: randomUUID(),
      failedCount: args.replies.length,
      errors: [detail],
      detail,
    });
  }

  return sendDirectWhenUnconfigured({
    cfg: args.cfg,
    route: args.route,
    replies: args.replies,
    wechatApiBaseUrl: args.wechatApiBaseUrl,
    onWarn: args.onWarn,
  });
}

async function sendDirectWhenUnconfigured(args: {
  cfg: XbotChannelConfigRoot;
  route: XbotRoute;
  replies: XchatbotReply[];
  wechatApiBaseUrl?: string;
  onWarn?: (message: string) => void;
}): Promise<XbotOutboundResult> {
  const apiBase = (args.wechatApiBaseUrl || resolveWechatApiBaseUrl(args.cfg)).trim();
  if (!apiBase) {
    return buildOutboundResult({
      stage: 'failed',
      messageId: randomUUID(),
      failedCount: args.replies.length,
      detail: 'wechatApiBaseUrl not configured',
    });
  }

  const receiver = resolveOutboundReceiver(args.route);
  let sentCount = 0;
  const errors: string[] = [];
  let lastMessageId = randomUUID();
  let mediaSent = false;

  for (const reply of args.replies) {
    try {
      if (reply.type === 'text') {
        const result = await sendWechatText(apiBase, receiver, reply.content);
        lastMessageId = result.messageId || lastMessageId;
        sentCount += 1;
        continue;
      }
      if (reply.type === 'image') {
        const url = (reply.originalUrl || reply.mediaId || '').trim();
        if (!/^https?:\/\//i.test(url)) {
          throw new Error('direct image send requires http(s) URL');
        }
        const result = await sendWechatImageUrl(apiBase, receiver, url);
        lastMessageId = result.messageId || lastMessageId;
        sentCount += 1;
        mediaSent = true;
        continue;
      }
      if (reply.type === 'video') {
        const url = (reply.originalUrl || reply.mediaId || '').trim();
        if (!/^https?:\/\//i.test(url)) {
          throw new Error('direct video send requires http(s) URL');
        }
        const result = await sendWechatVideoUrl(apiBase, receiver, url);
        lastMessageId = result.messageId || lastMessageId;
        sentCount += 1;
        mediaSent = true;
        continue;
      }
      if (reply.type === 'news') {
        const first = reply.articles[0];
        if (!first?.url) throw new Error('news reply missing url');
        const result = await sendWechatLink(apiBase, receiver, {
          url: first.url,
          title: first.title || '链接',
          desc: first.description || '',
          thumbUrl: first.picUrl,
        });
        lastMessageId = result.messageId || lastMessageId;
        sentCount += 1;
        mediaSent = true;
        continue;
      }
      throw new Error(`direct send unsupported type: ${reply.type}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      args.onWarn?.(`[xbot] direct outbound item failed: ${message}`);
    }
  }

  if (sentCount === args.replies.length) {
    return buildOutboundResult({
      stage: 'wechat-ok',
      messageId: lastMessageId,
      sentCount,
      mediaSent,
    });
  }
  if (sentCount > 0) {
    return buildOutboundResult({
      stage: 'partial',
      messageId: lastMessageId,
      sentCount,
      failedCount: args.replies.length - sentCount,
      errors,
      mediaSent,
      detail: 'direct outbound partial',
    });
  }
  return buildOutboundResult({
    stage: 'failed',
    messageId: lastMessageId,
    failedCount: args.replies.length,
    errors,
    detail: formatOutboundFailure(buildOutboundResult({
      stage: 'failed',
      errors,
      detail: 'direct outbound failed',
    })),
  });
}

export function assertAgentOutboundOk(result: XbotOutboundResult): void {
  if (result.ok) return;
  throw new Error(formatOutboundFailure(result));
}
