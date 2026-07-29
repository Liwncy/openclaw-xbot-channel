import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { XbotReplyTarget } from '../types.ts';
import type { XchatbotReply } from './map-reply.ts';
import { ensureXbotStateDir } from './state-dir.ts';

export type XbotOutboxEntry = {
  id: string;
  createdAt: number;
  updatedAt: number;
  retryCount: number;
  nextAttemptAt: number;
  lastError?: string;
  accountId: string;
  replyTarget: XbotReplyTarget;
  replies: XchatbotReply[];
};

export type XbotDeadLetterEntry = XbotOutboxEntry & {
  deadAt: number;
  deadReason: string;
};

type OutboxFile = {
  version: 1;
  pending: XbotOutboxEntry[];
  deadLetter: XbotDeadLetterEntry[];
  lastOutboundError?: string;
  lastOutboundAt?: number;
  lastSilkError?: string;
};

const MAX_RETRY = 5;
const MAX_PENDING = 80;
const MAX_DEAD = 40;
const MAX_ENTRY_BYTES = 1_500_000;
const BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000];

let cache: OutboxFile | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let drainTimer: ReturnType<typeof setInterval> | null = null;
let draining = false;

function emptyFile(): OutboxFile {
  return { version: 1, pending: [], deadLetter: [] };
}

async function outboxPath(): Promise<string> {
  const dir = await ensureXbotStateDir();
  return path.join(dir, 'outbox.json');
}

async function load(): Promise<OutboxFile> {
  if (cache) return cache;
  try {
    const raw = await readFile(await outboxPath(), 'utf8');
    const parsed = JSON.parse(raw) as OutboxFile;
    cache = {
      version: 1,
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      deadLetter: Array.isArray(parsed.deadLetter) ? parsed.deadLetter : [],
      lastOutboundError: parsed.lastOutboundError,
      lastOutboundAt: parsed.lastOutboundAt,
      lastSilkError: parsed.lastSilkError,
    };
  } catch {
    cache = emptyFile();
  }
  return cache;
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persistNow();
  }, 200);
}

async function persistNow(): Promise<void> {
  if (!cache) return;
  try {
    const file = await outboxPath();
    await writeFile(file, JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    // 持久化失败不阻断发送主路径
  }
}

function estimateBytes(entry: Omit<XbotOutboxEntry, 'id' | 'createdAt' | 'updatedAt' | 'retryCount' | 'nextAttemptAt'>): number {
  try {
    return Buffer.byteLength(JSON.stringify(entry.replies), 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function backoffMs(retryCount: number): number {
  return BACKOFF_MS[Math.min(retryCount, BACKOFF_MS.length - 1)] || 300_000;
}

export function isRetryableOutboundError(detail: string): boolean {
  const s = detail.toLowerCase();
  if (!s) return true;
  // 本地/配置类：重试无意义
  if (/not configured|requires xchatbot|implausible|missing media|local media missing|preflight|unsupported|too large|oversized|max_.*bytes|silk|convert/.test(s)) {
    return false;
  }
  if (/http 4\d\d/.test(s) && !/http 408|http 429/.test(s)) return false;
  // 仅网络/网关类可重试（不要用宽泛 failed|error 匹配 silk 等）
  return /http 5\d\d|http 408|http 429|fetch failed|network|timeout|econn|enotfound|socket|522|502|503|504|abort|dns|eai_again/.test(s);
}

export async function enqueueOutboundRetry(args: {
  accountId: string;
  replyTarget: XbotReplyTarget;
  replies: XchatbotReply[];
  lastError: string;
  onWarn?: (message: string) => void;
}): Promise<XbotOutboxEntry | null> {
  const bytes = estimateBytes(args);
  if (bytes > MAX_ENTRY_BYTES) {
    args.onWarn?.(
      `[xbot] outbox skip enqueue: payload too large (~${Math.round(bytes / 1024)}KB)`,
    );
    return null;
  }

  const file = await load();
  const now = Date.now();
  const entry: XbotOutboxEntry = {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
    nextAttemptAt: now + backoffMs(0),
    lastError: args.lastError.slice(0, 500),
    accountId: args.accountId,
    replyTarget: args.replyTarget,
    replies: args.replies,
  };
  file.pending.push(entry);
  while (file.pending.length > MAX_PENDING) {
    const dropped = file.pending.shift();
    if (dropped) {
      file.deadLetter.push({
        ...dropped,
        deadAt: now,
        deadReason: 'pending-overflow',
      });
    }
  }
  while (file.deadLetter.length > MAX_DEAD) file.deadLetter.shift();
  file.lastOutboundError = entry.lastError;
  file.lastOutboundAt = now;
  scheduleSave();
  args.onWarn?.(
    `[xbot] outbox enqueued id=${entry.id} retryIn=${Math.round(backoffMs(0) / 1000)}s`,
  );
  return entry;
}

export async function recordSilkError(message: string): Promise<void> {
  const file = await load();
  file.lastSilkError = message.slice(0, 500);
  file.lastOutboundAt = Date.now();
  scheduleSave();
}

export async function recordOutboundError(message: string): Promise<void> {
  const file = await load();
  file.lastOutboundError = message.slice(0, 500);
  file.lastOutboundAt = Date.now();
  scheduleSave();
}

export type OutboxDrainSender = (entry: XbotOutboxEntry) => Promise<{
  ok: boolean;
  detail?: string;
  retryable?: boolean;
  /** partial 后只重试未送达项 */
  nextReplies?: XchatbotReply[];
}>;

export async function drainOutboxOnce(args: {
  send: OutboxDrainSender;
  onWarn?: (message: string) => void;
}): Promise<{ attempted: number; sent: number; dead: number }> {
  if (draining) return { attempted: 0, sent: 0, dead: 0 };
  draining = true;
  let attempted = 0;
  let sent = 0;
  let dead = 0;
  try {
    const file = await load();
    const now = Date.now();
    const due = file.pending
      .filter((item) => item.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
      .slice(0, 3);

    for (const entry of due) {
      attempted += 1;
      const result = await args.send(entry);
      const idx = file.pending.findIndex((item) => item.id === entry.id);
      if (idx < 0) continue;

      if (result.ok) {
        file.pending.splice(idx, 1);
        sent += 1;
        args.onWarn?.(`[xbot] outbox drained ok id=${entry.id}`);
        continue;
      }

      const retryable = result.retryable !== false && isRetryableOutboundError(result.detail || '');
      const nextRetry = entry.retryCount + 1;
      if (!retryable || nextRetry >= MAX_RETRY) {
        file.pending.splice(idx, 1);
        file.deadLetter.push({
          ...entry,
          retryCount: nextRetry,
          updatedAt: Date.now(),
          lastError: (result.detail || entry.lastError || 'drain-failed').slice(0, 500),
          deadAt: Date.now(),
          deadReason: retryable ? 'retry-limit' : 'not-retryable',
        });
        while (file.deadLetter.length > MAX_DEAD) file.deadLetter.shift();
        dead += 1;
        file.lastOutboundError = result.detail || entry.lastError;
        file.lastOutboundAt = Date.now();
        args.onWarn?.(
          `[xbot] outbox dead-letter id=${entry.id}: ${result.detail || entry.lastError}`,
        );
        continue;
      }

      file.pending[idx] = {
        ...entry,
        replies: result.nextReplies?.length ? result.nextReplies : entry.replies,
        retryCount: nextRetry,
        updatedAt: Date.now(),
        nextAttemptAt: Date.now() + backoffMs(nextRetry),
        lastError: (result.detail || entry.lastError || 'drain-failed').slice(0, 500),
      };
      file.lastOutboundError = file.pending[idx].lastError;
      file.lastOutboundAt = Date.now();
      args.onWarn?.(
        `[xbot] outbox retry scheduled id=${entry.id} attempt=${nextRetry} in=${Math.round(backoffMs(nextRetry) / 1000)}s`,
      );
    }

    if (attempted > 0) scheduleSave();
    return { attempted, sent, dead };
  } finally {
    draining = false;
  }
}

export function startOutboxDrainLoop(args: {
  send: OutboxDrainSender;
  onWarn?: (message: string) => void;
  intervalMs?: number;
}): void {
  if (drainTimer) return;
  const intervalMs = args.intervalMs ?? 3_000;
  drainTimer = setInterval(() => {
    void drainOutboxOnce(args);
  }, intervalMs);
  // 不阻止进程退出
  drainTimer.unref?.();
  void drainOutboxOnce(args);
}

export function stopOutboxDrainLoop(): void {
  if (drainTimer) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
}

export async function getOutboxDiagnostics(): Promise<{
  pending: number;
  deadLetter: number;
  lastOutboundError?: string;
  lastOutboundAt?: number;
  lastSilkError?: string;
  pendingPreview: Array<{
    id: string;
    retryCount: number;
    nextAttemptAt: number;
    lastError?: string;
    to: string;
    types: string[];
  }>;
  deadLetterPreview: Array<{
    id: string;
    deadReason: string;
    lastError?: string;
    to: string;
  }>;
}> {
  const file = await load();
  return {
    pending: file.pending.length,
    deadLetter: file.deadLetter.length,
    lastOutboundError: file.lastOutboundError,
    lastOutboundAt: file.lastOutboundAt,
    lastSilkError: file.lastSilkError,
    pendingPreview: file.pending.slice(-10).map((item) => ({
      id: item.id,
      retryCount: item.retryCount,
      nextAttemptAt: item.nextAttemptAt,
      lastError: item.lastError,
      to: item.replyTarget.to,
      types: item.replies.map((reply) => reply.type),
    })),
    deadLetterPreview: file.deadLetter.slice(-10).map((item) => ({
      id: item.id,
      deadReason: item.deadReason,
      lastError: item.lastError,
      to: item.replyTarget.to,
    })),
  };
}

/** 供 status 同步快照；尚未 load 时返回空计数 */
export function peekOutboxCounts(): {
  pending: number;
  deadLetter: number;
  lastOutboundError?: string;
  lastSilkError?: string;
} {
  if (!cache) {
    return { pending: 0, deadLetter: 0 };
  }
  return {
    pending: cache.pending.length,
    deadLetter: cache.deadLetter.length,
    lastOutboundError: cache.lastOutboundError,
    lastSilkError: cache.lastSilkError,
  };
}
