export const CHANNEL_ID = 'xbot';
export const DEFAULT_ACCOUNT_ID = 'Primary';
export const GATEWAY_METHODS = ['xbot.connect', 'xbot.inbound', 'xbot.activity'] as const;

export type XbotGatewayMethod = (typeof GATEWAY_METHODS)[number];
