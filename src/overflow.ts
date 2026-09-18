import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';

const OVERFLOW_MARKERS = [
  'context is too large',
  'auto-compaction could not recover',
  'context limit exceeded',
  'use /compact, or use /new',
];

const ALREADY_RESET_MARKERS = [
  "i've reset our conversation",
  'i have reset our conversation',
];

export const OVERFLOW_RETRY_REPLY = '聊太长了，我重新开了。再说一遍？';

function normalizeNotice(value: unknown): string {
  return (typeof value === 'string' ? value : String(value ?? '')).trim().toLowerCase();
}

export function isContextOverflowNotice(text: unknown): boolean {
  const normalized = normalizeNotice(text);
  return Boolean(normalized) && OVERFLOW_MARKERS.some((marker) => normalized.includes(marker));
}

export function isContextOverflowAlreadyReset(text: unknown): boolean {
  const normalized = normalizeNotice(text);
  return ALREADY_RESET_MARKERS.some((marker) => normalized.includes(marker));
}

export function isContextOverflowError(error: unknown): boolean {
  if (isContextOverflowNotice(error)) return true;
  if (error instanceof Error) return isContextOverflowNotice(error.message);
  if (error && typeof error === 'object') {
    const record = error as { message?: unknown; error?: unknown };
    return isContextOverflowNotice(record.message) || isContextOverflowNotice(record.error);
  }
  return false;
}

export async function resetXbotSession(params: {
  sessionKey: string;
  agentId?: string;
}): Promise<void> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) throw new Error('sessionKey is required');
  const agentId = params.agentId?.trim();
  await callGatewayFromCli(
    'sessions.reset',
    { timeout: '30000', expectFinal: true },
    {
      key: sessionKey,
      reason: 'new',
      ...(agentId ? { agentId } : {}),
    },
  );
}
