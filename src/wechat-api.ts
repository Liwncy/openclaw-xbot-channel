function trimBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/u, '');
}

export type WechatSendTextResult = {
  ok: boolean;
  messageId?: string;
  raw?: unknown;
};

function extractMessageId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const data = (raw as { data?: { msg_id?: unknown; new_msg_id?: unknown } }).data;
  const id = String(data?.new_msg_id ?? data?.msg_id ?? '').trim();
  return id || undefined;
}

function extractErrorMessage(raw: unknown, status: number): string {
  if (raw && typeof raw === 'object' && 'message' in raw) {
    const message = String((raw as { message?: unknown }).message || '').trim();
    if (message) return message;
  }
  return `HTTP ${status}`;
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
): Promise<WechatSendTextResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(extractErrorMessage(raw, response.status));
  }
  return { ok: true, messageId: extractMessageId(raw), raw };
}

async function postForm(
  url: string,
  fields: Record<string, string>,
): Promise<WechatSendTextResult> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value) form.append(key, value);
  }
  const response = await fetch(url, {
    method: 'POST',
    body: form,
  });
  const raw = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(extractErrorMessage(raw, response.status));
  }
  return { ok: true, messageId: extractMessageId(raw), raw };
}

export async function sendWechatText(
  baseUrl: string,
  receiver: string,
  content: string,
): Promise<WechatSendTextResult> {
  const apiBase = trimBaseUrl(baseUrl);
  if (!apiBase) throw new Error('wechatApiBaseUrl is not configured');
  const trimmedReceiver = receiver.trim();
  const trimmedContent = content.trim();
  if (!trimmedReceiver) throw new Error('receiver is required');
  if (!trimmedContent) throw new Error('content is required');

  return postJson(`${apiBase}/api/message/text`, {
    receiver: trimmedReceiver,
    content: trimmedContent,
  });
}

export async function sendWechatImageUrl(
  baseUrl: string,
  receiver: string,
  imageUrl: string,
  caption?: string,
): Promise<WechatSendTextResult> {
  const apiBase = trimBaseUrl(baseUrl);
  if (!apiBase) throw new Error('wechatApiBaseUrl is not configured');
  const trimmedReceiver = receiver.trim();
  const trimmedUrl = imageUrl.trim();
  if (!trimmedReceiver) throw new Error('receiver is required');
  if (!trimmedUrl) throw new Error('imageUrl is required');

  const result = await postJson(`${apiBase}/api/message/image`, {
    receiver: trimmedReceiver,
    image_url: trimmedUrl,
  });

  if (caption?.trim()) {
    await sendWechatText(apiBase, trimmedReceiver, caption.trim());
  }

  return result;
}

export async function sendWechatVoiceUrl(
  baseUrl: string,
  receiver: string,
  voiceUrl: string,
  options?: { durationMs?: number; format?: number; caption?: string },
): Promise<WechatSendTextResult> {
  const apiBase = trimBaseUrl(baseUrl);
  if (!apiBase) throw new Error('wechatApiBaseUrl is not configured');
  const trimmedReceiver = receiver.trim();
  const trimmedUrl = voiceUrl.trim();
  if (!trimmedReceiver) throw new Error('receiver is required');
  if (!trimmedUrl) throw new Error('voiceUrl is required');

  const result = await postForm(`${apiBase}/api/message/voice`, {
    receiver: trimmedReceiver,
    voice_url: trimmedUrl,
    duration: String(options?.durationMs ?? 5000),
    format: String(options?.format ?? 2),
  });

  if (options?.caption?.trim()) {
    await sendWechatText(apiBase, trimmedReceiver, options.caption.trim());
  }

  return result;
}

export async function sendWechatVideoUrl(
  baseUrl: string,
  receiver: string,
  videoUrl: string,
  options?: { durationSec?: number; caption?: string },
): Promise<WechatSendTextResult> {
  const apiBase = trimBaseUrl(baseUrl);
  if (!apiBase) throw new Error('wechatApiBaseUrl is not configured');
  const trimmedReceiver = receiver.trim();
  const trimmedUrl = videoUrl.trim();
  if (!trimmedReceiver) throw new Error('receiver is required');
  if (!trimmedUrl) throw new Error('videoUrl is required');

  // 优先走 CDN 上传（与 xchatbot sendWechatReply 一致）
  let result: WechatSendTextResult;
  try {
    result = await postForm(`${apiBase}/api/cdn/upload/video`, {
      receiver: trimmedReceiver,
      video_url: trimmedUrl,
      duration: String(options?.durationSec ?? 10),
    });
  } catch {
    result = await postForm(`${apiBase}/api/message/video`, {
      receiver: trimmedReceiver,
      video_url: trimmedUrl,
      duration: String(options?.durationSec ?? 10),
    });
  }

  if (options?.caption?.trim()) {
    await sendWechatText(apiBase, trimmedReceiver, options.caption.trim());
  }

  return result;
}

export async function sendWechatLink(
  baseUrl: string,
  receiver: string,
  link: { url: string; title: string; desc?: string; thumbUrl?: string },
  caption?: string,
): Promise<WechatSendTextResult> {
  const apiBase = trimBaseUrl(baseUrl);
  if (!apiBase) throw new Error('wechatApiBaseUrl is not configured');
  const trimmedReceiver = receiver.trim();
  const trimmedUrl = link.url.trim();
  if (!trimmedReceiver) throw new Error('receiver is required');
  if (!trimmedUrl) throw new Error('url is required');

  const result = await postJson(`${apiBase}/api/message/link`, {
    receiver: trimmedReceiver,
    url: trimmedUrl,
    title: link.title.trim() || '文件',
    desc: (link.desc || '').trim(),
    thumb_url: (link.thumbUrl || '').trim(),
  });

  if (caption?.trim()) {
    await sendWechatText(apiBase, trimmedReceiver, caption.trim());
  }

  return result;
}
