import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import {
  CHANNEL_ID,
  normalizeAccountId,
  type ParsedXbotInbound,
  type XbotChannelConfigRoot,
  type XbotReplyTarget,
} from './config.ts';
import {
  dispatchOpenClawReplyWithBufferedBlockDispatcher,
  formatOpenClawAgentEnvelope,
  recordXbotInboundSession,
  resolveOpenClawAgentRoute,
  resolveOpenClawEnvelopeFormatOptions,
  resolveXbotChannelInboundRuntime,
  resolveXbotInboundSessionStorePath,
  type OpenClawChannelRuntimeContext,
  type OpenClawReplyDispatchInfo,
  type OpenClawReplyDispatcherPayload,
} from './runtime.ts';
import { mapOpenClawPayloadToReplies, resolveOutboundReceiver, sendReplies } from './outbound.ts';

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

function resolveSource(raw: unknown): 'private' | 'group' {
  const value = asString(raw).trim().toLowerCase();
  if (value === 'group' || value === 'chatroom') return 'group';
  return 'private';
}

export function parseXbotInboundParams(params: unknown): ParsedXbotInbound {
  const input = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  const accountId = normalizeAccountId(asString(input.accountId));
  const messageId = asString(input.messageId || input.msgId || input.id).trim();
  const source = resolveSource(input.source);
  const senderId = asString(input.from || input.senderId).trim();
  const senderName = asString(input.senderName || senderId).trim();
  const roomId = asString(input.roomId || input.groupId).trim();
  const conversationId = asString(input.conversationId).trim();
  const msgType = asString(input.type || 'text').trim().toLowerCase() || 'text';
  const content = asString(input.content || input.text);
  const mediaUrl = asString(input.mediaUrl).trim();
  const videoUrl = asString(input.videoUrl).trim();
  const mediaKindRaw = asString(input.mediaKind).trim().toLowerCase();
  const mediaKind =
    mediaKindRaw === 'video'
    || mediaKindRaw === 'emoji'
    || mediaKindRaw === 'image'
    || mediaKindRaw === 'voice'
      ? mediaKindRaw
      : undefined;
  const timestampRaw = Number(input.timestamp ?? Date.now());
  const timestamp = Number.isFinite(timestampRaw) && timestampRaw > 0
    ? (timestampRaw > 1_000_000_000_000 ? Math.floor(timestampRaw) : Math.floor(timestampRaw * 1000))
    : Date.now();
  const platform = asString(input.platform).trim();

  const peer = source === 'group'
    ? { kind: 'group' as const, id: roomId || conversationId }
    : { kind: 'direct' as const, id: senderId };

  if (!messageId) throw new Error('messageId is required');
  if (!senderId) throw new Error('from is required');
  if (!platform) throw new Error('platform is required');
  if (peer.kind === 'group' && !peer.id) throw new Error('roomId is required for group messages');

  const route = peer.kind === 'group'
    ? { kind: 'group' as const, platform, to: peer.id, groupId: peer.id, userId: senderId }
    : { kind: 'direct' as const, platform, to: senderId, userId: senderId };

  return {
    accountId,
    messageId,
    platform,
    peer,
    route,
    msgType,
    rawBody: content.trim() || `[${msgType}]`,
    ...(mediaUrl ? { mediaUrl } : {}),
    ...(mediaUrl && mediaKind ? { mediaKind } : {}),
    ...(videoUrl ? { videoUrl } : {}),
    senderId,
    senderName,
    timestamp,
  };
}

function shouldDeliver(payload: OpenClawReplyDispatcherPayload, info?: OpenClawReplyDispatchInfo): boolean {
  const hasMedia = Boolean(asString(payload.mediaUrl) || payload.mediaUrls?.some((item) => asString(item)));
  if (hasMedia) return true;
  return info?.kind === 'final' || info?.kind == null;
}

export async function dispatchXbotInbound(args: {
  api: OpenClawPluginApi;
  cfg: XbotChannelConfigRoot;
  parsed: ParsedXbotInbound;
  resolvedRouteOverride?: {
    sessionKey?: string;
    mainSessionKey?: string;
    agentId?: string;
  };
}): Promise<{ dispatched: boolean; sessionKey?: string; reason?: string }> {
  const { api, cfg, parsed } = args;
  const resolvedRoute = args.resolvedRouteOverride || resolveOpenClawAgentRoute(api, {
    cfg,
    channel: CHANNEL_ID,
    accountId: parsed.accountId,
    peer: parsed.peer,
  });
  const agentId = String(resolvedRoute.agentId || 'main').trim() || 'main';
  const sessionKey = String(resolvedRoute.sessionKey || '').trim();
  if (!sessionKey) throw new Error('resolved sessionKey is empty');

  const storePath = resolveXbotInboundSessionStorePath({ agentId });
  const canonicalTo = resolveOutboundReceiver(parsed.route);
  const body = formatOpenClawAgentEnvelope(api, {
    channel: 'Xbot',
    from: parsed.senderName || parsed.senderId,
    timestamp: parsed.timestamp,
    envelope: resolveOpenClawEnvelopeFormatOptions(api, cfg),
    body: parsed.rawBody,
  });

  const inboundMediaUrl = asString(parsed.mediaUrl);
  const inboundVideoUrl = asString(parsed.videoUrl);
  const inboundMediaKind = parsed.mediaKind === 'video'
    || parsed.mediaKind === 'emoji'
    || parsed.mediaKind === 'image'
    || parsed.mediaKind === 'voice'
    ? parsed.mediaKind
    : 'image';
  const inboundMedia = [
    inboundMediaUrl
      ? {
          path: inboundMediaUrl,
          url: inboundMediaUrl,
          contentType: inboundMediaKind === 'video'
            ? 'video/mp4'
            : inboundMediaKind === 'voice'
              ? 'audio/silk'
              : inboundMediaKind === 'emoji'
                ? 'image/gif'
                : 'image/jpeg',
          kind: (inboundMediaKind === 'video'
            ? 'video'
            : inboundMediaKind === 'voice'
              ? 'audio'
              : 'image') as 'image' | 'video' | 'audio',
          messageId: parsed.messageId,
        }
      : null,
    inboundVideoUrl && inboundVideoUrl !== inboundMediaUrl
      ? {
          path: inboundVideoUrl,
          url: inboundVideoUrl,
          contentType: 'video/mp4',
          kind: 'video' as const,
          messageId: parsed.messageId,
        }
      : null,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));

  const inboundRuntime = resolveXbotChannelInboundRuntime(api);
  const ctxPayload = (await inboundRuntime.buildContext({
    channel: CHANNEL_ID,
    provider: CHANNEL_ID,
    surface: CHANNEL_ID,
    accountId: parsed.accountId,
    messageId: parsed.messageId,
    timestamp: parsed.timestamp,
    from: parsed.senderId,
    sender: {
      id: parsed.senderId,
      name: parsed.senderName,
      username: parsed.senderName,
    },
    conversation: {
      kind: parsed.peer.kind,
      id: parsed.peer.id,
      label: canonicalTo,
      routePeer: { kind: parsed.peer.kind, id: parsed.peer.id },
    },
    route: {
      agentId,
      accountId: parsed.accountId,
      routeSessionKey: sessionKey,
      dispatchSessionKey: sessionKey,
      mainSessionKey: resolvedRoute.mainSessionKey,
    },
    reply: {
      to: canonicalTo,
      originatingTo: canonicalTo,
      replyToId: parsed.messageId,
    },
    message: {
      inboundEventKind: 'user_request',
      body,
      rawBody: parsed.rawBody,
      bodyForAgent: parsed.rawBody,
      commandBody: parsed.rawBody,
    },
    ...(inboundMedia.length ? { media: inboundMedia } : {}),
    access: {
      mentions: {
        canDetectMention: true,
        wasMentioned: true,
        effectiveWasMentioned: true,
      },
    },
    extra: {
      OriginatingChannel: CHANNEL_ID,
      OriginatingTo: canonicalTo,
    },
  })) as OpenClawChannelRuntimeContext;

  const replyTarget: XbotReplyTarget = {
    accountId: parsed.accountId,
    to: canonicalTo,
    route: parsed.route,
    replyToMessageId: parsed.messageId,
  };

  const runResult = (await inboundRuntime.run({
    channel: CHANNEL_ID,
    accountId: parsed.accountId,
    raw: parsed,
    adapter: {
      ingest: () => ({
        id: parsed.messageId,
        timestamp: parsed.timestamp,
        rawText: parsed.rawBody,
        textForAgent: ctxPayload.BodyForAgent,
        textForCommands: ctxPayload.CommandBody,
        raw: parsed,
      }),
      resolveTurn: () => ({
        channel: CHANNEL_ID,
        accountId: parsed.accountId,
        agentId,
        routeSessionKey: sessionKey,
        storePath,
        ctxPayload,
        recordInboundSession: recordXbotInboundSession,
        record: {
          updateLastRoute: {
            channel: CHANNEL_ID,
            to: canonicalTo,
            accountId: parsed.accountId,
            sessionKey,
          },
          onRecordError: (err: unknown) => {
            api.logger?.warn?.(
              `[xbot] inbound record session failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          },
        },
        runDispatch: async () => dispatchOpenClawReplyWithBufferedBlockDispatcher(api, {
          ctx: ctxPayload,
          cfg,
          dispatcherOptions: {
            deliver: async (payload, info) => {
              if (!shouldDeliver(payload, info)) return;
              const replies = mapOpenClawPayloadToReplies(payload);
              if (replies.length === 0) return;
              await sendReplies({
                cfg,
                route: replyTarget.route,
                replies,
                replyToMessageId: replyTarget.replyToMessageId,
                onWarn: (message) => api.logger?.warn?.(message),
              });
            },
            onError: (err: unknown) => {
              api.logger?.error?.(
                `[xbot] outbound reply failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            },
          },
          replyOptions: {
            disableBlockStreaming: true,
          },
        }),
      }),
    },
  })) as {
    dispatched?: boolean;
    admission?: { kind?: string; reason?: string };
  } | undefined;

  const dispatched = runResult?.dispatched === true;
  return {
    dispatched,
    sessionKey,
    reason: dispatched ? undefined : runResult?.admission?.reason || runResult?.admission?.kind || 'not-dispatched',
  };
}
