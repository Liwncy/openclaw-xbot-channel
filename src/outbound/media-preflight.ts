import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { XchatbotReply } from './map-reply.ts';
import { MAX_LOCAL_MEDIA_BYTES } from './resolve-local-media.ts';

const PROBE_TIMEOUT_MS = 4_000;

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function isDataUrl(value: string): boolean {
  return /^data:[^;]+;base64,/i.test(value.trim());
}

function looksLikeLocalPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || isHttpUrl(trimmed) || isDataUrl(trimmed)) return false;
  if (trimmed.startsWith('file://')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith('\\\\')) return true;
  if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) return true;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return true;
  return trimmed.includes('\\') || trimmed.includes('/');
}

function normalizeLocalPath(raw: string): string {
  let value = raw.trim();
  if (value.startsWith('file://')) {
    try {
      value = decodeURIComponent(new URL(value).pathname);
      if (/^\/[a-zA-Z]:\//.test(value)) value = value.slice(1);
    } catch {
      value = value.replace(/^file:\/\//i, '');
    }
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(homedir(), value.slice(2));
  }
  return path.resolve(value);
}

async function probeHttp(url: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const head = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (head.ok || head.status === 206) return { ok: true };

    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), PROBE_TIMEOUT_MS);
    const range = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-3' },
      redirect: 'follow',
      signal: controller2.signal,
    });
    clearTimeout(timer2);
    if (range.ok || range.status === 206) return { ok: true };
    return { ok: false, reason: `HTTP HEAD ${head.status}, Range ${range.status}` };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function preflightOne(reply: XchatbotReply): Promise<{ ok: boolean; reason?: string }> {
  if (reply.type === 'text' || reply.type === 'news') return { ok: true };

  const mediaId = (reply.mediaId || '').trim();
  const originalUrl = (reply.originalUrl || '').trim();
  const primary = mediaId || originalUrl;
  if (!primary) return { ok: false, reason: `${reply.type} missing media` };

  // 已是内联 base64 / data URL：长度过短多半是假媒体
  if (isDataUrl(primary) || (!looksLikeLocalPath(primary) && !isHttpUrl(primary) && primary.length > 256)) {
    return { ok: true };
  }
  if (!looksLikeLocalPath(primary) && !isHttpUrl(primary) && primary.length < 256) {
    return { ok: false, reason: `implausible media ref: ${primary.slice(0, 80)}` };
  }

  if (looksLikeLocalPath(primary)) {
    const localPath = normalizeLocalPath(primary);
    try {
      await access(localPath);
      const info = await stat(localPath);
      if (info.size > MAX_LOCAL_MEDIA_BYTES) {
        return {
          ok: false,
          reason: `local media too large: ${Math.round(info.size / 1024)}KB > ${Math.round(MAX_LOCAL_MEDIA_BYTES / 1024 / 1024)}MB (use public http URL)`,
        };
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: `local media missing: ${localPath}` };
    }
  }

  if (isHttpUrl(primary)) {
    return probeHttp(primary);
  }

  return { ok: true };
}

/**
 * 发送前探活：丢掉不可达媒体，避免假成功。
 * 若入站本就只有坏媒体且无文本，返回 failed。
 */
export async function preflightOutboundReplies(args: {
  replies: XchatbotReply[];
  onWarn?: (message: string) => void;
}): Promise<{ replies: XchatbotReply[]; dropped: number; errors: string[] }> {
  const kept: XchatbotReply[] = [];
  const errors: string[] = [];
  let dropped = 0;

  for (const reply of args.replies) {
    const check = await preflightOne(reply);
    if (check.ok) {
      kept.push(reply);
      continue;
    }
    dropped += 1;
    const reason = check.reason || 'preflight failed';
    errors.push(reason);
    args.onWarn?.(`[xbot] media preflight drop: ${reason}`);
  }

  return { replies: kept, dropped, errors };
}
