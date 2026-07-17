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
import type { XbotGroupHistoryMap } from './inbound/group-history.ts';
import { parseXbotInboundParams } from './inbound/parse.ts';
import { getOpenClawRuntimeConfig } from './openclaw/config.ts';
import { resolveOpenClawAgentRoute } from './openclaw/runtime.ts';
import { rememberReplyTarget, resolveReplyTargetBySession, sendXbotMedia, sendXbotText } from './outbound/send.ts';
import { resolveXbotChannelPolicy } from './policy.ts';
import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';
import type { XbotChannelConfigRoot, XbotConnection, XbotReplyTarget } from './types.ts';

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

type GatewayContext = GatewayRequestHandlerOptions;

function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /context is too large|auto-compaction/i.test(message);
}

function buildRotatedSessionKey(baseSessionKey: string): string {
  return `${baseSessionKey}::ctx-${Date.now().toString(36)}`;
}

async function compactSessionViaGateway(args: {
  sessionKey: string;
  agentId?: string;
}): Promise<boolean> {
  const params = {
    key: args.sessionKey,
    ...(args.agentId ? { agentId: args.agentId } : {}),
  };
  const result = await callGatewayFromCli('sessions.compact', {
    timeout: '180000',
    expectFinal: true,
  }, params, {
    expectFinal: true,
  });
  return result?.ok === true && result?.compacted === true;
}

export class XbotBridge {
  private readonly api: OpenClawPluginApi;
  private readonly bridgeId = `xbot-${process.pid}-${Date.now().toString(36)}`;
  private readonly connections = new Map<string, XbotConnection>();
  private readonly replyTargets = new Map<string, XbotReplyTarget>();
  /** base sessionKey -> rotated sessionKey，避免上下文撑爆后继续复用旧会话 */
  private readonly sessionKeyOverrides = new Map<string, string>();
  /** 群聊 pending 历史（未点名时攒着，点名触发时注入上下文） */
  private readonly groupHistories: XbotGroupHistoryMap = new Map();
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
      const baseRoute = resolveOpenClawAgentRoute(this.api, {
        cfg,
        channel: CHANNEL_ID,
        accountId: parsed.accountId,
        peer: parsed.peer,
      });
      const baseSessionKey = asString(baseRoute.sessionKey).trim();
      const appliedSessionKey = this.sessionKeyOverrides.get(baseSessionKey) || baseSessionKey;
      const activeRoute = appliedSessionKey
        ? { ...baseRoute, sessionKey: appliedSessionKey }
        : baseRoute;

      let result;
      try {
        result = await dispatchXbotInbound({
          api: this.api,
          cfg,
          parsed,
          wechatApiBaseUrl,
          groupHistories: this.groupHistories,
          onIgnored: () => {},
          resolvedRouteOverride: activeRoute,
        });
      } catch (error) {
        if (!baseSessionKey || !isContextOverflowError(error)) {
          throw error;
        }
        const activeSessionKey = appliedSessionKey || baseSessionKey;
        const activeAgentId = asString(activeRoute.agentId || baseRoute.agentId).trim() || undefined;
        let compacted = false;
        try {
          this.api.logger?.warn?.(
            `[xbot] context overflow on sessionKey=${activeSessionKey}, compact current session first`,
          );
          compacted = await compactSessionViaGateway({
            sessionKey: activeSessionKey,
            agentId: activeAgentId,
          });
        } catch (compactError) {
          this.api.logger?.warn?.(
            `[xbot] session compact failed for sessionKey=${activeSessionKey}: ${compactError instanceof Error ? compactError.message : String(compactError)}`,
          );
        }

        if (compacted) {
          try {
            result = await dispatchXbotInbound({
              api: this.api,
              cfg,
              parsed,
              wechatApiBaseUrl,
              groupHistories: this.groupHistories,
              onIgnored: () => {},
              resolvedRouteOverride: activeRoute,
            });
          } catch (retryError) {
            if (!isContextOverflowError(retryError)) {
              throw retryError;
            }
            this.api.logger?.warn?.(
              `[xbot] context still overflow after compact sessionKey=${activeSessionKey}, rotate session`,
            );
          }
        }

        if (!result) {
          const rotatedSessionKey = buildRotatedSessionKey(baseSessionKey);
          this.sessionKeyOverrides.set(baseSessionKey, rotatedSessionKey);
          this.api.logger?.warn?.(
            `[xbot] rotate session fallback ${activeSessionKey} -> ${rotatedSessionKey}`,
          );
          result = await dispatchXbotInbound({
            api: this.api,
            cfg,
            parsed,
            wechatApiBaseUrl,
            groupHistories: this.groupHistories,
            onIgnored: () => {},
            resolvedRouteOverride: {
              ...baseRoute,
              sessionKey: rotatedSessionKey,
            },
          });
        }
      }

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
        accumulated: result.accumulated === true,
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
