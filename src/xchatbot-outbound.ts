import { randomUUID } from 'node:crypto';
import { resolveBotWechatId, resolveBotWechatName } from './accounts.ts';
import type { XchatbotReply } from './outbound/map-reply.ts';
import { resolveLocalMediaInReplies } from './outbound/resolve-local-media.ts';
import {
  filterDuplicateReplies,
  rememberRepliesSent,
} from './outbound/send-dedupe.ts';
import type { XbotChannelConfigRoot, XbotReplyTarget, XbotRoute } from './types.ts';

export type { XchatbotReply };

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
    const { replies, skipped } = filterDuplicateReplies({ to, replies: resolved });
    if (skipped > 0) {
      args.onWarn?.(`[xbot] skip ${skipped} duplicate reply item(s) within 45s`);
    }
    if (replies.length === 0) {
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
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      args.onWarn?.(
        `[xbot] xchatbot outbound failed: HTTP ${response.status}${text ? ` ${text}` : ''}`,
      );
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
