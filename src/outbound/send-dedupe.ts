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
  if (trimmed.length <= 240) return trimmed.toLowerCase();
  return `${trimmed.slice(0, 96)}…${trimmed.slice(-48)}:${trimmed.length}`;
}

function resolveToKey(to: string): string {
  return to.trim().toLowerCase();
}

export function buildMediaDedupeKey(args: {
  to: string;
  type: string;
  mediaId?: string;
}): string | null {
  const to = resolveToKey(args.to);
  const media = fingerprintMedia(args.mediaId || '');
  if (!to || !media) return null;
  return `media|${to}|${args.type}:${media}`;
}

export function buildTextDedupeKey(args: { to: string; content: string }): string | null {
  const to = resolveToKey(args.to);
  const content = args.content.trim();
  if (!to || !content || content.length > 200) return null;
  return `text|${to}|${content}`;
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

/**
 * 按条去重：已发过的语音/图片跳过，但仍保留新文字。
 * 避免「block 发了语音 → final 整包被跳过 → 连说明文字也没了」。
 */
export function filterDuplicateReplies<T extends {
  type: string;
  mediaId?: string;
  content?: string;
}>(args: {
  to: string;
  replies: T[];
}): { replies: T[]; skipped: number } {
  const kept: T[] = [];
  let skipped = 0;

  for (const reply of args.replies) {
    if (reply.type === 'voice' || reply.type === 'image' || reply.type === 'video') {
      const key = buildMediaDedupeKey({
        to: args.to,
        type: reply.type,
        mediaId: reply.mediaId,
      });
      if (shouldSkipDuplicateOutbound(key)) {
        skipped += 1;
        continue;
      }
      kept.push(reply);
      continue;
    }

    if (reply.type === 'text') {
      const key = buildTextDedupeKey({
        to: args.to,
        content: reply.content || '',
      });
      if (shouldSkipDuplicateOutbound(key)) {
        skipped += 1;
        continue;
      }
      kept.push(reply);
      continue;
    }

    kept.push(reply);
  }

  return { replies: kept, skipped };
}

export function rememberRepliesSent(args: {
  to: string;
  replies: Array<{ type: string; mediaId?: string; content?: string }>;
}): void {
  for (const reply of args.replies) {
    if (reply.type === 'voice' || reply.type === 'image' || reply.type === 'video') {
      rememberOutboundSent(buildMediaDedupeKey({
        to: args.to,
        type: reply.type,
        mediaId: reply.mediaId,
      }));
      continue;
    }
    if (reply.type === 'text') {
      rememberOutboundSent(buildTextDedupeKey({
        to: args.to,
        content: reply.content || '',
      }));
    }
  }
}
