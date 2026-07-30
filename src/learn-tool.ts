import {access, mkdir, readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import type {AnyAgentTool, OpenClawPluginApi} from 'openclaw/plugin-sdk/core';
import {jsonResult} from 'openclaw/plugin-sdk/core';

type LearnTarget = 'pending' | 'routes';

type LearnWriteParams = {
  target?: LearnTarget;
  title?: string;
  kind?: string;
  summary?: string;
  trigger?: string;
  action?: string;
  evidence?: string;
  roomId?: string;
  entryMarkdown?: string;
};

const XBOT_LEARN_WRITE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: {
      type: 'string',
      enum: ['pending', 'routes'],
      description: 'pending=待批 skill/草稿；routes=偷懒转交路由（有依据时可自行写入）',
    },
    title: {
      type: 'string',
      description: '短标题，例如「某机器人发视频」',
    },
    kind: {
      type: 'string',
      description: 'delegate | skill | capability',
    },
    summary: {
      type: 'string',
      description: '一句话摘要',
    },
    trigger: {
      type: 'string',
      description: '什么场景该想起这条',
    },
    action: {
      type: 'string',
      description: '口令模板 / 接口要点 / skill 设想',
    },
    evidence: {
      type: 'string',
      description: '历史依据：谁→谁做了啥；禁止臆造',
    },
    roomId: {
      type: 'string',
      description: '群 roomId 或 all',
    },
    entryMarkdown: {
      type: 'string',
      description: '若提供则直接追加这段 markdown（优先于上面字段拼装）',
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
    return path.join(root, 'skills', 'lazy', 'ROUTES.md');
  }
  return path.join(root, 'skills', 'learn', 'PENDING.md');
}

function buildEntryMarkdown(params: LearnWriteParams, target: LearnTarget): string {
  const custom = asString(params.entryMarkdown);
  if (custom) return custom.replace(/\s+$/u, '') + '\n';

  const title = asString(params.title) || '未命名条目';
  const kind = asString(params.kind) || (target === 'routes' ? 'delegate' : 'skill');
  const room = asString(params.roomId) || 'unknown';
  const summary = asString(params.summary) || '(无摘要)';
  const trigger = asString(params.trigger) || '(未填)';
  const action = asString(params.action) || '(未填)';
  const evidence = asString(params.evidence) || '(未填依据——不建议保留)';

  if (target === 'routes') {
    return [
      `### ${title}`,
      `- 群：${room}`,
      `- 目标：${action.includes('@') ? action : '(见口令模板)'}`,
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
    `- 动作草稿：${action}`,
    `- 依据：${evidence}`,
    `- 状态：${kind === 'delegate' ? 'draft' : 'awaiting_owner'}`,
    '',
  ].join('\n');
}

async function ensureLearnFile(filePath: string, target: LearnTarget): Promise<void> {
  await mkdir(path.dirname(filePath), {recursive: true});
  try {
    await access(filePath);
  } catch {
    const seed = target === 'routes'
      ? [
        '# 偷懒转交路由',
        '',
        '> 仅偷懒模式使用。有历史依据才可写入。',
        '',
        '## 路由列表',
        '',
      ].join('\n')
      : [
        '# 学习草稿 / 待批 skill',
        '',
        '> skill/capability 需主人批准；转交可自行写 ROUTES。',
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
      // 去掉占位「（暂无…）」行
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
      description:
        '把从本次携带群聊历史里学到的内容写入 workspace：pending=待批 skill；routes=偷懒转交路由。学到可复用口令/能力时必须调用，不要只口头说记住了。',
      parameters: XBOT_LEARN_WRITE_PARAMETERS as never,
      async execute(_toolCallId: string, rawParams: LearnWriteParams) {
        const targetRaw = asString(rawParams?.target).toLowerCase();
        if (targetRaw !== 'pending' && targetRaw !== 'routes') {
          throw new Error('target 必须是 pending 或 routes');
        }
        const target = targetRaw as LearnTarget;
        const evidence = asString(rawParams?.evidence);
        const entryMarkdown = asString(rawParams?.entryMarkdown);
        if (target === 'routes' && !evidence && !entryMarkdown) {
          throw new Error('写入 routes 必须提供 evidence（历史依据），禁止臆造');
        }

        const filePath = resolveTargetFile(target);
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
