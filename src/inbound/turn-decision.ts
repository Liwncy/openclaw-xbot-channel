import type { ParsedXbotInbound } from '../types.ts';
import type { resolveXbotChannelPolicy } from '../policy.ts';
import { DEFAULT_GROUP_HISTORY_LIMIT } from './group-history.ts';

export type XbotGroupReplyMode = 'mention' | 'all';

export type XbotTurnDecision = {
  accept: boolean;
  shouldDispatch: boolean;
  shouldAccumulate: boolean;
  groupReplyMode: XbotGroupReplyMode;
  historyLimit: number;
  /** 窗满时是否静默 flush 进 session，默认 true */
  historyForce: boolean;
  reason?: string;
};

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

function parseBooleanLike(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return fallback;
  }
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['true', 'on', '1', 'yes'].includes(normalized)) return true;
  if (['false', 'off', '0', 'no'].includes(normalized)) return false;
  return fallback;
}

function parseHistoryLimit(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.trim());
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return DEFAULT_GROUP_HISTORY_LIMIT;
}

/**
 * mention：群消息都接，未点名只攒历史；点名才跑 Agent。
 * all：群消息每条都跑 Agent（不攒 pending）。
 * 未配置 groupReplyMode 时：requireMention=true → mention，false → all。
 */
export function resolveXbotGroupReplyMode(
  policy: ReturnType<typeof resolveXbotChannelPolicy>,
  channelCfg: { groupReplyMode?: unknown } | null | undefined,
): XbotGroupReplyMode {
  const raw = asString(channelCfg?.groupReplyMode).trim().toLowerCase();
  if (raw === 'all') return 'all';
  if (raw === 'mention') return 'mention';
  return policy.requireMention ? 'mention' : 'all';
}

export function resolveXbotHistoryLimit(channelCfg: { historyLimit?: unknown } | null | undefined): number {
  return parseHistoryLimit(channelCfg?.historyLimit);
}

/** 默认 true：窗满静默写入 session；false 则只滑动丢旧消息。 */
export function resolveXbotHistoryForce(channelCfg: { historyForce?: unknown } | null | undefined): boolean {
  return parseBooleanLike(channelCfg?.historyForce, true);
}

export function decideXbotInboundTurn(args: {
  policy: ReturnType<typeof resolveXbotChannelPolicy>;
  channelCfg: {
    groupReplyMode?: unknown;
    historyLimit?: unknown;
    historyForce?: unknown;
  } | null | undefined;
  parsed: ParsedXbotInbound;
}): XbotTurnDecision {
  const { policy, channelCfg, parsed } = args;
  const groupReplyMode = resolveXbotGroupReplyMode(policy, channelCfg);
  const historyLimit = resolveXbotHistoryLimit(channelCfg);
  const historyForce = resolveXbotHistoryForce(channelCfg);

  if (!policy.enabled) {
    return {
      accept: false,
      shouldDispatch: false,
      shouldAccumulate: false,
      groupReplyMode,
      historyLimit,
      historyForce,
      reason: 'channel-disabled',
    };
  }

  if (parsed.peer.kind === 'direct') {
    if (policy.dmPolicy === 'disabled') {
      return {
        accept: false,
        shouldDispatch: false,
        shouldAccumulate: false,
        groupReplyMode,
        historyLimit,
        historyForce,
        reason: 'dm-disabled',
      };
    }
    if (policy.dmPolicy === 'allowlist' && !policy.allowFrom.includes(parsed.senderId)) {
      return {
        accept: false,
        shouldDispatch: false,
        shouldAccumulate: false,
        groupReplyMode,
        historyLimit,
        historyForce,
        reason: 'dm-not-allowed',
      };
    }
    return {
      accept: true,
      shouldDispatch: true,
      shouldAccumulate: false,
      groupReplyMode,
      historyLimit,
      historyForce,
    };
  }

  if (policy.groupPolicy === 'disabled') {
    return {
      accept: false,
      shouldDispatch: false,
      shouldAccumulate: false,
      groupReplyMode,
      historyLimit,
      historyForce,
      reason: 'group-disabled',
    };
  }
  if (policy.groupPolicy === 'allowlist') {
    const room = asString(parsed.peer.id).trim();
    if (!room || !policy.groupAllowFrom.includes(room)) {
      return {
        accept: false,
        shouldDispatch: false,
        shouldAccumulate: false,
        groupReplyMode,
        historyLimit,
        historyForce,
        reason: 'group-not-allowed',
      };
    }
  }

  if (groupReplyMode === 'all') {
    return {
      accept: true,
      shouldDispatch: true,
      shouldAccumulate: false,
      groupReplyMode,
      historyLimit,
      historyForce,
    };
  }

  // mention：全员消息上送并攒上下文，仅点名触发回复
  const mentioned = parsed.botMentioned === true;
  return {
    accept: true,
    shouldDispatch: mentioned,
    shouldAccumulate: true,
    groupReplyMode,
    historyLimit,
    historyForce,
    reason: mentioned ? undefined : 'history-accumulated',
  };
}
