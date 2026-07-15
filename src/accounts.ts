import { CHANNEL_ID, DEFAULT_ACCOUNT_ID } from './constants.ts';
import type { XbotChannelConfigRoot } from './types.ts';

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

export function normalizeAccountId(accountId?: string | null): string {
  const value = asString(accountId || '').trim();
  if (!value) return DEFAULT_ACCOUNT_ID;
  const lower = value.toLowerCase();
  if (lower === 'default' || lower === 'primary') return DEFAULT_ACCOUNT_ID;
  return value;
}

export function resolveDefaultDisplayName(rawName: unknown, accountId: string): string {
  const raw = asString(rawName || '').trim();
  if (!raw || raw === accountId || /^xbot$/i.test(raw)) return 'WeChat Bot';
  return raw;
}

function getChannelConfig(cfg: XbotChannelConfigRoot | null | undefined) {
  return cfg?.channels?.[CHANNEL_ID] || {};
}

function getAccountsConfig(cfg: XbotChannelConfigRoot | null | undefined) {
  return getChannelConfig(cfg).accounts || {};
}

export function resolveAccount(cfg: XbotChannelConfigRoot | null | undefined, accountId?: string | null) {
  const accounts = getAccountsConfig(cfg);
  let key = normalizeAccountId(accountId);
  if (!accounts[key]) {
    const first = Object.keys(accounts)[0];
    if (first) key = first;
  }
  const account = accounts[key] || {};
  return {
    accountId: key,
    name: resolveDefaultDisplayName(account?.name, key),
    enabled: account?.enabled !== false,
  };
}

export function listAccountIds(cfg: XbotChannelConfigRoot | null | undefined): string[] {
  const ids = Object.keys(getAccountsConfig(cfg));
  return ids.length ? ids : [DEFAULT_ACCOUNT_ID];
}

export function resolveWechatApiBaseUrl(cfg: XbotChannelConfigRoot | null | undefined): string {
  return asString(getChannelConfig(cfg).wechatApiBaseUrl || '').trim();
}

export function resolveBotWechatId(cfg: XbotChannelConfigRoot | null | undefined): string {
  return asString(getChannelConfig(cfg).botWechatId || '').trim();
}

export function resolveBotWechatName(cfg: XbotChannelConfigRoot | null | undefined): string {
  const configured = asString(getChannelConfig(cfg).botWechatName || '').trim();
  if (configured) return configured;
  return '小聪明儿';
}
