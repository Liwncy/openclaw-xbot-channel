import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { recordInboundSession as sdkRecordInboundSession } from 'openclaw/plugin-sdk/conversation-runtime';
import { resolveStorePath as sdkResolveStorePath } from 'openclaw/plugin-sdk/session-store-runtime';
import type { XbotChannelConfigRoot } from '../types.ts';

export type OpenClawChannelRuntimeContext = Record<string, unknown> & {
  BodyForAgent?: string;
  CommandBody?: string;
};

export type OpenClawReplyDispatcherPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  asVoice?: boolean;
  mimeType?: string;
  fileName?: string;
  type?: string;
  kind?: string;
};

export type OpenClawReplyDispatchInfo = { kind?: 'tool' | 'block' | 'final' };

export type OpenClawResolvedAgentRoute = {
  sessionKey?: string;
  mainSessionKey?: string;
  agentId?: string;
};

export function resolveOpenClawAgentRoute(
  api: OpenClawPluginApi,
  params: {
    cfg: XbotChannelConfigRoot;
    channel: string;
    accountId: string;
    peer: { kind: 'direct' | 'group'; id: string };
  },
): OpenClawResolvedAgentRoute {
  const routing = api?.runtime?.channel?.routing as
    | {
        resolveAgentRoute?: (args: typeof params) => OpenClawResolvedAgentRoute;
      }
    | undefined;
  if (typeof routing?.resolveAgentRoute !== 'function') {
    throw new Error('OpenClaw channel routing resolveAgentRoute API is unavailable');
  }
  return routing.resolveAgentRoute(params);
}

export function resolveXbotInboundSessionStorePath(args: {
  storeConfig?: string;
  agentId: string;
}): string {
  return sdkResolveStorePath(args.storeConfig, { agentId: args.agentId });
}

export function recordXbotInboundSession(
  params: Parameters<typeof sdkRecordInboundSession>[0],
): ReturnType<typeof sdkRecordInboundSession> {
  return sdkRecordInboundSession(params);
}

export function resolveXbotChannelInboundRuntime(api: OpenClawPluginApi) {
  const channelRuntime = api?.runtime?.channel as
    | {
        inbound?: {
          buildContext?: (params: unknown) => unknown;
          run?: (params: unknown) => unknown;
        };
        turn?: {
          buildContext?: (params: unknown) => unknown;
          run?: (params: unknown) => unknown;
        };
      }
    | undefined;

  const inboundRuntime = channelRuntime?.inbound;
  if (inboundRuntime?.buildContext && inboundRuntime?.run) {
    return {
      buildContext: inboundRuntime.buildContext,
      run: inboundRuntime.run,
    };
  }

  const legacyTurnRuntime = channelRuntime?.turn;
  if (legacyTurnRuntime?.buildContext && legacyTurnRuntime?.run) {
    return {
      buildContext: legacyTurnRuntime.buildContext,
      run: legacyTurnRuntime.run,
    };
  }

  throw new Error(
    'OpenClaw channel inbound runtime is unavailable: expected runtime.channel.inbound.* or legacy runtime.channel.turn.*',
  );
}

export async function dispatchOpenClawReplyWithBufferedBlockDispatcher(
  api: OpenClawPluginApi,
  params: {
    ctx: OpenClawChannelRuntimeContext;
    cfg: unknown;
    dispatcherOptions: {
      deliver: (
        payload: OpenClawReplyDispatcherPayload,
        info?: OpenClawReplyDispatchInfo,
      ) => Promise<void> | void;
      onError?: (err: unknown) => void;
    };
    replyOptions?: {
      disableBlockStreaming?: boolean;
      shouldEmitToolResult?: () => boolean;
    };
  },
): Promise<unknown> {
  const reply = api?.runtime?.channel?.reply as Record<string, unknown> | undefined;
  const dispatchReplyWithBufferedBlockDispatcher = reply?.dispatchReplyWithBufferedBlockDispatcher;
  if (typeof dispatchReplyWithBufferedBlockDispatcher !== 'function') {
    throw new Error(
      'OpenClaw channel reply dispatchReplyWithBufferedBlockDispatcher API is unavailable',
    );
  }
  return dispatchReplyWithBufferedBlockDispatcher(params);
}

export function formatOpenClawAgentEnvelope(
  api: OpenClawPluginApi,
  params: {
    channel: string;
    from: string;
    timestamp: number;
    envelope?: unknown;
    body: string;
  },
): string {
  const reply = api?.runtime?.channel?.reply as Record<string, unknown> | undefined;
  const formatAgentEnvelope = reply?.formatAgentEnvelope;
  if (typeof formatAgentEnvelope !== 'function') {
    return params.body;
  }
  return formatAgentEnvelope(params) as string;
}

export function resolveOpenClawEnvelopeFormatOptions(api: OpenClawPluginApi, cfg: unknown): unknown {
  const reply = api?.runtime?.channel?.reply as Record<string, unknown> | undefined;
  const resolveEnvelopeFormatOptions = reply?.resolveEnvelopeFormatOptions;
  if (typeof resolveEnvelopeFormatOptions !== 'function') {
    return undefined;
  }
  return resolveEnvelopeFormatOptions(cfg);
}
