export type XbotDmPolicy = 'open' | 'allowlist' | 'disabled';
export type XbotGroupPolicy = 'open' | 'allowlist' | 'disabled';

export type XbotChannelPolicyConfig = {
  enabled?: boolean;
  dmPolicy?: unknown;
  groupPolicy?: unknown;
  allowFrom?: unknown;
  groupAllowFrom?: unknown;
  requireMention?: unknown;
};

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

function asList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((item) => asString(item).trim()).filter(Boolean);
}

function asBoolean(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v;
  if (v == null) return fallback;
  return String(v).trim().toLowerCase() === 'true';
}

function normalizeDmPolicy(value: unknown): XbotDmPolicy {
  const normalized = asString(value || 'open')
    .trim()
    .toLowerCase();
  if (normalized === 'allowlist' || normalized === 'disabled') return normalized;
  return 'open';
}

function normalizeGroupPolicy(value: unknown): XbotGroupPolicy {
  const normalized = asString(value || 'open')
    .trim()
    .toLowerCase();
  if (normalized === 'allowlist' || normalized === 'disabled') return normalized;
  return 'open';
}

export function resolveXbotChannelPolicy(channelCfg: XbotChannelPolicyConfig | null | undefined) {
  return {
    enabled: channelCfg?.enabled !== false,
    dmPolicy: normalizeDmPolicy(channelCfg?.dmPolicy),
    groupPolicy: normalizeGroupPolicy(channelCfg?.groupPolicy),
    allowFrom: asList(channelCfg?.allowFrom),
    groupAllowFrom: asList(channelCfg?.groupAllowFrom),
    requireMention: asBoolean(channelCfg?.requireMention, true),
  };
}

export function shouldAcceptXbotInbound(args: {
  policy: ReturnType<typeof resolveXbotChannelPolicy>;
  peerKind: 'direct' | 'group';
  senderId: string;
  groupId?: string;
  botMentioned?: boolean;
}): { accept: boolean; reason?: string } {
  const { policy, peerKind, senderId, groupId, botMentioned } = args;
  if (!policy.enabled) return { accept: false, reason: 'channel-disabled' };

  if (peerKind === 'direct') {
    if (policy.dmPolicy === 'disabled') return { accept: false, reason: 'dm-disabled' };
    if (policy.dmPolicy === 'allowlist' && !policy.allowFrom.includes(senderId)) {
      return { accept: false, reason: 'dm-not-allowed' };
    }
    return { accept: true };
  }

  if (policy.groupPolicy === 'disabled') return { accept: false, reason: 'group-disabled' };
  if (policy.groupPolicy === 'allowlist') {
    const room = asString(groupId || '').trim();
    if (!room || !policy.groupAllowFrom.includes(room)) {
      return { accept: false, reason: 'group-not-allowed' };
    }
  }
  if (policy.requireMention && !botMentioned) {
    return { accept: false, reason: 'mention-required' };
  }
  return { accept: true };
}
