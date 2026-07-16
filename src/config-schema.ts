import { CHANNEL_ID } from './constants.ts';
import type { XbotChannelPolicyConfig } from './policy.ts';

export const XbotConfigSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    enabled: { type: 'boolean' },
    wechatApiBaseUrl: { type: 'string' },
    botWechatId: { type: 'string' },
    botWechatName: { type: 'string' },
    dmPolicy: {
      type: 'string',
      enum: ['open', 'allowlist', 'disabled'],
    },
    groupPolicy: {
      type: 'string',
      enum: ['open', 'allowlist', 'disabled'],
    },
    allowFrom: {
      type: 'array',
      items: { type: 'string' },
    },
    groupAllowFrom: {
      type: 'array',
      items: { type: 'string' },
    },
    requireMention: { type: 'boolean' },
    groupReplyMode: {
      type: 'string',
      enum: ['mention', 'all'],
    },
    historyLimit: { type: 'number' },
    historyForce: { type: 'boolean' },
    blockStreaming: { type: 'boolean' },
    allowTool: { type: 'boolean' },
    accounts: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: true,
        properties: {
          enabled: { type: 'boolean' },
          name: { type: 'string' },
        },
      },
    },
  },
} as const;

export function resolveXbotConfigWarnings(channelCfg: XbotChannelPolicyConfig | null | undefined): string[] {
  const warnings: string[] = [];
  const cfg = channelCfg || {};
  if (!String((cfg as { wechatApiBaseUrl?: string }).wechatApiBaseUrl || '').trim()) {
    warnings.push(`channels.${CHANNEL_ID}.wechatApiBaseUrl is not configured; outbound replies will fail until set`);
  }
  return warnings;
}
