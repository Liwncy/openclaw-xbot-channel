import type { XbotChannelPolicyConfig } from './policy.ts';

export type XbotAccountConfig = {
  enabled?: boolean;
  name?: string;
};

export type XbotChannelConfigSection = XbotChannelPolicyConfig & {
  wechatApiBaseUrl?: string;
  botWechatId?: string;
  botWechatName?: string;
  accounts?: Record<string, XbotAccountConfig | undefined>;
};

export type XbotChannelConfigRoot = {
  channels?: {
    xbot?: XbotChannelConfigSection;
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
