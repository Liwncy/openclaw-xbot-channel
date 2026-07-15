import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import type { XbotChannelConfigRoot } from '../types.ts';

type RuntimeConfigApi = {
  current?: () => XbotChannelConfigRoot;
  get?: () => XbotChannelConfigRoot;
};

export function getOpenClawRuntimeConfig(api: OpenClawPluginApi): XbotChannelConfigRoot {
  const config = api?.runtime?.config;
  if (!config || typeof config !== 'object') {
    throw new Error('OpenClaw runtime config API is unavailable');
  }
  const typed = config as RuntimeConfigApi;
  if (typeof typed.current === 'function') return typed.current();
  if (typeof typed.get === 'function') return typed.get();
  throw new Error('OpenClaw runtime config read API is unavailable');
}

export function getOpenClawRuntimeConfigOrDefault<T>(
  api: OpenClawPluginApi,
  fallback: T,
): XbotChannelConfigRoot | T {
  try {
    return getOpenClawRuntimeConfig(api);
  } catch {
    return fallback;
  }
}
