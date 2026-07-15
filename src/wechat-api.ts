function trimBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/u, '');
}

export type WechatSendTextResult = {
  ok: boolean;
  messageId?: string;
  raw?: unknown;
};

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

  const response = await fetch(`${apiBase}/api/message/text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      receiver: trimmedReceiver,
      content: trimmedContent,
    }),
  });

  const raw = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      raw && typeof raw === 'object' && 'message' in raw
        ? String((raw as { message?: unknown }).message || '')
        : `HTTP ${response.status}`;
    throw new Error(message || `HTTP ${response.status}`);
  }

  const messageId =
    raw && typeof raw === 'object'
      ? String(
          (raw as { data?: { msg_id?: unknown; new_msg_id?: unknown } }).data?.new_msg_id ??
            (raw as { data?: { msg_id?: unknown } }).data?.msg_id ??
            '',
        ).trim() || undefined
      : undefined;

  return { ok: true, messageId, raw };
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

  const response = await fetch(`${apiBase}/api/message/image`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      receiver: trimmedReceiver,
      image_url: trimmedUrl,
    }),
  });

  const raw = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      raw && typeof raw === 'object' && 'message' in raw
        ? String((raw as { message?: unknown }).message || '')
        : `HTTP ${response.status}`;
    throw new Error(message || `HTTP ${response.status}`);
  }

  if (caption?.trim()) {
    await sendWechatText(apiBase, trimmedReceiver, caption.trim());
  }

  return { ok: true, raw };
}
