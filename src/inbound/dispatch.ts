import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { CHANNEL_ID } from '../constants.ts';
import { resolveXbotChannelPolicy, shouldAcceptXbotInbound } from '../policy.ts';
import {
  dispatchOpenClawReplyWithBufferedBlockDispatcher,
  formatOpenClawAgentEnvelope,
  recordXbotInboundSession,
  resolveOpenClawAgentRoute,
  resolveOpenClawEnvelopeFormatOptions,
  resolveXbotChannelInboundRuntime,
  resolveXbotInboundSessionStorePath,
  type OpenClawChannelRuntimeContext,
} from '../openclaw/runtime.ts';
import { resolveOutboundReceiver } from '../targets.ts';
import type { ParsedXbotInbound, XbotChannelConfigRoot, XbotReplyTarget } from '../types.ts';
import { sendWechatImageUrl, sendWechatText } from '../wechat-api.ts';

export type XbotDeliverContext = {
  cfg: XbotChannelConfigRoot;
  wechatApiBaseUrl: string;
  replyTarget: XbotReplyTarget;
};

export async function deliverXbotReply(
  deliverCtx: XbotDeliverContext,
  payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] },
  info?: { kind?: 'tool' | 'block' | 'final' },
): Promise<void> {
  if (info?.kind === 'tool') return;
  const text = String(payload.text || '').trim();
  const mediaUrl = String(payload.mediaUrl || payload.mediaUrls?.[0] || '').trim();
  const receiver = resolveOutboundReceiver(deliverCtx.replyTarget.route);
  if (!receiver) throw new Error('outbound receiver is empty');

  if (mediaUrl) {
    await sendWechatImageUrl(deliverCtx.wechatApiBaseUrl, receiver, mediaUrl, text || undefined);
    return;
  }
  if (!text) return;
  await sendWechatText(deliverCtx.wechatApiBaseUrl, receiver, text);
}

export async function dispatchXbotInbound(args: {
  api: OpenClawPluginApi;
  cfg: XbotChannelConfigRoot;
  parsed: ParsedXbotInbound;
  wechatApiBaseUrl: string;
  onIgnored?: (reason: string) => void;
}): Promise<{ dispatched: boolean; sessionKey?: string; reason?: string }> {
  const { api, cfg, parsed, wechatApiBaseUrl } = args;
  const channelCfg = cfg?.channels?.[CHANNEL_ID] || {};
  const policy = resolveXbotChannelPolicy(channelCfg);
  const acceptance = shouldAcceptXbotInbound({
    policy,
    peerKind: parsed.peer.kind,
    senderId: parsed.senderId,
    groupId: parsed.peer.kind === 'group' ? parsed.peer.id : undefined,
    botMentioned: parsed.botMentioned,
  });
  if (!acceptance.accept) {
    args.onIgnored?.(acceptance.reason || 'ignored');
    return { dispatched: false, reason: acceptance.reason };
  }

  const resolvedRoute = resolveOpenClawAgentRoute(api, {
    cfg,
    channel: CHANNEL_ID,
    accountId: parsed.accountId,
    peer: parsed.peer,
  });
  const agentId = String(resolvedRoute.agentId || 'main').trim() || 'main';
  const sessionKey = String(resolvedRoute.sessionKey || '').trim();
  if (!sessionKey) {
    throw new Error('resolved sessionKey is empty');
  }

  const storePath = resolveXbotInboundSessionStorePath({
    storeConfig: undefined,
    agentId,
  });
  const canonicalTo = resolveOutboundReceiver(parsed.route);
  const envelopeOptions = resolveOpenClawEnvelopeFormatOptions(api, cfg);
  const body = formatOpenClawAgentEnvelope(api, {
    channel: 'Xbot',
    from: canonicalTo,
    timestamp: parsed.timestamp,
    envelope: envelopeOptions,
    body: parsed.rawBody,
  });

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
    peer: parsed.peer,
    chatType: parsed.peer.kind === 'group' ? 'group' : 'direct',
    body,
    Body: body,
    BodyForAgent: body,
    CommandBody: parsed.rawBody,
    rawBody: parsed.rawBody,
    To: canonicalTo,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: canonicalTo,
    WasMentioned: parsed.botMentioned,
    Mentioned: parsed.botMentioned,
    SessionKey: sessionKey,
    AgentId: agentId,
  })) as OpenClawChannelRuntimeContext;

  const replyTarget: XbotReplyTarget = {
    accountId: parsed.accountId,
    to: canonicalTo,
    route: parsed.route,
    replyToMessageId: parsed.messageId,
  };

  await inboundRuntime.run({
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
          onRecordError: () => {},
        },
        runDispatch: async () =>
          dispatchOpenClawReplyWithBufferedBlockDispatcher(api, {
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              deliver: async (payload, info) => {
                await deliverXbotReply({ cfg, wechatApiBaseUrl, replyTarget }, payload, info);
              },
              onError: () => {},
            },
            replyOptions: {
              disableBlockStreaming: false,
            },
          }),
      }),
    },
  });

  return { dispatched: true, sessionKey };
}
