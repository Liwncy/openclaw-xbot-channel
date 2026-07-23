/**
 * 微信气泡对换行很敏感；模型常在中文短句里塞软换行。
 * 单换行收成空格，连续空行保留为分段；顺带清掉 Unicode 行分隔符。
 */
export function normalizeWechatOutboundText(text: string): string {
  if (!text) return '';
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029\u0085]/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n+/g, (match) => (match.length >= 2 ? '\n\n' : ' '))
    .trim();
}
