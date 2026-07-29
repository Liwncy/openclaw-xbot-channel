/**
 * [XbotParam:JSON] 标记解析（对齐 bncr 的 [BncrParam:] 思路）。
 *
 * 示例：
 * [XbotParam:{"asVoice":true,"type":"voice","path":"C:\\\\tmp\\\\a.mp3"}]
 * [XbotParam:{"paths":["a.mp4"],"type":"video"}]
 */

const PREFIX = '[XbotParam:';

function findMarkerEnd(text: string, prefixIdx: number): number {
  const start = prefixIdx + PREFIX.length;
  if (start >= text.length) return -1;

  let depth = 0;
  let inString = false;
  let esc = false;
  let started = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === '\\' && inString) {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (!started) {
        if (ch === '{' || ch === '[') {
          started = true;
          depth = 1;
        }
        continue;
      }
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) {
          if (i + 1 < text.length && text[i + 1] === ']') return i + 1;
          return -1;
        }
      }
    }
  }
  return -1;
}

export type XbotParamBag = {
  asVoice?: boolean;
  audioAsVoice?: boolean;
  type?: string;
  path?: string;
  paths?: string[];
  mediaUrl?: string;
  mediaUrls?: string[];
  [key: string]: unknown;
};

export function parseXbotParamMarker(text: string): {
  cleanText: string;
  params: XbotParamBag;
} {
  const params: XbotParamBag = {};
  let result = text;
  let searchFrom = 0;

  while (true) {
    const idx = result.indexOf(PREFIX, searchFrom);
    if (idx === -1) break;

    const end = findMarkerEnd(result, idx);
    if (end === -1) {
      searchFrom = idx + PREFIX.length;
      continue;
    }

    const rawJson = result.slice(idx + PREFIX.length, end);
    let parsedOk = false;
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(params, parsed as XbotParamBag);
        parsedOk = true;
      }
    } catch {
      // 解析失败：保留原文方便排查
    }

    if (parsedOk) {
      result = result.slice(0, idx) + result.slice(end + 1);
      searchFrom = idx;
    } else {
      searchFrom = end + 1;
    }
  }

  return {
    cleanText: result.replace(/\n{3,}/g, '\n\n').trim(),
    params,
  };
}

export function collectPathsFromXbotParams(params: XbotParamBag): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
  };
  push(params.path);
  push(params.mediaUrl);
  if (Array.isArray(params.paths)) params.paths.forEach(push);
  if (Array.isArray(params.mediaUrls)) params.mediaUrls.forEach(push);
  return out;
}
