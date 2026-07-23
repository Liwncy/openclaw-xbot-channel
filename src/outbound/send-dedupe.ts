type DedupeEntry = { sentAt: number };

const recent = new Map<string, DedupeEntry>();
const TTL_MS = 45_000;
const MAX_ENTRIES = 200;

function prune(now: number): void {
  for (const [key, entry] of recent) {
    if (now - entry.sentAt > TTL_MS) recent.delete(key);
  }
  if (recent.size <= MAX_ENTRIES) return;
  const ordered = [...recent.entries()].sort((a, b) => a[1].sentAt - b[1].sentAt);
  for (const [key] of ordered.slice(0, recent.size - MAX_ENTRIES)) {
    recent.delete(key);
  }
}

function fingerprintMedia(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  // 本地路径 / URL：整段；base64：用头尾，避免整包进 Map
  if (trimmed.length <= 240) return trimmed.toLowerCase();
  return `${trimmed.slice(0, 96)}…${trimmed.slice(-48)}:${trimmed.length}`;
}

export function buildOutboundDedupeKey(args: {
  to: string;
  replies: Array<{ type: string; mediaId?: string; content?: string }>;
}): string | null {
  const to = args.to.trim().toLowerCase();
  if (!to || args.replies.length === 0) return null;

  const mediaKeys = args.replies
    .filter((item) => item.type === 'voice' || item.type === 'image' || item.type === 'video')
    .map((item) => `${item.type}:${fingerprintMedia(item.mediaId || '')}`)
    .filter((item) => !item.endsWith(':'));

  if (mediaKeys.length > 0) {
    return `media|${to}|${mediaKeys.join('|')}`;
  }

  const texts = args.replies
    .filter((item) => item.type === 'text')
    .map((item) => (item.content || '').trim())
    .filter(Boolean);
  if (texts.length === 1 && texts[0]!.length <= 200) {
    return `text|${to}|${texts[0]}`;
  }
  return null;
}

/** 若短时间内发过相同内容则返回 true（应跳过）。 */
export function shouldSkipDuplicateOutbound(key: string | null): boolean {
  if (!key) return false;
  const now = Date.now();
  prune(now);
  const hit = recent.get(key);
  return Boolean(hit && now - hit.sentAt <= TTL_MS);
}

export function rememberOutboundSent(key: string | null): void {
  if (!key) return;
  const now = Date.now();
  prune(now);
  recent.set(key, { sentAt: now });
}
