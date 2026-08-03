import {access, mkdir, readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import type {AnyAgentTool, OpenClawPluginApi} from 'openclaw/plugin-sdk/core';
import {jsonResult} from 'openclaw/plugin-sdk/core';

type LearnTarget = 'pending' | 'routes' | 'mode';

type LearnWriteParams = {
  target?: LearnTarget;
  title?: string;
  kind?: string;
  summary?: string;
  trigger?: string;
  /** keyword | mention | quote | keyword+quote */
  triggerStyle?: string;
  /** 免 @ / 引用场景的触发词或前缀 */
  keywords?: string;
  action?: string;
  delegateTo?: string;
  evidence?: string;
  roomId?: string;
  entryMarkdown?: string;
};

/** 不能作为转交目标：机器人自己 / 主人（只打目标与口令，不扫依据正文） */
const FORBIDDEN_DELEGATE_PATTERNS: RegExp[] = [
  /小聪明儿?/u,
  /wxid_ahl9az25aljx22/i,
  /李芈仙/u,
  /\bliwncy\b/i,
  /wxid_5jfnhtqy74xr22/i,
  /本机器人/u,
];

const MODE_IDS = new Set(['normal', 'foxi', 'lazy', 'lcmm', 'ysqq', 'ghds', 'gxwy']);

const XBOT_LEARN_WRITE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: {
      type: 'string',
      enum: ['pending', 'routes', 'mode'],
      description:
        'routes=转交/指令/可咨询人；pending=草稿或待批 skill；mode=写入当前模式 CURRENT.md（切模式时必调）',
    },
    title: {
      type: 'string',
      description: '短标题；target=mode 时可写模式名如 foxi',
    },
    kind: {
      type: 'string',
      description:
        'routes 用 command|bot|human；pending 还可用 delegate|skill|capability；mode 时写 foxi|lcmm|normal 等',
    },
    summary: {
      type: 'string',
      description: '一句话用途 / 什么时候问 TA',
    },
    trigger: {
      type: 'string',
      description: '什么场景该想起这条（pending 常用）',
    },
    triggerStyle: {
      type: 'string',
      enum: ['keyword', 'mention', 'quote', 'keyword+quote'],
      description:
        'routes：keyword=免@关键词触发；mention=要@；quote=要先引用消息；keyword+quote=引用+关键词',
    },
    keywords: {
      type: 'string',
      description:
        '免@或引用场景的触发词/前缀，多个用逗号分隔；如 music / 撤回',
    },
    action: {
      type: 'string',
      description:
        '口令模板：免@写关键词模板如 music {歌名}；要@写 @某某…；引用类写「先引用{某类消息}再发…」',
    },
    delegateTo: {
      type: 'string',
      description:
        '目标人/机器人昵称或 @称呼；禁止小聪明儿/自己/李芈仙/主人；免@关键词触发也要填会响应的 bot 昵称',
    },
    evidence: {
      type: 'string',
      description:
        '历史依据：谁→谁，说了/回了啥；引用类写清引用了什么；禁止臆造。写 routes 必填',
    },
    roomId: {
      type: 'string',
      description: '真实 roomId@chatroom；多群通用写 all；实在没有才 unknown',
    },
    entryMarkdown: {
      type: 'string',
      description: '若提供则直接追加这段 markdown（优先于上面字段拼装；routes 时仍会校验禁目标）',
    },
  },
  required: ['target'],
} as const;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveWorkspaceRoot(): string {
  const fromEnv = process.env.OPENCLAW_WORKSPACE?.trim()
    || process.env.OPENCLAW_WORKSPACE_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim()
    || path.join(homedir(), '.openclaw');
  return path.join(stateDir, 'workspace');
}

function resolveTargetFile(target: LearnTarget): string {
  const root = resolveWorkspaceRoot();
  if (target === 'routes') {
    return path.join(root, 'skills', 'modes', 'foxi', 'ROUTES.md');
  }
  if (target === 'mode') {
    return path.join(root, 'skills', 'modes', 'CURRENT.md');
  }
  return path.join(root, 'skills', 'learn', 'PENDING.md');
}

function resolveLegacyRoutesFiles(): string[] {
  const root = resolveWorkspaceRoot();
  return [
    path.join(root, 'skills', 'foxi', 'ROUTES.md'),
    path.join(root, 'skills', 'lazy', 'ROUTES.md'),
  ];
}

function resolveDelegateTo(params: LearnWriteParams, action: string): string {
  const explicit = asString(params.delegateTo);
  if (explicit && !/见口令模板/u.test(explicit)) return explicit;
  const atMatch = action.match(/@([^\s@]{1,32})/u);
  if (atMatch?.[0]) return atMatch[0];
  return '';
}

function normalizeTriggerStyle(raw: unknown, action: string): string {
  const v = asString(raw).toLowerCase();
  if (v === 'keyword' || v === 'mention' || v === 'quote' || v === 'keyword+quote') {
    return v;
  }
  if (/先引用|引用.{0,8}再|\[引用消息\]/u.test(action)) {
    return /@/.test(action) ? 'keyword+quote' : 'quote';
  }
  if (/@/.test(action)) return 'mention';
  // 无 @ 的口令模板默认按免 @ 关键词记
  if (asString(action) && asString(action) !== '(未填)') return 'keyword';
  return 'mention';
}

function mentionsForbiddenDelegate(...parts: string[]): string | null {
  const blob = parts.filter(Boolean).join('\n');
  if (!blob) return null;
  for (const re of FORBIDDEN_DELEGATE_PATTERNS) {
    if (re.test(blob)) return re.source;
  }
  return null;
}

function resolveModeId(params: LearnWriteParams): string {
  const raw = (asString(params.kind) || asString(params.title) || 'normal').toLowerCase();
  if (raw === 'lazy') return 'foxi';
  if (MODE_IDS.has(raw)) return raw;
  // 允许「切佛系」这类中文落在 title/summary
  const text = `${asString(params.title)} ${asString(params.summary)} ${asString(params.kind)}`;
  if (/佛系|偷懒/u.test(text)) return 'foxi';
  if (/绿茶/u.test(text)) return 'lcmm';
  if (/阴阳/u.test(text)) return 'ysqq';
  if (/拱火/u.test(text)) return 'ghds';
  if (/国学|文言/u.test(text)) return 'gxwy';
  if (/正常|默认|恢复/u.test(text)) return 'normal';
  return 'normal';
}

function buildModeMarkdown(modeId: string): string {
  const skillHint = modeId === 'normal'
    ? '按 SOUL.md 默认人设；不再转交。'
    : `严格按 skills/modes/${modeId}/SKILL.md 执行，覆盖 SOUL 默认话风。`;
  return [
    '# 当前模式',
    '',
    `mode: ${modeId}`,
    '',
    `> ${skillHint}`,
    '> 每轮先读本文件；不是 normal 就以模式为主，直到 /normal。',
    '',
  ].join('\n');
}

function buildEntryMarkdown(params: LearnWriteParams, target: LearnTarget): string {
  const custom = asString(params.entryMarkdown);
  if (custom) return custom.replace(/\s+$/u, '') + '\n';

  const title = asString(params.title) || '未命名条目';
  const kind = asString(params.kind)
    || (target === 'routes' ? 'command' : 'skill');
  const room = asString(params.roomId) || 'unknown';
  const summary = asString(params.summary) || '(无摘要)';
  const trigger = asString(params.trigger) || '(未填)';
  const action = asString(params.action) || '(未填)';
  const triggerStyle = normalizeTriggerStyle(params.triggerStyle, action);
  const keywords = asString(params.keywords) || (triggerStyle === 'mention' ? '-' : '(未填)');
  const evidence = asString(params.evidence) || '(未填依据——不建议保留)';
  const delegateTo = resolveDelegateTo(params, action) || '(未填目标——请补昵称或@称呼)';

  if (target === 'routes') {
    return [
      `### ${title}`,
      `- 类型：${kind}`,
      `- 触发方式：${triggerStyle}`,
      `- 关键词：${keywords}`,
      `- 群：${room}`,
      `- 目标：${delegateTo}`,
      `- 口令模板：${action}`,
      `- 用途：${summary}`,
      `- 依据：${evidence}`,
      `- 状态：active`,
      '',
    ].join('\n');
  }

  return [
    `### ${title}`,
    `- 类型：${kind}`,
    `- 群：${room}`,
    `- 摘要：${summary}`,
    `- 触发：${trigger}`,
    `- 目标：${delegateTo}`,
    `- 动作草稿：${action}`,
    `- 依据：${evidence}`,
    `- 状态：${kind === 'skill' || kind === 'capability' ? 'awaiting_owner' : 'draft'}`,
    '',
  ].join('\n');
}

async function ensureLearnFile(filePath: string, target: LearnTarget): Promise<void> {
  await mkdir(path.dirname(filePath), {recursive: true});
  try {
    await access(filePath);
  } catch {
    if (target === 'routes') {
      for (const legacy of resolveLegacyRoutesFiles()) {
        try {
          const legacyText = await readFile(legacy, 'utf8');
          if (legacyText.trim() && !/已迁移/u.test(legacyText.slice(0, 80))) {
            await writeFile(filePath, legacyText, 'utf8');
            return;
          }
        } catch {
          // try next
        }
      }
    }
    const seed = target === 'routes'
      ? [
        '# 佛系转交路由',
        '',
        '> 仅佛系模式使用。禁止目标为小聪明儿/李芈仙。',
        '> 可记：免@关键词、要@、引用消息触发。',
        '',
        '## 路由列表',
        '',
      ].join('\n')
      : target === 'mode'
        ? buildModeMarkdown('normal')
        : [
          '# 学习草稿 / 待批 skill',
          '',
          '> skill/capability 需主人批准；转交/指令/可咨询人可自行写 ROUTES。',
          '',
          '## 列表',
          '',
        ].join('\n');
    await writeFile(filePath, `${seed}\n`, 'utf8');
  }
}

function insertEntry(existing: string, entry: string): string {
  const trimmedEntry = entry.trimEnd() + '\n';
  const markers = ['## 路由列表', '## 列表', '## 候选列表'];
  for (const marker of markers) {
    const idx = existing.indexOf(marker);
    if (idx >= 0) {
      const afterMarker = idx + marker.length;
      const before = existing.slice(0, afterMarker).replace(/\s*$/u, '');
      const after = existing.slice(afterMarker).replace(/^\s*/u, '');
      const cleanedAfter = after.replace(/^\(?暂无[^)\n]*\)?\s*\n*/u, '');
      return `${before}\n\n${trimmedEntry}\n${cleanedAfter}`.replace(/\n{3,}/g, '\n\n');
    }
  }
  return `${existing.replace(/\s*$/u, '')}\n\n${trimmedEntry}\n`;
}

export function registerXbotLearnWriteTool(api: OpenClawPluginApi): void {
  api.registerTool(() => {
    const tool: AnyAgentTool = {
      name: 'xbot_learn_write',
      label: 'Xbot Learn Write',
      description: [
        '写入 workspace：routes=转交路由；pending=草稿/待批 skill；mode=当前模式 CURRENT.md。',
        '切模式时必须 target=mode。',
        '材料可来自本轮上下文，或先 xbot_chat_history 查群日志再从结果学习。',
        '记 routes 时禁止目标为小聪明儿/自己/李芈仙。',
        '优先记：免@关键词触发；要@的口令；引用消息才触发的指令；@他人有回应；认真答疑。',
        'routes 请填 triggerStyle（keyword|mention|quote|keyword+quote）和 keywords。',
      ].join(''),
      parameters: XBOT_LEARN_WRITE_PARAMETERS as never,
      async execute(_toolCallId: string, rawParams: LearnWriteParams) {
        const targetRaw = asString(rawParams?.target).toLowerCase();
        if (targetRaw !== 'pending' && targetRaw !== 'routes' && targetRaw !== 'mode') {
          throw new Error('target 必须是 pending、routes 或 mode');
        }
        const target = targetRaw as LearnTarget;
        const filePath = resolveTargetFile(target);

        if (target === 'mode') {
          const modeId = resolveModeId(rawParams || {});
          const next = buildModeMarkdown(modeId);
          await mkdir(path.dirname(filePath), {recursive: true});
          await writeFile(filePath, next, 'utf8');
          return jsonResult({
            ok: true,
            target,
            mode: modeId,
            filePath,
            bytes: Buffer.byteLength(next, 'utf8'),
            preview: next.trim(),
          });
        }

        const evidence = asString(rawParams?.evidence);
        const entryMarkdown = asString(rawParams?.entryMarkdown);
        if (target === 'routes' && !evidence && !entryMarkdown) {
          throw new Error('写入 routes 必须提供 evidence（历史依据），禁止臆造');
        }

        const action = asString(rawParams?.action);
        const delegateTo = resolveDelegateTo(rawParams || {}, action);
        const entryTargetLine = (entryMarkdown.match(/^\s*-\s*目标：\s*(.+)$/mu)?.[1] || '').trim();
        const entryActionLine = (entryMarkdown.match(/^\s*-\s*口令模板：\s*(.+)$/mu)?.[1] || '').trim();
        const forbidden = mentionsForbiddenDelegate(
          delegateTo,
          action,
          entryTargetLine,
          entryActionLine,
        );
        if (target === 'routes' && forbidden) {
          throw new Error(
            `拒绝写入：转交目标不能是小聪明儿自己或李芈仙（命中 ${forbidden}）。请记其他人/其他机器人。`,
          );
        }

        await ensureLearnFile(filePath, target);
        const previous = await readFile(filePath, 'utf8');
        const entry = buildEntryMarkdown(rawParams || {}, target);
        const next = insertEntry(previous, entry);
        await writeFile(filePath, next, 'utf8');

        return jsonResult({
          ok: true,
          target,
          filePath,
          bytes: Buffer.byteLength(next, 'utf8'),
          preview: entry.trim(),
        });
      },
    };
    return tool;
  });
}
