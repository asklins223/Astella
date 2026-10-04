import { sql } from "drizzle-orm";
import {
  proposedLearningActionPayloadV1Schema,
  resolveCompanionMemoryTemporalMetadata,
} from "@ailearn/shared";
import type { ApiTransaction } from "../../db/client.ts";
import {
  confirmMemory,
  correctMemory,
  deleteMemory,
  getMemory,
  MemoryGlobalScopeRejectedError,
  MemoryRevisionConflictError,
  upsertMemory,
  type MemoryKindV2,
} from "./memory/memory-service.ts";
import { accountPreferenceRejectionMessage } from "@ailearn/shared/companion-memory-scope";
import { CompanionConversationError } from "./turn/turn-service.ts";

type ProposalPayload = { kind: string; [key: string]: unknown };
type MemoryProposal = {
  conversation_id: string;
  source_message_id: string | null;
};

/**
 * 账号级（跨空间）写入被拒 → 现役 companion 错误合同的 4xx（42 阶段 1 E）。
 *
 * 必须显式映射：提案确认链的错误一路冒到 `POST /proposals/:id/decision`，那条路由只认
 * `CompanionConversationError`，别的异常按 5xx 脱敏回一句"服务器内部错误"——用户点了
 * 确认，却不知道记忆到底改没改。
 *
 * 用 `INVALID_REQUEST` + 422 而不是 `ACTION_STALE`/409：提案与版本都是新鲜的，不合法的
 * 是"这份内容配上这个范围"。抛出即整笔事务回滚，提案不会被 `succeedSyncProposal` 结账。
 */
function accountScopeRejected(error: MemoryGlobalScopeRejectedError): CompanionConversationError {
  return new CompanionConversationError(
    "INVALID_REQUEST",
    422,
    accountPreferenceRejectionMessage(error.reason),
  );
}

export interface CompanionMemoryProposalOutcome {
  resultRef: string | null;
  safeSummary: string;
}

/** Execute one of the memory actions carried by a confirmed companion proposal. */
export async function executeCompanionMemoryProposalAction(input: {
  tx: ApiTransaction;
  workspaceId: string;
  userId: string;
  proposal: MemoryProposal;
  payload: ProposalPayload;
}): Promise<CompanionMemoryProposalOutcome | null> {
  const memoryActionKinds = new Set([
    "confirm_or_reject_memory",
    "delete_assistant_memory",
    "save_memory",
    "revise_memory",
  ]);
  if (!memoryActionKinds.has(input.payload.kind)) return null;

  const parsed = proposedLearningActionPayloadV1Schema.safeParse(input.payload);
  if (!parsed.success) {
    throw new CompanionConversationError("ACTION_STALE", 409, "memory payload is stale");
  }
  const scope = { workspaceId: input.workspaceId, userId: input.userId };

  if (parsed.data.kind === "confirm_or_reject_memory" || parsed.data.kind === "delete_assistant_memory") {
    const { memoryId, revision } = parsed.data;
    const memory = await getMemory(input.tx, scope, memoryId);
    if (!memory || new Date(memory.updatedAt).getTime() !== revision) {
      throw new CompanionConversationError("ACTION_STALE", 409, "memory revision changed");
    }
    if (parsed.data.kind === "confirm_or_reject_memory") {
      if (parsed.data.decision === "confirm") {
        const confirmed = await confirmMemory(input.tx, scope, memoryId);
        if (!confirmed) throw new CompanionConversationError("NOT_FOUND", 404, "memory not found");
        return { resultRef: memoryId, safeSummary: "记忆已确认" };
      }
      const rejected = await deleteMemory(input.tx, scope, memoryId);
      if (!rejected) throw new CompanionConversationError("NOT_FOUND", 404, "memory not found");
      return { resultRef: memoryId, safeSummary: "记忆已拒绝" };
    }
    const deleted = await deleteMemory(input.tx, scope, memoryId);
    if (!deleted) throw new CompanionConversationError("NOT_FOUND", 404, "memory not found");
    return { resultRef: memoryId, safeSummary: "记忆已删除" };
  }

  if (parsed.data.kind === "revise_memory") {
    const action = parsed.data;
    try {
      const revised = await correctMemory(input.tx, scope, action.memoryId, {
        content: action.content,
        expectedRevision: action.expectedRevision,
        ...(action.appliesWhen !== undefined ? { appliesWhen: action.appliesWhen } : {}),
        ...(action.validFrom !== undefined
          ? { validFrom: action.validFrom === null ? null : new Date(action.validFrom) }
          : {}),
        ...(action.validUntil !== undefined
          ? { validUntil: action.validUntil === null ? null : new Date(action.validUntil) }
          : {}),
      });
      if (!revised) throw new CompanionConversationError("NOT_FOUND", 404, "memory not found");
      return {
        resultRef: action.memoryId,
        safeSummary: `记忆已修订到第 ${revised.revision} 版`,
      };
    } catch (error) {
      if (error instanceof CompanionConversationError) throw error;
      if (error instanceof MemoryRevisionConflictError) {
        throw new CompanionConversationError("ACTION_STALE", 409, "memory revision changed");
      }
      if (error instanceof MemoryGlobalScopeRejectedError) throw accountScopeRejected(error);
      throw error;
    }
  }

  if (parsed.data.kind !== "save_memory") return null;
  const action = parsed.data;
  if (!input.proposal.source_message_id) {
    throw new CompanionConversationError("ACTION_STALE", 409, "memory metadata or source is stale");
  }
  const sourceRows = await input.tx.execute<{ source_text: string; created_at: Date | string }>(sql`
    SELECT coalesce((
             SELECT string_agg(b->>'text', '')
             FROM jsonb_array_elements(blocks) b
             WHERE b->>'type' = 'text'
           ), '') AS source_text,
           created_at
      FROM companion_messages
     WHERE id = ${input.proposal.source_message_id}::uuid
       AND conversation_id = ${input.proposal.conversation_id}::uuid
       AND workspace_id = ${input.workspaceId}
       AND user_id = ${input.userId}
       AND role = 'user'
     LIMIT 1
  `);
  const source = sourceRows[0];
  if (!source) {
    throw new CompanionConversationError("ACTION_STALE", 409, "memory source is no longer available");
  }
  const temporal = resolveCompanionMemoryTemporalMetadata({
    kind: action.memoryKind,
    content: action.content,
    sourceQuote: action.sourceQuote,
    appliesWhen: action.appliesWhen,
    validUntil: action.validUntil,
    sourceText: source.source_text,
  });
  if (!temporal.ok) {
    throw new CompanionConversationError("ACTION_STALE", 409, "memory temporal metadata is not grounded in the source");
  }
  // 这里的写入今天恒为 workspace，守卫按构造不会触发；仍要走同一条映射，
  // 是为了"任何一个写入口都不会把账号级拒绝变成 500"。
  let saved;
  try {
    saved = await upsertMemory(input.tx, scope, {
      kind: action.memoryKind as MemoryKindV2,
      content: action.content,
      sourceEventId: input.proposal.source_message_id,
      sourceSessionId: input.proposal.conversation_id,
      sourceSpeaker: "user",
      sourceBasis: "direct_statement",
      appliesWhen: temporal.appliesWhen,
      validFrom: new Date(source.created_at),
      validUntil: temporal.validUntil ? new Date(temporal.validUntil) : null,
      userStated: true,
      candidate: false,
      importance: 0.8,
      confidence: 0.9,
      scope: "workspace",
      sourceType: "user_stated",
    });
  } catch (error) {
    if (error instanceof MemoryGlobalScopeRejectedError) throw accountScopeRejected(error);
    throw error;
  }
  return { resultRef: saved.memoryItemId, safeSummary: "已保存记忆" };
}
