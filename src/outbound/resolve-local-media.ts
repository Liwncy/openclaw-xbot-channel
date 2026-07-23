import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { XchatbotReply } from './map-reply.ts';

const MAX_LOCAL_MEDIA_BYTES = 8 * 1024 * 1024;

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
      // Windows file:///C:/... → /C:/... → C:/...
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

async function readLocalMediaAsBase64(mediaRef: string): Promise<string | null> {
  if (!looksLikeLocalPath(mediaRef)) return null;
  const localPath = normalizeLocalPath(mediaRef);
  try {
    await access(localPath);
  } catch {
    return null;
  }
  const buf = await readFile(localPath);
  if (buf.byteLength === 0 || buf.byteLength > MAX_LOCAL_MEDIA_BYTES) {
    throw new Error(
      `local media size out of range (${buf.byteLength} bytes, max ${MAX_LOCAL_MEDIA_BYTES}): ${localPath}`,
    );
  }
  return buf.toString('base64');
}

async function resolveMediaId(mediaId: string, originalUrl?: string): Promise<{
  mediaId: string;
  originalUrl?: string;
}> {
  const primary = mediaId.trim();
  const fallback = (originalUrl || '').trim();

  if (isHttpUrl(primary) || isDataUrl(primary)) {
    return {
      mediaId: primary,
      originalUrl: isHttpUrl(fallback) ? fallback : (isHttpUrl(primary) ? primary : undefined),
    };
  }

  const fromPrimary = await readLocalMediaAsBase64(primary);
  if (fromPrimary) {
    return {
      mediaId: fromPrimary,
      originalUrl: isHttpUrl(fallback) ? fallback : undefined,
    };
  }

  if (fallback && fallback !== primary) {
    if (isHttpUrl(fallback) || isDataUrl(fallback)) {
      return { mediaId: fallback, originalUrl: isHttpUrl(fallback) ? fallback : undefined };
    }
    const fromFallback = await readLocalMediaAsBase64(fallback);
    if (fromFallback) {
      return { mediaId: fromFallback, originalUrl: undefined };
    }
  }

  // 本地路径读不到时保留原值，交给下游报错/降级
  return {
    mediaId: primary,
    originalUrl: isHttpUrl(fallback) ? fallback : undefined,
  };
}

/**
 * 把 replies 里本地文件路径读成 base64，供 xchatbot Worker 拉取/转 SILK。
 * HTTP(S) / 已是 base64 的保持不变。
 */
export async function resolveLocalMediaInReplies(replies: XchatbotReply[]): Promise<XchatbotReply[]> {
  const out: XchatbotReply[] = [];
  for (const reply of replies) {
    if (reply.type === 'text' || reply.type === 'news') {
      out.push(reply);
      continue;
    }

    const resolved = await resolveMediaId(reply.mediaId, reply.originalUrl);
    if (reply.type === 'voice') {
      out.push({
        ...reply,
        mediaId: resolved.mediaId,
        originalUrl: resolved.originalUrl,
        fallbackText: resolved.originalUrl
          ? (reply.fallbackText || `语音：${resolved.originalUrl}`)
          : '语音没发出去，等下再试试',
      });
      continue;
    }

    out.push({
      ...reply,
      mediaId: resolved.mediaId,
      originalUrl: resolved.originalUrl,
    });
  }
  return out;
}
