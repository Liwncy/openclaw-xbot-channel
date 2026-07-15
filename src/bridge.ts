import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import {
  listAccountIds,
  normalizeAccountId,
  resolveAccount,
  resolveBotWechatName,
  resolveWechatApiBaseUrl,
} from './accounts.ts';
import { CHANNEL_ID } from './constants.ts';
import { dispatchXbotInbound } from './inbound/dispatch.ts';
import { parseXbotInboundParams } from './inbound/parse.ts';
import { getOpenClawRuntimeConfig } from './openclaw/config.ts';
import { rememberReplyTarget, resolveReplyTargetBySession, sendXbotMedia, sendXbotText } from './outbound/send.ts';
import { resolveXbotChannelPolicy } from './policy.ts';
import type { XbotChannelConfigRoot, XbotConnection, XbotReplyTarget } from './types.ts';

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

type GatewayContext = GatewayRequestHandlerOptions;

export class XbotBridge {
  private readonly api: OpenClawPluginApi;
  private readonly bridgeId = `xbot-${process.pid}-${Date.now().toString(36)}`;
  private readonly connections = new Map<string, XbotConnection>();
  private readonly replyTargets = new Map<string, XbotReplyTarget>();
  private runtimeWechatApiBaseUrl = '';

  constructor(api: OpenClawPluginApi) {
    this.api = api;
  }

  getBridgeId(): string {
    return this.bridgeId;
  }

  private cfg(): XbotChannelConfigRoot {
    return getOpenClawRuntimeConfig(this.api);
  }

  private resolveApiBaseUrl(override?: string): string {
    const fromConnect = asString(override || this.runtimeWechatApiBaseUrl).trim();
    if (fromConnect) return fromConnect;
    return resolveWechatApiBaseUrl(this.cfg());
  }

  handleConnect = async ({ params, respond }: GatewayContext) => {
    const input = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
    const accountId = normalizeAccountId(asString(input.accountId));
    const clientId = asString(input.clientId).trim() || `client-${Date.now()}`;
    const connId = asString(input.connId).trim() || clientId;
    const wechatApiBaseUrl = asString(input.wechatApiBaseUrl).trim();
    if (wechatApiBaseUrl) this.runtimeWechatApiBaseUrl = wechatApiBaseUrl;

    const now = Date.now();
    this.connections.set(connId, {
      accountId,
      clientId,
      connId,
      connectedAt: now,
      lastActivityAt: now,
      wechatApiBaseUrl: wechatApiBaseUrl || undefined,
    });

    respond(true, {
      ok: true,
      bridgeId: this.bridgeId,
      accountId,
      clientId,
      connId,
      connectedAt: now,
      channel: CHANNEL_ID,
    });
  };

  handleActivity = async ({ params, respond }: GatewayContext) => {
    const input = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
    const connId = asString(input.connId).trim();
    const connection = connId ? this.connections.get(connId) : undefined;
    if (connection) connection.lastActivityAt = Date.now();
    respond(true, { ok: true, bridgeId: this.bridgeId, connId: connId || null });
  };

  handleInbound = async ({ params, respond }: GatewayContext) => {
    const cfg = this.cfg();
    const parsed = parseXbotInboundParams(params, cfg);
    const connId = parsed.connId;
    if (connId) {
      const existing = this.connections.get(connId);
      if (existing) existing.lastActivityAt = Date.now();
    }

    const wechatApiBaseUrl = this.resolveApiBaseUrl(
      connId ? this.connections.get(connId)?.wechatApiBaseUrl : undefined,
    );
    if (!wechatApiBaseUrl) {
      respond(false, {
        ok: false,
        error: 'wechatApiBaseUrl is not configured (set channels.xbot.wechatApiBaseUrl or pass on xbot.connect)',
      });
      return;
    }

    try {
      const result = await dispatchXbotInbound({
        api: this.api,
        cfg,
        parsed,
        wechatApiBaseUrl,
        onIgnored: () => {},
      });

      if (result.sessionKey) {
        rememberReplyTarget(this.replyTargets, result.sessionKey, {
          accountId: parsed.accountId,
          to: parsed.route.to,
          route: parsed.route,
          replyToMessageId: parsed.messageId,
        });
      }

      respond(true, {
        ok: true,
        accepted: true,
        dispatched: result.dispatched,
        reason: result.reason || null,
        accountId: parsed.accountId,
        sessionKey: result.sessionKey || null,
        messageId: parsed.messageId,
      });
    } catch (error) {
      respond(false, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        accountId: parsed.accountId,
        messageId: parsed.messageId,
      });
    }
  };

  channelSendText = async (ctx: {
    accountId?: string | null;
    to?: string;
    text?: string;
    wechatApiBaseUrl?: string;
  }) => {
    const cfg = this.cfg();
    const to = asString(ctx.to).trim();
    const text = asString(ctx.text).trim();
    return sendXbotText({
      cfg,
      accountId: ctx.accountId,
      to,
      text,
      wechatApiBaseUrl: ctx.wechatApiBaseUrl || this.resolveApiBaseUrl(),
    });
  };

  channelSendMedia = async (ctx: {
    accountId?: string | null;
    to?: string;
    text?: string;
    mediaUrl?: string;
    wechatApiBaseUrl?: string;
  }) => {
    const cfg = this.cfg();
    const to = asString(ctx.to).trim();
    return sendXbotMedia({
      cfg,
      accountId: ctx.accountId,
      to,
      text: asString(ctx.text),
      mediaUrl: asString(ctx.mediaUrl),
      wechatApiBaseUrl: ctx.wechatApiBaseUrl || this.resolveApiBaseUrl(),
    });
  };

  resolveRouteBySession = (raw: string, accountId: string) => {
    const target = resolveReplyTargetBySession(this.replyTargets, raw);
    if (!target || normalizeAccountId(target.accountId) !== normalizeAccountId(accountId)) {
      return null;
    }
    return target.route;
  };

  getChannelSummary = (defaultAccountId: string) => {
    const cfg = this.cfg();
    const policy = resolveXbotChannelPolicy(cfg?.channels?.[CHANNEL_ID]);
    const connected = this.connections.size > 0;
    return {
      channel: CHANNEL_ID,
      enabled: policy.enabled,
      connected,
      connectionCount: this.connections.size,
      wechatApiBaseUrl: this.resolveApiBaseUrl() || null,
      botName: resolveBotWechatName(cfg),
      defaultAccountId: normalizeAccountId(defaultAccountId),
    };
  };

  getAccountRuntimeSnapshot = (accountId: string) => {
    const normalized = normalizeAccountId(accountId);
    const related = [...this.connections.values()].filter((item) => item.accountId === normalized);
    const latest = related.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    return {
      accountId: normalized,
      connected: related.length > 0,
      lastInboundAt: latest?.lastActivityAt || null,
      lastOutboundAt: null,
      mode: 'push',
    };
  };

  getStatusHeadline = (accountId: string) => {
    const snapshot = this.getAccountRuntimeSnapshot(accountId);
    if (!snapshot.connected) return '等待 xchatbot 推送连接';
    return '已连接，可接收私聊与群聊推送';
  };

  channelStartAccount = async () => {};
  channelStopAccount = async () => {};
}

let bridgeSingleton: XbotBridge | undefined;

export function getXbotBridge(api: OpenClawPluginApi): XbotBridge {
  if (!bridgeSingleton) bridgeSingleton = new XbotBridge(api);
  return bridgeSingleton;
}

export function listConfiguredAccountIds(cfg: XbotChannelConfigRoot): string[] {
  return listAccountIds(cfg);
}

export function describeConfiguredAccount(cfg: XbotChannelConfigRoot, accountId?: string) {
  return resolveAccount(cfg, accountId);
}
