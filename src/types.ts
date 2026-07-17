import type { XbotChannelPolicyConfig } from './policy.ts';

export type XbotAccountConfig = {
  enabled?: boolean;
  name?: string;
};

export type XbotChannelConfigSection = XbotChannelPolicyConfig & {
  wechatApiBaseUrl?: string;
  chatLogApiBaseUrl?: string;
  chatLogAdminToken?: string;
  botWechatId?: string;
  botWechatName?: string;
  /** 是否把中间块（如调技能前的说明）发到微信，默认 true */
  blockStreaming?: boolean;
  /** 是否把 tool 结果也转发到微信，默认 false */
  allowTool?: boolean;
  accounts?: Record<string, XbotAccountConfig | undefined>;
};

export type XbotChannelConfigRoot = {
  channels?: {
    xbot?: XbotChannelConfigSection;
  };
  agents?: {
    defaults?: {
      blockStreamingDefault?: unknown;
      blockStreamingBreak?: string;
      blockStreamingChunk?: { minChars?: number; maxChars?: number };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  session?: {
    dmScope?: string;
  };
  commands?: {
    ownerAllowFrom?: string[];
  };
};

export type XbotPeer = {
  kind: 'direct' | 'group';
  id: string;
};

export type XbotRoute = {
  kind: 'direct' | 'group';
  to: string;
  platform: 'wechat';
  groupId?: string;
  userId?: string;
};

export type ParsedXbotInbound = {
  accountId: string;
  messageId: string;
  peer: XbotPeer;
  route: XbotRoute;
  msgType: string;
  rawBody: string;
  senderId: string;
  senderName: string;
  botMentioned: boolean;
  timestamp: number;
  clientId?: string;
  connId?: string;
};

export type XbotConnection = {
  accountId: string;
  clientId: string;
  connId: string;
  connectedAt: number;
  lastActivityAt: number;
  wechatApiBaseUrl?: string;
};

export type XbotReplyTarget = {
  accountId: string;
  to: string;
  route: XbotRoute;
  replyToMessageId?: string;
};
