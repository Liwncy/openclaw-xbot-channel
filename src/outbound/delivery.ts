import type { XchatbotReply } from './map-reply.ts';

/**
 * 出站投递阶段：对模型/工具诚实，禁止「失败也 ok:true」。
 *
 * - wechat-ok: 本批全部送达
 * - partial: 部分送达（如语音到了、旁白失败）——工具侧算失败，但会记 voiceSent
 * - deduped: 短时重复，无需再发（可当软成功）
 * - queued: 同步失败后已入 outbox，后台会重试（工具侧仍算未成功）
 * - failed: 全部失败或本地预处理失败
 * - unconfigured: 未配置 xchatbot outbound，可走受限直连
 */

export type XbotDeliveryStage =
  | 'wechat-ok'
  | 'partial'
  | 'deduped'
  | 'queued'
  | 'failed'
  | 'unconfigured';

export type XbotOutboundResult = {
  stage: XbotDeliveryStage;
  /** 工具/Agent 是否可视为成功：仅 wechat-ok / deduped */
  ok: boolean;
  messageId: string;
  sentCount: number;
  failedCount: number;
  errors: string[];
  voiceSent: boolean;
  mediaSent: boolean;
  detail?: string;
  /** 尚未送达、可供 outbox 重试的条目（有索引结果时才填） */
  unsentReplies?: XchatbotReply[];
};

export function isAgentSuccessStage(stage: XbotDeliveryStage): boolean {
  return stage === 'wechat-ok' || stage === 'deduped';
}

export function formatOutboundFailure(result: XbotOutboundResult): string {
  const errs = result.errors.filter(Boolean).slice(0, 3).join(' | ');
  const base = result.detail?.trim()
    || `xbot outbound ${result.stage} sent=${result.sentCount} failed=${result.failedCount}`;
  return errs ? `${base}: ${errs}` : base;
}

export function buildOutboundResult(args: {
  stage: XbotDeliveryStage;
  messageId?: string;
  sentCount?: number;
  failedCount?: number;
  errors?: string[];
  voiceSent?: boolean;
  mediaSent?: boolean;
  detail?: string;
  unsentReplies?: XchatbotReply[];
}): XbotOutboundResult {
  const stage = args.stage;
  return {
    stage,
    ok: isAgentSuccessStage(stage),
    messageId: args.messageId || '',
    sentCount: args.sentCount ?? 0,
    failedCount: args.failedCount ?? 0,
    errors: args.errors || [],
    voiceSent: args.voiceSent === true,
    mediaSent: args.mediaSent === true,
    detail: args.detail,
    ...(args.unsentReplies?.length ? { unsentReplies: args.unsentReplies } : {}),
  };
}
