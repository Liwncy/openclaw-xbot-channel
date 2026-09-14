import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GatewayRequestHandlerOptions, OpenClawConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import {
  applyAccountNameToChannelSection,
  jsonResult,
  setAccountEnabledInConfigSection,
} from 'openclaw/plugin-sdk/core';
import { createDefaultChannelRuntimeState } from 'openclaw/plugin-sdk/status-helpers';
import { extractToolSend } from 'openclaw/plugin-sdk/tool-send';
import {
  CHANNEL_ID,
  DEFAULT_ACCOUNT_ID,
  GATEWAY_METHODS,
  getOpenClawRuntimeConfig,
  listAccountIds,
  normalizeAccountId,
  resolveAccount,
  resolveBotName,
  resolveDefaultDisplayName,
  resolveXchatbotApiBaseUrl,
  XbotConfigSchema,
  type XbotChannelConfigRoot,
  type XbotReplyTarget,
} from './config.ts';
import { dispatchXbotInbound, parseXbotInboundParams } from './inbound.ts';
import { buildExplicitTarget, parseExplicitTarget, sendXbotMedia, sendXbotText } from './outbound.ts';
import { resolveOpenClawAgentRoute } from './runtime.ts';

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

const XBOT_CHANNEL_META = {
  id: CHANNEL_ID,
  label: 'Xbot',
  selectionLabel: 'xchatbot',
  docsPath: '/channels/xbot',
  blurb: 'OpenClaw talks only to xchatbot; adapters stay in the Worker.',
  aliases: ['xbot', 'xchatbot'],
  preferSessionLookupForAnnounceTarget: true,
};

type GatewayContext = GatewayRequestHandlerOptions;

export class XbotBridge {
  private readonly api: OpenClawPluginApi;
  private readonly replyTargets = new Map<string, XbotReplyTarget>();
  private lastInboundAt: number | null = null;
  private lastOutboundAt: number | null = null;

  constructor(api: OpenClawPluginApi) {
    this.api = api;
  }

  start = async () => {};
  stop = async () => {};

  private cfg(): XbotChannelConfigRoot {
    return getOpenClawRuntimeConfig(this.api);
  }

  handleConnect = async ({ respond }: GatewayContext) => {
    respond(true, { ok: true, channel: CHANNEL_ID });
  };

  handleDiagnostics = async ({ respond }: GatewayContext) => {
    respond(true, {
      ok: true,
      channel: CHANNEL_ID,
      xchatbotApiBaseUrl: resolveXchatbotApiBaseUrl(this.cfg()) || null,
      replyTargets: this.replyTargets.size,
      lastInboundAt: this.lastInboundAt,
      lastOutboundAt: this.lastOutboundAt,
    });
  };

  handleInbound = async ({ params, respond }: GatewayContext) => {
    const cfg = this.cfg();
    const parsed = parseXbotInboundParams(params);
    if (!resolveXchatbotApiBaseUrl(cfg)) {
      respond(false, { ok: false, error: 'xchatbotApiBaseUrl is not configured' });
      return;
    }
    this.lastInboundAt = Date.now();
    try {
      const route = resolveOpenClawAgentRoute(this.api, {
        cfg,
        channel: CHANNEL_ID,
        accountId: parsed.accountId,
        peer: parsed.peer,
      });
      const result = await dispatchXbotInbound({
        api: this.api,
        cfg,
        parsed,
        resolvedRouteOverride: route,
      });
      if (result.sessionKey) {
        this.replyTargets.set(result.sessionKey, {
          accountId: parsed.accountId,
          to: parsed.route.to,
          route: parsed.route,
          replyToMessageId: parsed.messageId,
        });
      }
      this.lastOutboundAt = Date.now();
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

  channelSendText = async (ctx: { accountId?: string | null; to?: string; text?: string }) =>
    sendXbotText({
      cfg: this.cfg(),
      accountId: ctx.accountId,
      to: asString(ctx.to),
      text: asString(ctx.text),
    });

  channelSendMedia = async (ctx: {
    accountId?: string | null;
    to?: string;
    text?: string;
    mediaUrl?: string;
    mimeType?: string;
    fileName?: string;
    type?: string;
    audioAsVoice?: boolean;
    asVoice?: boolean;
  }) => sendXbotMedia({
    cfg: this.cfg(),
    accountId: ctx.accountId,
    to: asString(ctx.to),
    text: asString(ctx.text),
    mediaUrl: asString(ctx.mediaUrl),
    mimeType: asString(ctx.mimeType) || undefined,
    fileName: asString(ctx.fileName) || undefined,
    type: asString(ctx.type) || undefined,
    audioAsVoice: ctx.audioAsVoice === true,
    asVoice: ctx.asVoice === true,
  });

  resolveRouteBySession = (raw: string, accountId: string) => {
    const target = this.replyTargets.get(raw.trim());
    if (!target || normalizeAccountId(target.accountId) !== normalizeAccountId(accountId)) {
      return null;
    }
    return target.route;
  };

  getChannelSummary = (defaultAccountId: string) => ({
    channel: CHANNEL_ID,
    enabled: true,
    connected: true,
    xchatbotApiBaseUrl: resolveXchatbotApiBaseUrl(this.cfg()) || null,
    botName: resolveBotName(this.cfg()),
    defaultAccountId: normalizeAccountId(defaultAccountId),
    lastInboundAt: this.lastInboundAt,
    lastOutboundAt: this.lastOutboundAt,
  });

  getAccountRuntimeSnapshot = (accountId: string) => ({
    accountId: normalizeAccountId(accountId),
    connected: true,
    lastInboundAt: this.lastInboundAt,
    lastOutboundAt: this.lastOutboundAt,
    mode: 'push',
  });

  getStatusHeadline = () => '等待 xchatbot 推送';
  channelStartAccount = async () => {};
  channelStopAccount = async () => {};
}

let bridgeSingleton: XbotBridge | undefined;

export function getXbotBridge(api: OpenClawPluginApi): XbotBridge {
  if (!bridgeSingleton) bridgeSingleton = new XbotBridge(api);
  return bridgeSingleton;
}

function createXbotChannelPlugin(getBridge: () => XbotBridge) {
  return {
    id: CHANNEL_ID,
    meta: XBOT_CHANNEL_META,
    actions: {
      describeMessageTool: () => ({ actions: ['send'] as const, capabilities: [] as const }),
      supportsAction: ({ action }: { action: string }) => action === 'send',
      extractToolSend: ({ args }: { args?: Record<string, unknown> }) =>
        extractToolSend(args || {}, 'sendMessage'),
      handleAction: async ({
        action,
        params,
        accountId,
      }: {
        action: string;
        params?: Record<string, unknown>;
        accountId?: string;
      }) => {
        if (action !== 'send') {
          throw new Error(`Action ${action} is not supported for provider ${CHANNEL_ID}.`);
        }
        const input = params || {};
        const to = asString(input.to || input.target).trim();
        const message = asString(input.message || input.text).trim();
        const attachments = Array.isArray(input.attachments) ? input.attachments : [];
        const first = attachments[0] && typeof attachments[0] === 'object'
          ? attachments[0] as Record<string, unknown>
          : null;
        const mediaUrl = asString(input.media || input.mediaUrl || first?.url).trim();
        const result = mediaUrl
          ? await getBridge().channelSendMedia({
              accountId,
              to,
              text: message,
              mediaUrl,
              mimeType: asString(input.mimeType) || undefined,
              fileName: asString(input.fileName) || undefined,
              type: asString(input.type) || undefined,
              audioAsVoice: input.audioAsVoice === true || input.asVoice === true,
              asVoice: input.audioAsVoice === true || input.asVoice === true,
            })
          : await getBridge().channelSendText({ accountId, to, text: message });
        return jsonResult({
          ok: result.ok !== false,
          sentCount: result.sentCount,
          messageId: result.messageId || randomUUID(),
        });
      },
    },
    message: {
      receive: { policy: 'open' },
      send: {
        text: async (ctx: { accountId?: string; to?: string; text?: string }) =>
          getBridge().channelSendText(ctx),
        media: async (ctx: Parameters<XbotBridge['channelSendMedia']>[0]) =>
          getBridge().channelSendMedia(ctx),
      },
    },
    capabilities: { chatTypes: ['direct', 'group'], media: true, reply: true, nativeCommands: false },
    messaging: {
      ensureCanonicalAgentId: ({ accountId }: { accountId: string }) => normalizeAccountId(accountId),
      resolveRouteBySession: (raw: string, accountId: string) =>
        getBridge().resolveRouteBySession(raw, accountId),
      normalizeTarget: (raw: string) => {
        const parsed = parseExplicitTarget(asString(raw).trim());
        return parsed ? buildExplicitTarget(parsed.route) : raw;
      },
      formatTargetDisplay: ({ target }: { target?: string | { to?: string } }) => {
        const raw = typeof target === 'string' ? target : asString(target?.to);
        return parseExplicitTarget(raw)?.route.to || raw;
      },
      targetResolver: {
        looksLikeId: (raw: string, normalized?: string) => Boolean(
          parseExplicitTarget(asString(raw).trim())
          || (asString(normalized).trim() && parseExplicitTarget(asString(normalized).trim())),
        ),
        hint: '<platform:group:id|platform:user:id>',
        resolveTarget: async ({ input, normalized }: { input: string; normalized?: string }) => {
          const parsed = parseExplicitTarget(asString(normalized).trim() || asString(input).trim());
          if (!parsed) return null;
          return {
            to: buildExplicitTarget(parsed.route),
            kind: parsed.route.kind === 'group' ? 'group' : 'user',
            display: parsed.route.to,
            source: 'normalized',
          };
        },
      },
    },
    configSchema: XbotConfigSchema,
    config: {
      listAccountIds,
      resolveAccount,
      setAccountEnabled: ({
        cfg,
        accountId,
        enabled,
      }: {
        cfg: XbotChannelConfigRoot;
        accountId: string;
        enabled: boolean;
      }) => setAccountEnabledInConfigSection({
        cfg: cfg as OpenClawConfig,
        sectionKey: CHANNEL_ID,
        accountId,
        enabled,
        allowTopLevel: true,
      }),
      isEnabled: (account: { enabled?: boolean }, cfg: XbotChannelConfigRoot) =>
        cfg?.channels?.[CHANNEL_ID]?.enabled !== false && account?.enabled !== false,
      isConfigured: (cfg: XbotChannelConfigRoot) => Boolean(resolveXchatbotApiBaseUrl(cfg)),
      describeAccount: (account: { accountId: string; name?: string; enabled?: boolean }) => ({
        accountId: account.accountId,
        name: resolveDefaultDisplayName(account?.name, account.accountId),
        enabled: account.enabled !== false,
        configured: true,
      }),
    },
    setup: {
      applyAccountName: ({
        cfg,
        accountId,
        name,
      }: {
        cfg: XbotChannelConfigRoot;
        accountId: string;
        name?: string;
      }) => applyAccountNameToChannelSection({
        cfg: cfg as OpenClawConfig,
        channelKey: CHANNEL_ID,
        accountId,
        name,
        alwaysUseAccounts: true,
      }),
      applyAccountConfig: ({ cfg, accountId }: { cfg: XbotChannelConfigRoot; accountId: string }) => {
        const next: XbotChannelConfigRoot = { ...(cfg || {}) };
        next.channels = next.channels || {};
        next.channels[CHANNEL_ID] = next.channels[CHANNEL_ID] || {};
        const channelCfg = next.channels[CHANNEL_ID]!;
        channelCfg.accounts = channelCfg.accounts || {};
        channelCfg.accounts[accountId] = {
          ...(channelCfg.accounts[accountId] || {}),
          enabled: true,
        };
        return next;
      },
    },
    outbound: {
      deliveryMode: 'gateway' as const,
      sendText: async (ctx: { accountId?: string | null; to?: string; text?: string }) =>
        getBridge().channelSendText(ctx),
      sendMedia: async (ctx: Parameters<XbotBridge['channelSendMedia']>[0]) =>
        getBridge().channelSendMedia(ctx),
    },
    status: {
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { mode: 'push-offline' }),
      buildChannelSummary: async ({ defaultAccountId }: { defaultAccountId?: string }) =>
        getBridge().getChannelSummary(defaultAccountId || DEFAULT_ACCOUNT_ID),
      buildAccountSnapshot: async ({
        account,
      }: {
        account?: { accountId?: string; name?: string; enabled?: boolean };
      }) => {
        const accountId = account?.accountId || DEFAULT_ACCOUNT_ID;
        const runtime = getBridge().getAccountRuntimeSnapshot(accountId);
        return {
          accountId,
          name: resolveDefaultDisplayName(account?.name, accountId),
          enabled: account?.enabled !== false,
          connected: runtime.connected,
          headline: getBridge().getStatusHeadline(),
          runtime,
        };
      },
      resolveAccountState: ({
        enabled,
        configured,
        account,
      }: {
        enabled?: boolean;
        configured?: boolean;
        account?: { accountId?: string };
      }) => {
        const accountId = account?.accountId || DEFAULT_ACCOUNT_ID;
        const runtime = getBridge().getAccountRuntimeSnapshot(accountId);
        return {
          accountId,
          enabled: enabled !== false,
          configured: configured !== false,
          connected: runtime.connected,
        };
      },
    },
    gatewayMethods: [...GATEWAY_METHODS],
    gateway: {
      startAccount: async () => getBridge().channelStartAccount(),
      stopAccount: async () => getBridge().channelStopAccount(),
    },
  };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function registerHttpRoutes(api: OpenClawPluginApi, getBridge: () => XbotBridge): void {
  for (const route of [
    { path: '/api/channels/xbot/connect', method: 'connect' as const },
    { path: '/api/channels/xbot/inbound', method: 'inbound' as const },
  ]) {
    api.registerHttpRoute({
      path: route.path,
      auth: 'gateway',
      match: 'exact',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
          return true;
        }
        try {
          const params = await readJsonBody(req);
          await new Promise<void>((resolve) => {
            const respond: GatewayRequestHandlerOptions['respond'] = (ok, payload) => {
              sendJson(res, ok ? 200 : 400, { ok, ...(payload || {}) });
              resolve();
            };
            const ctx: GatewayRequestHandlerOptions = {
              req: { id: 'http', type: 'req', method: 'xbot.http' } as GatewayRequestHandlerOptions['req'],
              params,
              client: null,
              isWebchatConnect: () => false,
              respond,
              context: {} as GatewayRequestHandlerOptions['context'],
            };
            const run = route.method === 'connect'
              ? getBridge().handleConnect(ctx)
              : getBridge().handleInbound(ctx);
            void run.catch((error) => {
              sendJson(res, 500, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
              resolve();
            });
          });
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return true;
      },
    });
  }
}

type GatewayRuntime = {
  bridge?: XbotBridge;
  serviceRegistered: boolean;
  channelRegistered: boolean;
  methodsRegistered: boolean;
};

const gatewayRuntimeSymbol = Symbol.for('xbot.gateway.runtime');

function getGatewayRuntime(): GatewayRuntime {
  const proc = process as NodeJS.Process & { [gatewayRuntimeSymbol]?: GatewayRuntime };
  if (!proc[gatewayRuntimeSymbol]) {
    proc[gatewayRuntimeSymbol] = {
      serviceRegistered: false,
      channelRegistered: false,
      methodsRegistered: false,
    };
  }
  return proc[gatewayRuntimeSymbol]!;
}

export function registerXbotPlugin(api: OpenClawPluginApi): void {
  const runtime = getGatewayRuntime();
  if (!runtime.bridge) runtime.bridge = getXbotBridge(api);
  const bridge = runtime.bridge;

  if (!runtime.serviceRegistered) {
    api.registerService({
      id: 'xbot-bridge-service',
      start: async () => getXbotBridge(api).start(),
      stop: async () => getXbotBridge(api).stop(),
    });
    runtime.serviceRegistered = true;
  }

  if (!runtime.channelRegistered) {
    api.registerChannel({
      plugin: createXbotChannelPlugin(() => getXbotBridge(api)) as never,
    });
    runtime.channelRegistered = true;
  }

  if (!runtime.methodsRegistered) {
    for (const method of GATEWAY_METHODS) {
      api.registerGatewayMethod(method, (opts) => {
        if (method === 'xbot.connect') return bridge.handleConnect(opts);
        if (method === 'xbot.inbound') return bridge.handleInbound(opts);
        if (method === 'xbot.diagnostics') return bridge.handleDiagnostics(opts);
        opts.respond(false, { ok: false, error: `unsupported method: ${method}` });
      });
    }
    runtime.methodsRegistered = true;
  }

  void bridge.start();
  registerHttpRoutes(api, () => getXbotBridge(api));
}
