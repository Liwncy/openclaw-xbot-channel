import { randomUUID } from 'node:crypto';
import type { ChannelMessageSendResult } from 'openclaw/plugin-sdk/channel-message';
import { createMessageReceiptFromOutboundResults } from 'openclaw/plugin-sdk/channel-outbound';
import {
  normalizeAccountId,
  resolveXchatbotApiBaseUrl,
  resolveXchatbotToken,
  type XbotChannelConfigRoot,
  type XbotRoute,
  type XchatbotReply,
} from './config.ts';

export type { XchatbotReply };

export function resolveOutboundReceiver(route: XbotRoute): string {
  return route.kind === 'group' ? route.groupId || route.to : route.userId || route.to;
}

export function buildExplicitTarget(route: XbotRoute): string {
  const prefix = route.platform ? `${route.platform}:` : '';
  if (route.kind === 'group') {
    return `${prefix}group:${route.groupId || route.to}`;
  }
  return `${prefix}user:${route.userId || route.to}`;
}

export function parseExplicitTarget(raw: string, fallbackPlatform = ''): { route: XbotRoute } | null {
  const input = raw.trim();
  if (!input) return null;
  let platform = fallbackPlatform;
  let rest = input;
  const platformMatch = rest.match(/^([a-z0-9_-]+):(group:|user:)/i);
  if (platformMatch) {
    platform = platformMatch[1];
    rest = rest.slice(platform.length + 1);
  }
  if (rest.startsWith('group:')) {
    const groupId = rest.slice('group:'.length).trim();
    if (!groupId) return null;
    return { route: { kind: 'group', platform, to: groupId, groupId } };
  }
  if (rest.startsWith('user:')) {
    const userId = rest.slice('user:'.length).trim();
    if (!userId) return null;
    return { route: { kind: 'direct', platform, to: userId, userId } };
  }
  if (rest.endsWith('@chatroom')) {
    return { route: { kind: 'group', platform, to: rest, groupId: rest } };
  }
  return { route: { kind: 'direct', platform, to: rest, userId: rest } };
}

export type XbotSendResult = ChannelMessageSendResult & {
  ok: boolean;
  sentCount: number;
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function extensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split('/').pop() || '';
    const dot = base.lastIndexOf('.');
    return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
  } catch {
    return '';
  }
}

function kindFromHint(params: {
  url: string;
  mimeType?: string;
  fileName?: string;
  hintedType?: string;
  audioAsVoice?: boolean;
}): 'image' | 'video' | 'voice' | 'file' {
  const hinted = asString(params.hintedType).toLowerCase();
  if (hinted === 'voice' || hinted === 'audio') return 'voice';
  if (hinted === 'video' || hinted === 'image' || hinted === 'file') return hinted;

  const mime = asString(params.mimeType).toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'voice';

  const name = asString(params.fileName) || params.url;
  const ext = extensionFromUrl(name) || extensionFromUrl(params.url);
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'avif'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'm4v', 'webm', 'mkv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'amr', 'silk', 'slk'].includes(ext)) return 'voice';
  if (ext) return 'file';
  if (params.audioAsVoice) return 'voice';
  return 'image';
}

function mapMediaUrl(params: {
  url: string;
  mimeType?: string;
  fileName?: string;
  hintedType?: string;
  audioAsVoice?: boolean;
}): XchatbotReply | null {
  const url = asString(params.url);
  if (!isHttpUrl(url)) return null;
  const kind = kindFromHint({ ...params, url });
  if (kind === 'voice') {
    const ext = extensionFromUrl(url);
    return { type: 'voice', url, format: ext === 'silk' || ext === 'slk' ? '4' : '2' };
  }
  if (kind === 'video') return { type: 'video', url };
  if (kind === 'file') {
    return { type: 'link', title: asString(params.fileName) || '文件', url };
  }
  return { type: 'image', url };
}

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
  const audioAsVoice = payload.audioAsVoice === true || payload.asVoice === true;
  const hintedType = asString(payload.type || payload.kind);
  const urls = [
    asString(payload.mediaUrl),
    ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls.map(asString) : []),
  ].filter(Boolean);
  const unique = [...new Set(urls)];

  const replies: XchatbotReply[] = [];
  for (const url of unique) {
    const mapped = mapMediaUrl({
      url,
      mimeType: payload.mimeType,
      fileName: payload.fileName,
      hintedType,
      audioAsVoice,
    });
    if (mapped) replies.push(mapped);
  }

  const text = normalizeOutboundText(typeof payload.text === 'string' ? payload.text : '');
  if (text) replies.push({ type: 'text', content: text });
  return replies;
}

function trimBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/u, '');
}

function sanitizeOutboundReplies(replies: XchatbotReply[]): XchatbotReply[] {
  const out: XchatbotReply[] = [];
  for (const reply of replies) {
    if (reply.type !== 'text') {
      out.push(reply);
      continue;
    }
    if (looksLikeToolDraft(reply.content)) continue;
    const content = normalizeOutboundText(reply.content);
    if (!content || looksLikeToolDraft(content)) continue;
    out.push({ type: 'text', content });
  }
  return out;
}

export async function sendReplies(args: {
  cfg: XbotChannelConfigRoot;
  route: XbotRoute;
  replies: XchatbotReply[];
  replyToMessageId?: string;
  onWarn?: (message: string) => void;
}): Promise<XbotSendResult> {
  const apiBase = trimBaseUrl(resolveXchatbotApiBaseUrl(args.cfg));
  const token = resolveXchatbotToken(args.cfg);
  if (!apiBase) throw new Error('xchatbotApiBaseUrl is not configured');
  if (!token) throw new Error('xchatbotToken is not configured');
  const replies = sanitizeOutboundReplies(args.replies);
  if (replies.length === 0) {
    return emptySendResult();
  }
  if (!args.route.platform) throw new Error('platform is required');

  const response = await fetch(`${apiBase}/openclaw/outbound`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      platform: args.route.platform,
      source: args.route.kind === 'group' ? 'group' : 'private',
      from: args.route.userId || args.route.to,
      roomId: args.route.groupId,
      messageId: args.replyToMessageId,
      replies,
    }),
  });
  const raw = await response.json().catch(() => null) as { ok?: boolean; sentCount?: number; error?: string } | null;
  if (!response.ok || raw?.ok !== true) {
    const detail = raw?.error || `HTTP ${response.status}`;
    args.onWarn?.(`[xbot] xchatbot outbound failed: ${detail}`);
    throw new Error(detail);
  }

  const messageId = randomUUID();
  return {
    messageId,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ messageId, channel: 'xbot' }],
      sentAt: Date.now(),
    }),
    ok: true,
    sentCount: typeof raw.sentCount === 'number' ? raw.sentCount : args.replies.length,
  };
}

function emptySendResult(): XbotSendResult {
  const messageId = randomUUID();
  return {
    messageId,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ messageId, channel: 'xbot' }],
      sentAt: Date.now(),
    }),
    ok: true,
    sentCount: 0,
  };
}

function resolveRoute(to: string, route?: XbotRoute): XbotRoute {
  if (route) return route;
  const parsed = parseExplicitTarget(to);
  if (!parsed?.route) throw new Error(`invalid target: ${to}`);
  return parsed.route;
}

export async function sendXbotText(args: {
  cfg: XbotChannelConfigRoot;
  accountId?: string | null;
  to: string;
  text: string;
  route?: XbotRoute;
}): Promise<XbotSendResult> {
  void normalizeAccountId(args.accountId);
  const text = normalizeOutboundText(args.text);
  if (!text) {
    if (looksLikeRejectedDraft(args.text)) return emptySendResult();
    throw new Error('text is required');
  }
  return sendReplies({
    cfg: args.cfg,
    route: resolveRoute(args.to, args.route),
    replies: [{ type: 'text', content: text }],
  });
}

export async function sendXbotMedia(args: {
  cfg: XbotChannelConfigRoot;
  accountId?: string | null;
  to: string;
  text?: string;
  mediaUrl?: string;
  mimeType?: string;
  fileName?: string;
  type?: string;
  audioAsVoice?: boolean;
  asVoice?: boolean;
  route?: XbotRoute;
}): Promise<XbotSendResult> {
  void normalizeAccountId(args.accountId);
  const replies = mapOpenClawPayloadToReplies({
    text: args.text,
    mediaUrl: args.mediaUrl,
    mimeType: args.mimeType,
    fileName: args.fileName,
    type: args.type,
    audioAsVoice: args.audioAsVoice,
    asVoice: args.asVoice,
  });
  if (replies.length === 0) {
    throw new Error('mediaUrl must be a public http(s) URL');
  }
  return sendReplies({
    cfg: args.cfg,
    route: resolveRoute(args.to, args.route),
    replies,
  });
}

const TOOL_XML_TAGS = [
  'invoke',
  'parameter',
  'function_calls',
  'function_call',
  'tool_calls',
  'tool_call',
  'tool_use',
  'thinking',
  'antthinking',
] as const;

const ADVISOR_MARK = /\[Advisor\b/i;
const SYSTEM_HINT_MARK = /\[系统提示：/;
const AUDIO_FILENAME = /^[A-Za-z0-9._\-]+\.(wav|mp3|m4a|ogg|silk|slk)$/i;
const ENGLISH_ADVISOR_LEADS = [
  'The user is asking',
  'The assistant should:',
  'Keep the tone',
  'The executor is stuck',
] as const;

function tidyBlankLines(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function looksLikeToolDraft(text: string): boolean {
  return TOOL_XML_TAGS.some((tag) => new RegExp(`<${tag}\\b`, 'i').test(text));
}

function looksLikeAdvisorLeak(text: string): boolean {
  if (ADVISOR_MARK.test(text)) return true;
  return ENGLISH_ADVISOR_LEADS.some((lead) => text.toLowerCase().includes(lead.toLowerCase()));
}

function looksLikeSystemEcho(text: string): boolean {
  return SYSTEM_HINT_MARK.test(text) || /^\s*NO_REPLY\s*$/im.test(text);
}

function looksLikeErrorDump(text: string): boolean {
  return /^\s*\[ERROR\]/im.test(text) || /^\s*Error code=/im.test(text);
}

/** 整段都是内部废稿、不该发到微信。 */
export function looksLikeRejectedDraft(text: string): boolean {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  return looksLikeToolDraft(raw)
    || looksLikeAdvisorLeak(raw)
    || looksLikeSystemEcho(raw)
    || looksLikeErrorDump(raw)
    || AUDIO_FILENAME.test(raw.trim());
}

function stripNamedXmlBlocks(text: string, names: readonly string[]): string {
  let s = text;
  for (const name of names) {
    s = s.replace(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}>`, 'gi'), '\n');
    s = s.replace(new RegExp(`<\\/?${name}\\b[^>]*>`, 'gi'), '\n');
    if (new RegExp(`<${name}\\b`, 'i').test(s)) {
      s = s.replace(new RegExp(`<${name}\\b[\\s\\S]*$`, 'gi'), '\n');
    }
  }
  return s;
}

function stripAdvisorLeak(text: string): string {
  let s = text;
  s = s.replace(
    /\[Advisor consultation #\d+\][\s\S]*?\[End of advisor consultation #\d+\]/gi,
    '\n',
  );
  s = s.replace(
    /\[Advisor consultation #\d+\][\s\S]*?(?=(?:^|\n)[\u4e00-\u9fff])/gim,
    '\n',
  );
  s = s.replace(/\[Advisor consultation #\d+\][\s\S]*$/gim, '\n');
  s = s
    .replace(/\[End of advisor consultation #\d+\]/gi, '')
    .replace(/\[Advisor consultation #\d+\]/gi, '')
    .replace(/\[Advisor review\]/gi, '')
    .replace(/\[Advisor[^\]]*\]/gi, '');

  for (const lead of ENGLISH_ADVISOR_LEADS) {
    const escaped = lead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(
      new RegExp(`(?:^|\\n)\\s*${escaped}[\\s\\S]*?(?=(?:^|\\n)[\\u4e00-\\u9fff]|$)`, 'gim'),
      '\n',
    );
  }
  return s;
}

function stripSystemEcho(text: string): string {
  return text
    .replace(/\[系统提示：[\s\S]*?\[\/系统提示\]/g, '\n')
    .replace(/\[系统提示：[\s\S]*$/g, '\n')
    .replace(/^\s*NO_REPLY\s*$/gim, '');
}

function stripErrorDump(text: string): string {
  return text
    .replace(/^\s*\[ERROR\][^\n]*/gim, '')
    .replace(/^\s*Error code=\S+[^\n]*/gim, '');
}

/** 工具草稿、顾问旁白、系统回声、报错堆字，一律剥掉。 */
export function stripRejectedDraft(text: string): string {
  if (!text) return text;
  let s = String(text);
  s = stripNamedXmlBlocks(s, TOOL_XML_TAGS);
  s = stripAdvisorLeak(s);
  s = stripSystemEcho(s);
  s = stripErrorDump(s);
  s = tidyBlankLines(s);
  if (AUDIO_FILENAME.test(s)) return '';
  return s;
}

function stripCodeFences(text: string): string {
  return text.replace(/```[\w-]*\r?\n?([\s\S]*?)```/g, (_m, body: string) => {
    const inner = String(body || '').replace(/\s+$/g, '').replace(/^\s+/g, '');
    return inner ? `\n${inner}\n` : '';
  });
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, url: string) => {
      const a = String(alt || '').trim();
      const u = String(url || '').trim();
      return a || u;
    })
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
      const t = String(label || '').trim();
      const u = String(url || '').trim();
      if (!t) return u;
      if (!u || t === u) return t;
      return `${t}（${u}）`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1')
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1');
}

function convertMarkdownBlocks(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/[ \t]+$/g, '');
    const trimmed = line.trim();

    if (/^(?:image|video|audio|voice|link|music|emoji|app):/i.test(trimmed)) {
      out.push(line);
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const title = heading[2]!.trim();
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      out.push(title);
      out.push('');
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      out.push(quote[1]!.trim() ? `「${quote[1]!.trim()}」` : '');
      continue;
    }

    const ul = trimmed.match(/^[-*+]\s+(.+)$/);
    if (ul) {
      out.push(`· ${ul[1]!.trim()}`);
      continue;
    }
    const ol = trimmed.match(/^(\d+)[.)、]\s+(.+)$/);
    if (ol) {
      out.push(`${ol[1]}）${ol[2]!.trim()}`);
      continue;
    }

    if (/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(trimmed)) {
      continue;
    }
    if (trimmed.includes('|') && /^\|?.+\|.+\|?$/.test(trimmed)) {
      out.push(
        trimmed
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim())
          .filter(Boolean)
          .join(' · '),
      );
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

function looksStructured(text: string): boolean {
  if (/^· /m.test(text) || /^\d+）/m.test(text)) return true;
  if (/(^|\n)(#{1,6}\s|[-*+]\s|\d+[.)、]\s)/.test(text)) return true;
  return false;
}

function looksLikeOutboundProtocol(text: string): boolean {
  return /^(?:image|video|audio|voice|link|music|emoji|app):/im.test(text);
}

function attachOrphanEmojis(text: string): string {
  return text.replace(
    /([^\n])\n+(?:[ \t]*\n+)*([ \t]*[\p{Extended_Pictographic}\uFE0F\u200D]+[ \t]*)(?=\n|$)/gu,
    '$1 $2',
  );
}

function collapseCasualChat(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([\p{Extended_Pictographic}\uFE0F\u200D]+)/gu, ' $1')
    .trim();
}

function tidyLongAnswer(text: string): string {
  let s = text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  s = attachOrphanEmojis(s);
  s = s
    .replace(/(· [^\n]+)\n\n(?=· )/g, '$1\n')
    .replace(/(\d+）[^\n]+)\n\n(?=\d+）)/g, '$1\n');

  return s.trim();
}

export function normalizeOutboundText(text: string): string {
  if (!text) return '';

  let s = String(text);
  s = stripCodeFences(s);
  s = stripRejectedDraft(s);
  s = convertMarkdownBlocks(s);
  s = stripInlineMarkdown(s);
  s = s.replace(/[\u2028\u2029\u0085]/g, '\n');

  if (looksStructured(s) || looksLikeOutboundProtocol(s)) {
    return tidyLongAnswer(s);
  }
  return collapseCasualChat(s);
}
