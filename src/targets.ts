import type { XbotRoute } from './types.ts';

export function formatXbotDisplayScope(route: XbotRoute): string {
  if (route.kind === 'group') {
    return `群 ${route.groupId || route.to}`;
  }
  return `私聊 ${route.userId || route.to}`;
}

export function resolveOutboundReceiver(route: XbotRoute): string {
  return route.kind === 'group' ? route.groupId || route.to : route.userId || route.to;
}

export function buildExplicitTarget(route: XbotRoute): string {
  if (route.kind === 'group') {
    return `group:${route.groupId || route.to}`;
  }
  return `user:${route.userId || route.to}`;
}

export function parseExplicitTarget(raw: string): { route: XbotRoute } | null {
  const input = raw.trim();
  if (!input) return null;
  if (input.startsWith('group:')) {
    const groupId = input.slice('group:'.length).trim();
    if (!groupId) return null;
    return {
      route: {
        kind: 'group',
        to: groupId,
        platform: 'wechat',
        groupId,
      },
    };
  }
  if (input.startsWith('user:')) {
    const userId = input.slice('user:'.length).trim();
    if (!userId) return null;
    return {
      route: {
        kind: 'direct',
        to: userId,
        platform: 'wechat',
        userId,
      },
    };
  }
  if (input.endsWith('@chatroom')) {
    return {
      route: {
        kind: 'group',
        to: input,
        platform: 'wechat',
        groupId: input,
      },
    };
  }
  return {
    route: {
      kind: 'direct',
      to: input,
      platform: 'wechat',
      userId: input,
    },
  };
}
