import type {XbotChannelConfigRoot} from '../types.ts';

/** 默认主人（李芈仙）；可被 channels.xbot.ownerAllowFrom / commands.ownerAllowFrom 覆盖 */
export const DEFAULT_OWNER_WECHAT_IDS = ['wxid_5jfnhtqy74xr22'] as const;

export type NativeCommandAliasHit = {
  /** 改写后的 OpenClaw 斜杠指令，如 /clear */
  commandBody: string;
  /** 命中的通俗口令摘要（日志用） */
  matched: string;
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqIds(ids: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 规范化配置里的主人 id（去掉 xbot: 前缀便于和 senderId 比） */
function normalizeOwnerId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('xbot:')) return trimmed.slice('xbot:'.length).trim();
  return trimmed;
}

export function resolveOwnerWechatIds(cfg: XbotChannelConfigRoot | undefined): string[] {
  const channelOwners = Array.isArray(cfg?.channels?.xbot?.ownerAllowFrom)
    ? cfg!.channels!.xbot!.ownerAllowFrom!.map(asString).filter(Boolean)
    : [];
  const commandOwners = Array.isArray(cfg?.commands?.ownerAllowFrom)
    ? cfg!.commands!.ownerAllowFrom!.map(asString).filter(Boolean)
    : [];
  const merged = uniqIds([...channelOwners, ...commandOwners].map(normalizeOwnerId).filter(Boolean));
  return merged.length > 0 ? merged : [...DEFAULT_OWNER_WECHAT_IDS];
}

export function isXbotOwnerSender(
  cfg: XbotChannelConfigRoot | undefined,
  senderId: string,
): boolean {
  const id = asString(senderId);
  if (!id) return false;
  const owners = resolveOwnerWechatIds(cfg);
  return owners.some((owner) => owner === id || owner.toLowerCase() === id.toLowerCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * 去掉 @某人 / 微信 @ 后的窄空格，以及行首机器人昵称。
 * 只服务于口令匹配；不改变「必须点名才进 OpenClaw」的转发策略。
 */
export function stripAtMentions(text: string, botNames: string[] = []): string {
  let s = String(text || '')
    // @昵称 后常跟普通空格或 \u2005
    .replace(/@[^\s@\u2005]{1,64}[\s\u2005]*/gu, ' ');
  for (const name of botNames) {
    const n = name.trim();
    if (!n) continue;
    s = s.replace(new RegExp(`^${escapeRegExp(n)}[\\s\\u2005]+`, 'u'), '');
  }
  return s.replace(/\s+/gu, ' ').trim();
}

type AliasRule = {
  /** 完整匹配或带捕获 */
  pattern: RegExp;
  /** 静态指令，或用 groups 拼 */
  to: string | ((match: RegExpMatchArray) => string);
  label: string;
};

const ALIAS_RULES: AliasRule[] = [
  {pattern: /^(停下|别说了|停止)$/u, to: '/stop', label: '停下'},
  {pattern: /^重置会话$/u, to: '/reset', label: '重置会话'},
  {pattern: /^(新会话|重新开始)$/u, to: '/new', label: '新会话'},
  {pattern: /^(压缩上下文|压一下上下文)$/u, to: '/compact', label: '压缩上下文'},
  {
    pattern: /^(?:会话改名|改名)\s+(.+)$/u,
    to: (m) => `/name ${m[1]!.trim()}`,
    label: '会话改名',
  },
  {pattern: /^(清空会话|清一下记录)$/u, to: '/clear', label: '清空会话'},
  {pattern: /^看思考档$/u, to: '/think', label: '看思考档'},
  {
    pattern: /^思考\s*([a-zA-Z0-9_-]+)$/u,
    to: (m) => `/think ${m[1]!.trim()}`,
    label: '思考档位',
  },
  {pattern: /^看模型$/u, to: '/model', label: '看模型'},
  {
    pattern: /^换模型(?:\s+(.+))?$/u,
    to: (m) => {
      const name = (m[1] || '').trim();
      return name ? `/model ${name}` : '/model';
    },
    label: '换模型',
  },
  {pattern: /^(啰嗦开|详细模式)$/u, to: '/verbose on', label: '啰嗦开'},
  {pattern: /^啰嗦关$/u, to: '/verbose off', label: '啰嗦关'},
  {pattern: /^快速模式开$/u, to: '/fast on', label: '快速模式开'},
  {pattern: /^快速模式关$/u, to: '/fast off', label: '快速模式关'},
  {pattern: /^推理可见开$/u, to: '/reasoning on', label: '推理可见开'},
  {pattern: /^推理可见关$/u, to: '/reasoning off', label: '推理可见关'},
  {pattern: /^有哪些模型$/u, to: '/models', label: '有哪些模型'},
];

export type ResolveNativeCommandAliasOptions = {
  /** 机器人对外昵称，用于去掉「@小聪明儿 / 小聪明儿」前缀 */
  botNames?: string[];
};

/**
 * 将通俗中文口令解析为 OpenClaw 斜杠指令。
 * 仅匹配整句（去掉 @/昵称前缀后）；不匹配则返回 null。
 * 调用方仍须先靠点名进入 OpenClaw，本函数不会强制入站。
 */
export function resolveNativeCommandAlias(
  rawBody: string,
  options?: ResolveNativeCommandAliasOptions,
): NativeCommandAliasHit | null {
  const text = stripAtMentions(rawBody, options?.botNames || []);
  if (!text) return null;
  for (const rule of ALIAS_RULES) {
    const match = text.match(rule.pattern);
    if (!match) continue;
    const commandBody = typeof rule.to === 'function' ? rule.to(match) : rule.to;
    return {commandBody, matched: rule.label};
  }
  return null;
}

/** 是否像 OpenClaw 文本斜杠指令（用于主人 OwnerAllowFrom 提示） */
export function looksLikeOpenClawSlashCommand(
  rawBody: string,
  options?: ResolveNativeCommandAliasOptions,
): boolean {
  const text = stripAtMentions(rawBody, options?.botNames || []);
  return /^\/[a-zA-Z][\w-]*/u.test(text);
}
