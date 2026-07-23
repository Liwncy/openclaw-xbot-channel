import { randomUUID } from 'node:crypto';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import {
  applyAccountNameToChannelSection,
  jsonResult,
  setAccountEnabledInConfigSection,
} from 'openclaw/plugin-sdk/core';
import { createDefaultChannelRuntimeState } from 'openclaw/plugin-sdk/status-helpers';
import { extractToolSend } from 'openclaw/plugin-sdk/tool-send';
import {
  listAccountIds,
  normalizeAccountId,
  resolveAccount,
  resolveDefaultDisplayName,
} from './accounts.ts';
import type { XbotBridge } from './bridge.ts';
import { CHANNEL_ID, DEFAULT_ACCOUNT_ID, GATEWAY_METHODS } from './constants.ts';
import { XbotConfigSchema } from './config-schema.ts';
import { XBOT_CHANNEL_META } from './meta.ts';
import { resolveXbotChannelPolicy } from './policy.ts';
import { buildExplicitTarget, parseExplicitTarget } from './targets.ts';
import type { XbotChannelConfigRoot } from './types.ts';

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

export function createXbotChannelPlugin(getBridge: () => XbotBridge) {
  const outbound = {
    deliveryMode: 'gateway' as const,
    sendText: async (ctx: { accountId?: string | null; to?: string; text?: string }) =>
      getBridge().channelSendText(ctx),
    sendMedia: async (ctx: {
      accountId?: string | null;
      to?: string;
      text?: string;
      mediaUrl?: string;
      mimeType?: string;
      fileName?: string;
      type?: string;
      audioAsVoice?: boolean;
      asVoice?: boolean;
    }) => getBridge().channelSendMedia(ctx),
  };

  const config = {
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
    }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as OpenClawConfig,
        sectionKey: CHANNEL_ID,
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    isEnabled: (account: { enabled?: boolean }, cfg: XbotChannelConfigRoot) => {
      const policy = resolveXbotChannelPolicy(cfg?.channels?.[CHANNEL_ID]);
      return policy.enabled !== false && account?.enabled !== false;
    },
    isConfigured: (cfg: XbotChannelConfigRoot) => {
      const channelCfg = cfg?.channels?.[CHANNEL_ID];
      return Boolean(asString(channelCfg?.wechatApiBaseUrl).trim());
    },
    describeAccount: (account: { accountId: string; name?: string; enabled?: boolean }) => ({
      accountId: account.accountId,
      name: resolveDefaultDisplayName(account?.name, account.accountId),
      enabled: account.enabled !== false,
      configured: true,
    }),
  };

  const setup = {
    applyAccountName: ({
      cfg,
      accountId,
      name,
    }: {
      cfg: XbotChannelConfigRoot;
      accountId: string;
      name?: string;
    }) =>
      applyAccountNameToChannelSection({
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
  };

  const status = {
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
        headline: getBridge().getStatusHeadline(accountId),
        runtime,
      };
    },
    resolveAccountState: ({
      enabled,
      configured,
      account,
      cfg,
    }: {
      enabled?: boolean;
      configured?: boolean;
      account?: { accountId?: string };
      cfg: XbotChannelConfigRoot;
    }) => {
      const accountId = account?.accountId || DEFAULT_ACCOUNT_ID;
      const runtime = getBridge().getAccountRuntimeSnapshot(accountId);
      const policy = resolveXbotChannelPolicy(cfg?.channels?.[CHANNEL_ID]);
      return {
        accountId,
        enabled: enabled !== false && policy.enabled !== false,
        configured: configured !== false,
        connected: runtime.connected,
      };
    },
  };

  const messaging = {
    ensureCanonicalAgentId: ({ cfg, accountId }: { cfg: XbotChannelConfigRoot; accountId: string }) =>
      normalizeAccountId(accountId),
    resolveRouteBySession: (raw: string, accountId: string) =>
      getBridge().resolveRouteBySession(raw, accountId),
    normalizeTarget: (raw: string) => {
      const input = asString(raw).trim();
      if (!input) return undefined;
      const parsed = parseExplicitTarget(input);
      return parsed ? buildExplicitTarget(parsed.route) : input;
    },
    formatTargetDisplay: ({ target }: { target?: string | { to?: string } }) => {
      const raw = typeof target === 'string' ? target : asString(target?.to);
      const parsed = parseExplicitTarget(raw);
      return parsed?.route.to || raw;
    },
    targetResolver: {
      looksLikeId: (raw: string, normalized?: string) => {
        const input = asString(raw).trim();
        const normalizedInput = asString(normalized).trim();
        return Boolean(
          parseExplicitTarget(input)
          || (normalizedInput && parseExplicitTarget(normalizedInput)),
        );
      },
      hint: '<group:roomId@chatroom|user:wxid_xxx|roomId@chatroom|wxid_xxx>',
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
  };

  const messageActions = {
    describeMessageTool: ({ cfg }: { cfg: XbotChannelConfigRoot }) => {
      const channelCfg = cfg?.channels?.[CHANNEL_ID];
      const policy = resolveXbotChannelPolicy(channelCfg);
      if (policy.enabled === false) return null;
      return { actions: ['send'] as const, capabilities: [] as const };
    },
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
      const firstAttachment = attachments[0] && typeof attachments[0] === 'object'
        ? attachments[0] as Record<string, unknown>
        : null;
      const mediaUrl = asString(
        input.media
        || input.mediaUrl
        || firstAttachment?.media
        || firstAttachment?.mediaUrl
        || firstAttachment?.url,
      ).trim();
      const mimeType = asString(
        input.mimeType
        || input.contentType
        || firstAttachment?.mimeType
        || firstAttachment?.contentType,
      ).trim();
      const fileName = asString(
        input.fileName
        || input.filename
        || firstAttachment?.fileName
        || firstAttachment?.filename
        || firstAttachment?.name,
      ).trim();
      const mediaType = asString(input.type || input.kind || firstAttachment?.type || firstAttachment?.kind).trim();
      const audioAsVoice = input.audioAsVoice === true || input.asVoice === true;
      const bridge = getBridge();
      const result = mediaUrl
        ? await bridge.channelSendMedia({
            accountId,
            to,
            text: message,
            mediaUrl,
            mimeType: mimeType || undefined,
            fileName: fileName || undefined,
            type: mediaType || undefined,
            audioAsVoice,
            asVoice: audioAsVoice,
          })
        : await bridge.channelSendText({
            accountId,
            to,
            text: message,
          });
      return jsonResult({ ok: true, ...result, messageId: result.messageId || randomUUID() });
    },
  };

  return {
    id: CHANNEL_ID,
    meta: XBOT_CHANNEL_META,
    actions: messageActions,
    message: {
      receive: { policy: 'mention-or-direct' },
      send: {
        text: async (ctx: { accountId?: string; to?: string; text?: string }) =>
          getBridge().channelSendText(ctx),
        media: async (ctx: {
          accountId?: string;
          to?: string;
          text?: string;
          mediaUrl?: string;
          mimeType?: string;
          fileName?: string;
          type?: string;
          audioAsVoice?: boolean;
          asVoice?: boolean;
        }) => getBridge().channelSendMedia(ctx),
      },
    },
    capabilities: {
      chatTypes: ['direct', 'group'],
      media: true,
      reply: true,
      nativeCommands: false,
    },
    messaging,
    configSchema: XbotConfigSchema,
    config,
    setup,
    outbound,
    status,
    gatewayMethods: [...GATEWAY_METHODS],
    gateway: {
      startAccount: async () => getBridge().channelStartAccount(),
      stopAccount: async () => getBridge().channelStopAccount(),
    },
  };
}
