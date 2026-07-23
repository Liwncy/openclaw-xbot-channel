import type { XchatbotReply } from './outbound/map-reply.ts';
import type { XbotChannelConfigRoot, XbotReplyTarget } from './types.ts';

export type { XchatbotReply };

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getChannelConfig(cfg: XbotChannelConfigRoot | null | undefined) {
  return cfg?.channels?.xbot || {};
}

function resolveXchatbotApiBaseUrl(
  cfg: XbotChannelConfigRoot | null | undefined,
  replyTarget?: XbotReplyTarget,
): string {
  return asString(replyTarget?.xchatbotApiBaseUrl || getChannelConfig(cfg).chatLogApiBaseUrl);
}

function resolveXchatbotAdminToken(
  cfg: XbotChannelConfigRoot | null | undefined,
  replyTarget?: XbotReplyTarget,
): string {
  return asString(replyTarget?.xchatbotAdminToken || getChannelConfig(cfg).chatLogAdminToken);
}

function buildOutboundBody(args: {
  replyTarget: XbotReplyTarget;
  replies: XchatbotReply[];
}) {
  const route = args.replyTarget.route;
  return {
    source: route.kind === 'group' ? 'group' : 'private',
    from: route.userId || route.to,
    to: route.to,
    ...(route.kind === 'group' ? { roomId: route.groupId || route.to } : {}),
    causedByMessageId: args.replyTarget.replyToMessageId,
    pluginName: 'openclaw-xbot',
    replies: args.replies,
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
  if (!apiBaseUrl || !adminToken || !args.replyTarget.replyToMessageId || args.replies.length === 0) {
    return false;
  }

  const url = new URL('/admin/xbot/outbound', apiBaseUrl).toString();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildOutboundBody(args)),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      args.onWarn?.(
        `[xbot] xchatbot outbound failed: HTTP ${response.status}${text ? ` ${text}` : ''}`,
      );
      return false;
    }
    return true;
  } catch (error) {
    args.onWarn?.(
      `[xbot] xchatbot outbound failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
