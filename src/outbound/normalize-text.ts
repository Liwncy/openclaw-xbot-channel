/**
 * 微信气泡几乎不渲染 Markdown；Gateway 网页看着整齐，到微信会变成 **、#、- 裸字符。
 * 这里把常见 Markdown 收成微信可读纯文本，并按「闲聊 / 长答」智能处理换行。
 */

/** 剥离模型/顾问链路泄漏的内部标记，避免发到微信。 */
function stripInternalMarkers(text: string): string {
  return text
    .replace(/\[Advisor consultation #\d+\]/gi, '')
    .replace(/\[End of advisor consultation #\d+\]/gi, '')
    .replace(/\[Advisor review\]/gi, '')
    .replace(/\[Advisor[^\]]*\]/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n');
}

function stripCodeFences(text: string): string {
  return text.replace(/```[\w-]*\r?\n?([\s\S]*?)```/g, (_m, body: string) => {
    const inner = String(body || '').replace(/\s+$/g, '').replace(/^\s+/g, '');
    return inner ? `\n${inner}\n` : '';
  });
}

function stripInlineMarkdown(text: string): string {
  return text
    // 图片 ![alt](url) → alt 或 url
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, url: string) => {
      const a = String(alt || '').trim();
      const u = String(url || '').trim();
      return a || u;
    })
    // 链接 [text](url) → text（url）
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
      const t = String(label || '').trim();
      const u = String(url || '').trim();
      if (!t) return u;
      if (!u || t === u) return t;
      return `${t}（${u}）`;
    })
    // 粗体/斜体标记
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1')
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1')
    // 行内代码
    .replace(/`([^`]+)`/g, '$1')
    // 删除线
    .replace(/~~([^~]+)~~/g, '$1');
}

function convertMarkdownBlocks(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/[ \t]+$/g, '');
    const trimmed = line.trim();

    // 标题 # ## ### → 单独成行，去掉 #
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const title = heading[2]!.trim();
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      out.push(title);
      out.push('');
      continue;
    }

    // 引用 >
    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      out.push(quote[1]!.trim() ? `「${quote[1]!.trim()}」` : '');
      continue;
    }

    // 无序/有序列表
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

    // 表格行：跳过分隔线，单元格改成「 · 」连接
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

function looksStructured(text: string): boolean {
  if (/^· /m.test(text) || /^\d+）/m.test(text)) return true;
  if (/(^|\n)(#{1,6}\s|[-*+]\s|\d+[.)、]\s)/.test(text)) return true;
  // 两段及以上（空行分段）
  if (/\n\s*\n/.test(text) && text.replace(/\s+/g, '').length >= 40) return true;
  return false;
}

function collapseSoftNewlines(text: string): string {
  return text.replace(/\n+/g, (match) => (match.length >= 2 ? '\n\n' : ' '));
}

function tidyWhitespace(text: string, keepStructure: boolean): string {
  let s = text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!keepStructure) {
    s = collapseSoftNewlines(s);
  } else {
    // 长答：去掉「列表项之间的多余空行」，保留段落空行
    s = s
      .replace(/\n{3,}/g, '\n\n')
      .replace(/(· [^\n]+)\n\n(?=· )/g, '$1\n')
      .replace(/(\d+）[^\n]+)\n\n(?=\d+）)/g, '$1\n');
  }

  return s.trim();
}

/**
 * 微信出站文本规范化。
 * - 闲聊短句：软换行收成空格，避免气泡里乱断行
 * - 长答/列表：保留分段与条目行，去掉 Markdown 标记
 */
export function normalizeWechatOutboundText(text: string): string {
  if (!text) return '';

  let s = String(text);
  s = stripInternalMarkers(s);
  s = stripCodeFences(s);
  s = convertMarkdownBlocks(s);
  s = stripInlineMarkdown(s);
  s = s.replace(/[\u2028\u2029\u0085]/g, '\n');

  const structured = looksStructured(s);
  // 很短且无结构 → 当闲聊
  const plainLen = s.replace(/\s+/g, '').length;
  const keepStructure = structured || plainLen >= 80;

  return tidyWhitespace(s, keepStructure);
}
