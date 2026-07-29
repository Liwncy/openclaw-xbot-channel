import { normalizeWechatOutboundText } from './normalize-text.ts';
import {
  collectPathsFromXbotParams,
  parseXbotParamMarker,
} from './xbot-param.ts';

export type XchatbotReply =
  | { type: 'text'; content: string }
  | { type: 'image'; mediaId: string; originalUrl?: string }
  | {
      type: 'voice';
      mediaId: string;
      originalUrl?: string;
      format?: number;
      duration?: number;
      fallbackText?: string;
    }
  | {
      type: 'video';
      mediaId: string;
      originalUrl?: string;
      title?: string;
      description?: string;
      duration?: number;
    }
  | {
      type: 'news';
      articles: Array<{
        title: string;
        description?: string;
        url?: string;
        picUrl?: string;
      }>;
    };

export type OpenClawMediaKind = 'image' | 'video' | 'voice' | 'audio' | 'file';

export type ExtractedMediaItem = {
  url: string;
  hintedType?: OpenClawMediaKind;
  audioAsVoice?: boolean;
};

const IMAGE_EXT = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'tif', 'tiff',
]);
const VIDEO_EXT = new Set([
  'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', '3gp', 'mpeg', 'mpg',
]);
const AUDIO_EXT = new Set([
  'mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'amr', 'silk', 'wma', 'aiff',
]);

const MEDIA_TOKEN_RE = /\bMEDIA:\s*`?([^\n]+)`?/gi;
const AUDIO_AS_VOICE_TAG_RE = /\[\[\s*audio_as_voice\s*\]\]/gi;
const MEDIA_KIND_PREFIX_RE = /^(voice|audio|video|image|file)\s*[|:]\s*(.+)$/i;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 拒绝 `tts:` / 裸工具名等假媒体，避免被当成相对路径读盘。 */
export function isPlausibleMediaRef(value: string): boolean {
  const v = asString(value);
  if (!v || v.length < 3) return false;
  if (/^https?:\/\//i.test(v) || /^data:/i.test(v) || /^file:/i.test(v)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(v)) return true;
  if (v.startsWith('\\\\')) return true;
  if (v.startsWith('/') || v.startsWith('./') || v.startsWith('../') || v.startsWith('~/') || v.startsWith('~\\')) {
    return true;
  }
  if (v.includes('/') || v.includes('\\')) return true;
  if (/\.(mp3|wav|m4a|aac|ogg|opus|flac|amr|silk|slk|png|jpe?g|gif|webp|bmp|mp4|mov|m4v|webm)(\?|#|$)/i.test(v)) {
    return true;
  }
  return false;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function extensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split('/').pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot < 0) return '';
    return base.slice(dot + 1).toLowerCase();
  } catch {
    const clean = url.split('?')[0]?.split('#')[0] || '';
    const base = clean.split(/[/\\]/).pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot < 0) return '';
    return base.slice(dot + 1).toLowerCase();
  }
}

function fileNameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    return decodeURIComponent(pathname.split('/').pop() || '') || 'file';
  } catch {
    const clean = url.split('?')[0]?.split('#')[0] || '';
    return decodeURIComponent(clean.split(/[/\\]/).pop() || '') || 'file';
  }
}

function kindFromMime(mimeType?: string): OpenClawMediaKind | null {
  const mt = asString(mimeType).toLowerCase();
  if (!mt) return null;
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('audio/')) return 'audio';
  return 'file';
}

function kindFromExtension(ext: string): OpenClawMediaKind | null {
  if (!ext) return null;
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return null;
}

function looksLikeVoiceFileName(name: string): boolean {
  const base = name.trim().toLowerCase().replace(/\\/g, '/');
  if (!base) return false;
  // OpenClaw TTS / outbound 常见命名：voice-*.mp3
  if (/(^|\/)voice[-_]/.test(base)) return true;
  return base.includes('/media/outbound/') && AUDIO_EXT.has(extensionFromUrl(base));
}

function cleanMediaCandidate(raw: string): string {
  return raw
    .trim()
    .replace(/^[`"'[{(]+/, '')
    .replace(/[`"'\\})\],]+$/, '')
    .trim();
}

function parseMediaTokenBody(raw: string): ExtractedMediaItem | null {
  const candidate = cleanMediaCandidate(raw);
  if (!candidate) return null;

  const typed = candidate.match(MEDIA_KIND_PREFIX_RE);
  if (typed) {
    const kind = typed[1].toLowerCase() as OpenClawMediaKind;
    const url = cleanMediaCandidate(typed[2] || '');
    if (!url || !isPlausibleMediaRef(url)) return null;
    return {
      url,
      hintedType: kind === 'audio' ? 'voice' : kind,
      audioAsVoice: kind === 'voice' || kind === 'audio',
    };
  }

  if (!isPlausibleMediaRef(candidate)) return null;
  return {
    url: candidate,
    audioAsVoice: looksLikeVoiceFileName(candidate),
  };
}

/**
 * 从 OpenClaw 文本里抽出媒体：
 * - `MEDIA:<path-or-url>`
 * - `MEDIA:voice|<path>` / `MEDIA:video:C:\a.mp4`
 * - `[[audio_as_voice]]`
 * - `[XbotParam:{"asVoice":true,"path":"..."}]`
 */
export function extractOpenClawMediaFromText(text: string): {
  text: string;
  mediaUrls: string[];
  mediaItems: ExtractedMediaItem[];
  audioAsVoice: boolean;
  hintedType?: OpenClawMediaKind;
} {
  const raw = typeof text === 'string' ? text : '';
  const paramParsed = parseXbotParamMarker(raw);
  const params = paramParsed.params;
  let audioAsVoice = AUDIO_AS_VOICE_TAG_RE.test(paramParsed.cleanText)
    || params.asVoice === true
    || params.audioAsVoice === true;
  AUDIO_AS_VOICE_TAG_RE.lastIndex = 0;
  const withoutAudioTag = paramParsed.cleanText.replace(AUDIO_AS_VOICE_TAG_RE, '').trimEnd();

  const mediaItems: ExtractedMediaItem[] = [];
  const pushItem = (item: ExtractedMediaItem | null) => {
    if (!item?.url) return;
    if (mediaItems.some((existing) => existing.url === item.url)) return;
    mediaItems.push(item);
    if (item.audioAsVoice) audioAsVoice = true;
  };

  const paramType = asString(params.type).toLowerCase();
  const paramHinted: OpenClawMediaKind | undefined = (
    paramType === 'voice'
    || paramType === 'audio'
    || paramType === 'video'
    || paramType === 'image'
    || paramType === 'file'
  )
    ? (paramType === 'audio' ? 'voice' : paramType)
    : undefined;

  for (const path of collectPathsFromXbotParams(params)) {
    pushItem({
      url: path,
      hintedType: paramHinted,
      audioAsVoice: audioAsVoice || paramHinted === 'voice',
    });
  }

  const keptLines: string[] = [];
  if (/media:/i.test(withoutAudioTag)) {
    for (const line of withoutAudioTag.split(/\r?\n/)) {
      const trimmedStart = line.trimStart();
      if (!trimmedStart.toUpperCase().startsWith('MEDIA:')) {
        keptLines.push(line);
        continue;
      }
      const matches = Array.from(line.matchAll(MEDIA_TOKEN_RE));
      MEDIA_TOKEN_RE.lastIndex = 0;
      if (matches.length === 0) {
        keptLines.push(line);
        continue;
      }
      let cursor = 0;
      const leftovers: string[] = [];
      for (const match of matches) {
        const start = match.index ?? 0;
        const before = line.slice(cursor, start).trim();
        if (before) leftovers.push(before);
        pushItem(parseMediaTokenBody(match[1] || ''));
        cursor = start + match[0].length;
      }
      const after = line.slice(cursor).trim();
      if (after) leftovers.push(after);
      if (leftovers.length > 0) keptLines.push(leftovers.join(' ').trim());
    }
  } else {
    keptLines.push(withoutAudioTag);
  }

  // TTS / outbound 语音文件即使没带标签，也按语音发
  if (!audioAsVoice && mediaItems.some((item) => looksLikeVoiceFileName(item.url))) {
    audioAsVoice = true;
  }

  return {
    text: keptLines.join('\n').trim(),
    mediaUrls: mediaItems.map((item) => item.url),
    mediaItems,
    audioAsVoice,
    hintedType: paramHinted,
  };
}

export function resolveOpenClawMediaKind(params: {
  mediaUrl: string;
  mimeType?: string;
  fileName?: string;
  hintedType?: string;
  audioAsVoice?: boolean;
}): OpenClawMediaKind {
  const hinted = asString(params.hintedType).toLowerCase();
  if (hinted === 'voice') return 'voice';
  if (hinted === 'audio') {
    // 微信侧音频一律按语音气泡；本地路径做链接卡片也打不开
    return 'voice';
  }
  if (hinted === 'video' || hinted === 'image' || hinted === 'file') return hinted;

  const fromMime = kindFromMime(params.mimeType);
  if (fromMime === 'audio') return 'voice';
  if (fromMime) return fromMime;

  const name = asString(params.fileName) || fileNameFromUrl(params.mediaUrl);
  const ext = name.includes('.')
    ? name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    : extensionFromUrl(params.mediaUrl);
  const fromExt = kindFromExtension(ext);
  if (fromExt === 'audio') return 'voice';
  if (fromExt) return fromExt;
  // 有明确后缀但不是图/音/视频 → 当文件（链接卡片）
  if (ext) return 'file';

  // OpenClaw 显式要求语音时，即使无后缀也按语音发
  if (params.audioAsVoice) return 'voice';

  // 无后缀本地路径且像语音文件名
  if (looksLikeVoiceFileName(params.mediaUrl) || looksLikeVoiceFileName(name)) {
    return 'voice';
  }

  // 无后缀时默认当图片：兼容历史 mediaUrl 一律走图片的行为
  return 'image';
}

function mapMediaUrlToReply(params: {
  mediaUrl: string;
  mimeType?: string;
  fileName?: string;
  hintedType?: string;
  audioAsVoice?: boolean;
}): XchatbotReply {
  const mediaUrl = asString(params.mediaUrl);
  const kind = resolveOpenClawMediaKind(params);
  const fileName = asString(params.fileName) || fileNameFromUrl(mediaUrl);
  const httpUrl = isHttpUrl(mediaUrl) ? mediaUrl : undefined;

  switch (kind) {
    case 'voice': {
      // OpenClaw TTS 多为 mp3；format=2 才会走 SILK 转换。误标 4 会直通导致微信「语音未能转换」。
      const ext = extensionFromUrl(mediaUrl) || (fileName.includes('.')
        ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
        : '');
      const format = ext === 'silk' || ext === 'slk' ? 4 : 2;
      return {
        type: 'voice',
        mediaId: mediaUrl,
        originalUrl: httpUrl,
        format,
        // 不预填「没发出去」：语音成功后若另一次失败，Worker 用这句会和真实语音打架
        ...(httpUrl ? { fallbackText: `语音：${httpUrl}` } : {}),
      };
    }
    case 'audio':
      // 保留分支；resolve 已把 audio 映射为 voice
      return {
        type: 'news',
        articles: [{
          title: fileName || '音频',
          description: '点击收听/下载',
          url: httpUrl || mediaUrl,
        }],
      };
    case 'video':
      return {
        type: 'video',
        mediaId: mediaUrl,
        originalUrl: httpUrl,
      };
    case 'file':
      return {
        type: 'news',
        articles: [{
          title: fileName || '文件',
          description: '点击查看/下载',
          url: httpUrl || mediaUrl,
        }],
      };
    case 'image':
    default:
      return {
        type: 'image',
        mediaId: mediaUrl,
        originalUrl: httpUrl,
      };
  }
}

/**
 * 将 OpenClaw deliver payload 映射为 xchatbot `/admin/xbot/outbound` 可解析的 replies。
 * 顺序：媒体在前、文本在后（与旧行为一致）。
 */
export function mapOpenClawPayloadToReplies(payload: {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  asVoice?: boolean;
  mimeType?: string;
  fileName?: string;
  type?: string;
  kind?: string;
}): XchatbotReply[] {
  const extracted = extractOpenClawMediaFromText(
    typeof payload.text === 'string' ? payload.text : '',
  );
  const text = extracted.text;
  const audioAsVoice = payload.audioAsVoice === true
    || payload.asVoice === true
    || extracted.audioAsVoice;
  const payloadHint = asString(payload.type || payload.kind) || extracted.hintedType;

  const items: ExtractedMediaItem[] = [];
  const pushItem = (item: ExtractedMediaItem) => {
    if (!item.url || !isPlausibleMediaRef(item.url)) return;
    if (items.some((existing) => existing.url === item.url)) return;
    items.push(item);
  };

  const payloadUrl = asString(payload.mediaUrl);
  if (payloadUrl) {
    pushItem({
      url: payloadUrl,
      hintedType: payloadHint as OpenClawMediaKind | undefined,
      audioAsVoice,
    });
  }
  for (const item of Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []) {
    const url = asString(item);
    if (url) {
      pushItem({
        url,
        hintedType: payloadHint as OpenClawMediaKind | undefined,
        audioAsVoice,
      });
    }
  }
  for (const item of extracted.mediaItems) {
    pushItem({
      ...item,
      audioAsVoice: item.audioAsVoice === true || audioAsVoice,
      hintedType: item.hintedType || (payloadHint as OpenClawMediaKind | undefined),
    });
  }

  const replies: XchatbotReply[] = items.map((item) => mapMediaUrlToReply({
    mediaUrl: item.url,
    mimeType: payload.mimeType,
    fileName: payload.fileName,
    hintedType: item.hintedType || payloadHint,
    audioAsVoice: item.audioAsVoice === true || audioAsVoice,
  }));

  const normalizedText = normalizeWechatOutboundText(text);
  if (normalizedText) {
    replies.push({ type: 'text', content: normalizedText });
  }
  return replies;
}
