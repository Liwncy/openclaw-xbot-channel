/**
 * 本轮已成功发出语音后，仍可能收到模型「做不了 / 没发出去」的定论文本。
 * 这些文案不应再推到微信。
 */

type VoiceSentEntry = { sentAt: number };

const recentVoiceSent = new Map<string, VoiceSentEntry>();
const VOICE_SENT_TTL_MS = 90_000;
const MAX_ENTRIES = 200;

function prune(now: number): void {
  for (const [key, entry] of recentVoiceSent) {
    if (now - entry.sentAt > VOICE_SENT_TTL_MS) recentVoiceSent.delete(key);
  }
  if (recentVoiceSent.size <= MAX_ENTRIES) return;
  const ordered = [...recentVoiceSent.entries()].sort((a, b) => a[1].sentAt - b[1].sentAt);
  for (const [key] of ordered.slice(0, recentVoiceSent.size - MAX_ENTRIES)) {
    recentVoiceSent.delete(key);
  }
}

function resolveToKey(to: string): string {
  return to.trim().toLowerCase();
}

/** message 工具或 deliver 任一路发出语音后标记，供后续失败定论过滤。 */
export function markVoiceRecentlySent(to: string): void {
  const key = resolveToKey(to);
  if (!key) return;
  const now = Date.now();
  prune(now);
  recentVoiceSent.set(key, { sentAt: now });
}

export function wasVoiceRecentlySent(to: string): boolean {
  const key = resolveToKey(to);
  if (!key) return false;
  const now = Date.now();
  prune(now);
  const hit = recentVoiceSent.get(key);
  return Boolean(hit && now - hit.sentAt <= VOICE_SENT_TTL_MS);
}

export function isVoiceFailureNarrative(text: string): boolean {
  const s = String(text || '').trim();
  if (!s) return false;

  if (/语音没发出去/.test(s)) return true;
  if (/等下再试试/.test(s) && /语音/.test(s)) return true;
  if (/只是文字版/.test(s) || /\(spoken\)/i.test(s) || /spoken\b/i.test(s)) return true;
  if (/不是能直接发的语音/.test(s) || /不是可发的语音/.test(s)) return true;
  if (/语音通路/.test(s) && /(没|恢复|不通|失败)/.test(s)) return true;
  if (/这条路.*没走通/.test(s) || /继续盲发没意义/.test(s)) return true;
  if (/等语音通路恢复/.test(s) || /先不硬来/.test(s)) return true;
  if (/还没生成/.test(s) && /(mp3|语音|音频)/i.test(s)) return true;
  if (/发不了/.test(s) && /语音/.test(s)) return true;
  if (/没发成/.test(s) && /语音/.test(s)) return true;
  if (/发失败/.test(s) && /语音/.test(s)) return true;
  if (/语音.*失败/.test(s) || /失败.*语音/.test(s)) return true;

  return false;
}

/**
 * 本轮已发出过语音时：丢掉失败定论文本；保留普通旁白/转录。
 */
export function filterRepliesAfterVoiceSent<T extends { type: string; content?: string }>(
  replies: T[],
): { replies: T[]; dropped: number } {
  let dropped = 0;
  const kept: T[] = [];
  for (const reply of replies) {
    if (reply.type === 'text' && isVoiceFailureNarrative(reply.content || '')) {
      dropped += 1;
      continue;
    }
    kept.push(reply);
  }
  return { replies: kept, dropped };
}

/**
 * 语音还没成功发出时：中间 block 上的失败定论先不发，避免「先说做不了再出语音」。
 * final 仍放行（若最终真失败需要那句短回）。
 */
export function shouldHoldVoiceFailureNarrative(args: {
  kind?: 'tool' | 'block' | 'final';
  voiceSentThisTurn: boolean;
  text: string;
}): boolean {
  if (args.voiceSentThisTurn) return false;
  if (args.kind === 'final') return false;
  return isVoiceFailureNarrative(args.text);
}
