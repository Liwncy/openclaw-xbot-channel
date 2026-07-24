/**
 * 微信气泡几乎不渲染 Markdown；Gateway 网页看着整齐，到微信会变成 **、#、- 裸字符。
 * 这里把常见 Markdown 收成微信可读纯文本，并按「闲聊 / 长答」智能处理换行。
 */

/**
 * 剥离模型泄漏的「顾问草稿」整块。
 * 若块内夹了中文试写、块外又有正式回复，只保留 End 之后的内容。
 */
function stripInternalMarkers(text: string): string {
  let s = String(text);

  // 完整顾问块整段删除（含块内中英文）
  s = s.replace(
    /\[Advisor consultation #\d+\][\s\S]*?\[End of advisor consultation #\d+\]/gi,
    '\n',
  );

  // 只有开头没有 End：删到第一个中文行之前的前缀
  s = s.replace(
    /\[Advisor consultation #\d+\][\s\S]*?(?=(?:^|\n)[\u4e00-\u9fff])/gim,
    '\n',
  );

  // 残留标签
  s = s
    .replace(/\[End of advisor consultation #\d+\]/gi, '')
    .replace(/\[Advisor consultation #\d+\]/gi, '')
    .replace(/\[Advisor review\]/gi, '')
    .replace(/\[Advisor[^\]]*\]/gi, '');

  // 标签被吃掉后的英文提纲残留
  s = s.replace(
    /(?:^|\n)\s*The user is asking[\s\S]*?(?=(?:^|\n)[\u4e00-\u9fff])/gim,
    '\n',
  );
  s = s.replace(
    /(?:^|\n)\s*The assistant should:[\s\S]*?(?=(?:^|\n)[\u4e00-\u9fff])/gim,
    '\n',
  );
  s = s.replace(
    /(?:^|\n)\s*Keep the tone[\s\S]*?(?=(?:^|\n)[\u4e00-\u9fff])/gim,
    '\n',
  );

  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
      const cells = trimmed
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length > 0) out.push(cells.join(' · '));
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

/** 仅标题/列表算「长文结构」；光有空行不算（顾问块残留空行会误判）。 */
function looksStructured(text: string): boolean {
  if (/^· /m.test(text) || /^\d+）/m.test(text)) return true;
  if (/(^|\n)(#{1,6}\s|[-*+]\s|\d+[.)、]\s)/.test(text)) return true;
  return false;
}

/** 把单独成行的 emoji 贴回上一行末尾。 */
function attachOrphanEmojis(text: string): string {
  // 上一行正文 + 空行(们) + 仅 emoji 的行 → 同一行
  return text.replace(
    /([^\n])\n+(?:[ \t]*\n+)*([ \t]*[\p{Extended_Pictographic}\uFE0F\u200D]+[ \t]*)(?=\n|$)/gu,
    '$1 $2',
  );
}

/** 闲聊：全部空白压成单空格，一句气泡说完。 */
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

/**
 * 微信出站文本规范化。
 * - 闲聊：一律压成一行（表情不单独占行）
 * - 长答/列表：保留分段，但仍把落单 emoji 贴回上一行
 */
export function normalizeWechatOutboundText(text: string): string {
  if (!text) return '';

  let s = String(text);
  s = stripInternalMarkers(s);
  s = stripCodeFences(s);
  s = convertMarkdownBlocks(s);
  s = stripInlineMarkdown(s);
  s = s.replace(/[\u2028\u2029\u0085]/g, '\n');

  if (looksStructured(s)) {
    return tidyLongAnswer(s);
  }
  return collapseCasualChat(s);
}
