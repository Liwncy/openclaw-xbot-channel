import { CHANNEL_ID } from '../constants.ts';
import type { XbotChannelConfigRoot } from '../types.ts';

export type XbotReplyConfigResult = {
  blockStreaming: boolean;
  allowTool: boolean;
  replyCfg: XbotChannelConfigRoot;
};

function parseBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value !== 'string') return undefined;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['true', 'on', '1', 'yes'].includes(normalized)) return true;
  if (['false', 'off', '0', 'no'].includes(normalized)) return false;
  return undefined;
}

/** 默认开启：调工具/技能前的说明也要发到微信。 */
export function resolveXbotBlockStreaming(cfg: XbotChannelConfigRoot): boolean {
  const channelValue = parseBooleanLike(cfg?.channels?.[CHANNEL_ID]?.blockStreaming);
  if (channelValue !== undefined) return channelValue;

  const globalValue = parseBooleanLike(
    (cfg?.agents as { defaults?: { blockStreamingDefault?: unknown } } | undefined)?.defaults
      ?.blockStreamingDefault,
  );
  if (globalValue !== undefined) return globalValue;

  return true;
}

export function resolveXbotAllowTool(cfg: XbotChannelConfigRoot): boolean {
  return cfg?.channels?.[CHANNEL_ID]?.allowTool === true;
}

export function buildXbotReplyConfig(cfg: XbotChannelConfigRoot): XbotReplyConfigResult {
  const blockStreaming = resolveXbotBlockStreaming(cfg);
  const allowTool = resolveXbotAllowTool(cfg);
  const channelSection = cfg?.channels?.[CHANNEL_ID] ?? {};

  const replyCfg = {
    ...cfg,
    agents: {
      ...(cfg?.agents ?? {}),
      defaults: {
        ...((cfg?.agents as { defaults?: Record<string, unknown> } | undefined)?.defaults ?? {}),
      },
    },
    channels: {
      ...(cfg?.channels ?? {}),
      [CHANNEL_ID]: {
        ...channelSection,
        ...(blockStreaming ? { blockStreaming: true } : {}),
      },
    },
  } as XbotChannelConfigRoot & {
    agents: {
      defaults: {
        blockStreamingBreak?: string;
        blockStreamingChunk?: { minChars: number; maxChars: number };
        blockStreamingDefault?: unknown;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
  };

  const defaults = replyCfg.agents.defaults;

  if (blockStreaming && defaults.blockStreamingDefault == null) {
    defaults.blockStreamingDefault = 'on';
  }

  // text_end：工具/技能调用前的说明句立刻发到微信，不等整轮结束。
  if (defaults.blockStreamingBreak == null) {
    defaults.blockStreamingBreak = 'text_end';
  }

  if (defaults.blockStreamingChunk == null) {
    defaults.blockStreamingChunk = {
      minChars: 1,
      maxChars: 2000,
    };
  }

  return { blockStreaming, allowTool, replyCfg };
}
