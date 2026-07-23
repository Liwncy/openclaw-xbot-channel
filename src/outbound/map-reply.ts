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

const IMAGE_EXT = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'tif', 'tiff',
]);
const VIDEO_EXT = new Set([
  'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', '3gp', 'mpeg', 'mpg',
]);
const AUDIO_EXT = new Set([
  'mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'amr', 'silk', 'wma', 'aiff',
]);

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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
    const base = clean.split('/').pop() || '';
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
    return decodeURIComponent(clean.split('/').pop() || '') || 'file';
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

export function resolveOpenClawMediaKind(params: {
  mediaUrl: string;
  mimeType?: string;
  fileName?: string;
  hintedType?: string;
  audioAsVoice?: boolean;
}): OpenClawMediaKind {
  const hinted = asString(params.hintedType).toLowerCase();
  if (hinted === 'voice') return 'voice';
  if (hinted === 'audio') return params.audioAsVoice ? 'voice' : 'audio';
  if (hinted === 'video' || hinted === 'image' || hinted === 'file') return hinted;

  const fromMime = kindFromMime(params.mimeType);
  if (fromMime === 'audio') return params.audioAsVoice ? 'voice' : 'audio';
  if (fromMime) return fromMime;

  const name = asString(params.fileName) || fileNameFromUrl(params.mediaUrl);
  const ext = name.includes('.')
    ? name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    : extensionFromUrl(params.mediaUrl);
  const fromExt = kindFromExtension(ext);
  if (fromExt === 'audio') return params.audioAsVoice ? 'voice' : 'audio';
  if (fromExt) return fromExt;
  // 有明确后缀但不是图/音/视频 → 当文件（链接卡片）
  if (ext) return 'file';

  // OpenClaw 显式要求语音时，即使无后缀也按语音发
  if (params.audioAsVoice) return 'voice';

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

  switch (kind) {
    case 'voice':
      return {
        type: 'voice',
        mediaId: mediaUrl,
        originalUrl: mediaUrl,
        fallbackText: `语音：${mediaUrl}`,
      };
    case 'audio':
      // 微信无「普通音频文件」直发，降级链接卡片
      return {
        type: 'news',
        articles: [{
          title: fileName || '音频',
          description: '点击收听/下载',
          url: mediaUrl,
        }],
      };
    case 'video':
      return {
        type: 'video',
        mediaId: mediaUrl,
        originalUrl: mediaUrl,
      };
    case 'file':
      return {
        type: 'news',
        articles: [{
          title: fileName || '文件',
          description: '点击查看/下载',
          url: mediaUrl,
        }],
      };
    case 'image':
    default:
      return {
        type: 'image',
        mediaId: mediaUrl,
        originalUrl: mediaUrl,
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
  const text = asString(payload.text);
  const audioAsVoice = payload.audioAsVoice === true || payload.asVoice === true;
  const urls: string[] = [];
  const single = asString(payload.mediaUrl);
  if (single) urls.push(single);
  for (const item of Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []) {
    const url = asString(item);
    if (url && !urls.includes(url)) urls.push(url);
  }

  const replies: XchatbotReply[] = urls.map((mediaUrl) => mapMediaUrlToReply({
    mediaUrl,
    mimeType: payload.mimeType,
    fileName: payload.fileName,
    hintedType: payload.type || payload.kind,
    audioAsVoice,
  }));

  if (text) {
    replies.push({ type: 'text', content: text });
  }
  return replies;
}
