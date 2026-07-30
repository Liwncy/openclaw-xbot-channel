import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_CONVERT_API = 'https://api.chrelyonly.cn/convert';
const CONVERT_TIMEOUT_MS = 60_000;
const CONVERT_RETRIES = 2;
const SILK_HEADER = '#!SILK_V3';
/** 太短的串不当 base64，避免把 `tts` / 工具名误读成音频 */
const MIN_INLINE_BASE64_CHARS = 256;
/**
 * 真 SILK 远大于此。曾出现 convert「成功」只回 ~93 字节脏包，
 * 标成 format=4 后被 Worker 拒收；这里直接当失败。
 */
export const MIN_SILK_BYTES = 256;

function normalizeBase64(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^data:[^;]+;base64,(.+)$/i);
  return (match?.[1] ?? trimmed).replace(/\s+/g, '');
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function looksLikeLocalPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || isHttpUrl(trimmed) || /^data:/i.test(trimmed)) return false;
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

function looksLikeInlineBase64(value: string): boolean {
  const trimmed = value.trim();
  if (/^data:[^;]+;base64,/i.test(trimmed)) return true;
  if (trimmed.length < MIN_INLINE_BASE64_CHARS) return false;
  return /^[A-Za-z0-9+/=\s]+$/.test(trimmed.slice(0, 80));
}

function findSilkHeaderOffset(bytes: Uint8Array, maxScan = 16): number {
  if (bytes.length < SILK_HEADER.length) return -1;
  const upper = Math.min(maxScan, bytes.length - SILK_HEADER.length);
  for (let offset = 0; offset <= upper; offset += 1) {
    let ok = true;
    for (let i = 0; i < SILK_HEADER.length; i += 1) {
      if (bytes[offset + i] !== SILK_HEADER.charCodeAt(i)) {
        ok = false;
        break;
      }
    }
    if (ok) return offset;
  }
  return -1;
}

function looksLikeSilkBytes(bytes: Uint8Array): boolean {
  return findSilkHeaderOffset(bytes) >= 0;
}

/** convert / 直通结果都必须过这一关，禁止脏包冒充 format=4 */
export function isValidSilkPayload(bytes: Uint8Array): boolean {
  return bytes.byteLength >= MIN_SILK_BYTES && looksLikeSilkBytes(bytes);
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(normalizeBase64(base64), 'base64'));
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONVERT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 在本地（OpenClaw 机器）把 mp3/wav 等转成微信 SILK。
 * 避开 Cloudflare Worker 访问 convert 时的 522。
 */
export async function convertAudioToSilkBase64(args: {
  media: string;
  convertApiUrl?: string;
}): Promise<{ base64: string; converted: boolean }> {
  const media = args.media.trim();
  if (!media) throw new Error('convertAudioToSilkBase64: empty media');

  let inputBase64 = '';
  if (isHttpUrl(media)) {
    const response = await fetchWithTimeout(media, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`download audio failed: HTTP ${response.status}`);
    }
    const buf = Buffer.from(await response.arrayBuffer());
    if (isValidSilkPayload(buf)) {
      return { base64: buf.toString('base64'), converted: false };
    }
    inputBase64 = buf.toString('base64');
  } else if (looksLikeInlineBase64(media)) {
    const bytes = decodeBase64ToBytes(media);
    if (isValidSilkPayload(bytes)) {
      return { base64: normalizeBase64(media), converted: false };
    }
    inputBase64 = normalizeBase64(media);
  } else if (looksLikeLocalPath(media)) {
    const localPath = normalizeLocalPath(media);
    await access(localPath);
    const buf = await readFile(localPath);
    if (isValidSilkPayload(buf)) {
      return { base64: buf.toString('base64'), converted: false };
    }
    inputBase64 = buf.toString('base64');
  } else {
    throw new Error(`invalid audio media ref: ${media.slice(0, 80)}`);
  }

  const apiUrl = args.convertApiUrl?.trim() || DEFAULT_CONVERT_API;
  let lastError = 'convert failed';
  for (let attempt = 0; attempt <= CONVERT_RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/octet-stream, audio/*, application/json;q=0.9, */*;q=0.8',
        },
        body: JSON.stringify({ base64Audio: inputBase64 }),
      });
      if (!response.ok) {
        lastError = `convert HTTP ${response.status}`;
        continue;
      }
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('application/json')) {
        const text = (await response.text()).slice(0, 200);
        lastError = `convert returned json: ${text}`;
        continue;
      }
      const raw = Buffer.from(await response.arrayBuffer());
      if (raw.byteLength <= 0) {
        lastError = 'convert returned empty body';
        continue;
      }
      // 禁止脏包：必须有 SILK 头且够长，才标 converted / format=4
      if (!isValidSilkPayload(raw)) {
        lastError = `convert returned invalid silk (bytes=${raw.byteLength}, silkHeader=${looksLikeSilkBytes(raw)})`;
        continue;
      }
      // 保留完整字节（含可能的 0x02 前缀），禁止剥头
      return { base64: raw.toString('base64'), converted: true };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`local silk convert failed: ${lastError}`);
}

export function isLikelyAlreadySilk(args: {
  format?: number;
  mediaId?: string;
}): boolean {
  const media = (args.mediaId || '').trim();
  if (/\.(silk|slk)(\?|#|$)/i.test(media)) return true;
  if (!media || isHttpUrl(media)) return false;
  // 不盲信 format=4：必须能从 mediaId 看出真 SILK
  try {
    if (/^data:/i.test(media) || media.length > 64) {
      const bytes = decodeBase64ToBytes(media);
      return isValidSilkPayload(bytes);
    }
  } catch {
    return false;
  }
  return false;
}
