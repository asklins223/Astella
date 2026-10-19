import { finishCompanionParticipation, companionFollowupRepeatsParent } from "../tools/companion-participation-tools.ts";
import { readParticipationPreferences } from "@astella/agent-host";
import { companionInitiativeInputV1Schema } from "@astella/shared/companion-initiative-contracts";
import { listCompanionSelfNotes } from "@astella/agent-host";
import { COMPANION_AGENT_TOOL_LABELS, companionTurnWritesDocumentContent, renderCompanionSelfNotes } from "@astella/shared";
import { resolveCompanionPersonaContext } from "../memory/companion-identity-context.ts";
import { reserveCompanionProviderCall } from "../agent/companion-agent-events.ts";
import { renderPlaybookCandidates, renderPlaybookCatalog } from "../memory/companion-playbooks.ts";
import { renderCompanionDeliveryObservation } from "@astella/shared";
/**
 * companion_agent Worker handler（03 合同 §8.1/§9，runbook 6.4 步骤 5-7）。
 *
 * 2026-08-24（AI 设计审查 §4.4 拆分）：本文件自 1600+ 行巨型文件重构为编排层，
 * 职责拆分：
 * - content   → ./companion-dialogue-content.ts（输出校验/markdown 剥离/
 *               delta 分块/persona 组装/确定性 cue——纯函数层）；
 * - store     → ./companion-dialogue-store.ts（事件写入/run failed 投影/
 *               grounded-tutor DB 读取/记忆任务入队/feature flags）；
 * - delta 管线 → ./companion-dialogue-deltas.ts（批量 delta 写库、
 *               provider 采样参数、失败分类）。
 * 本文件只保留 run 编排：read → memory context → fence claim →
 * bounded Agent loop → TTS 段 → 终态事务。
 *
 * 流程：
 * 1. 读 job payload 的 opaque runId（不携带任何 message 正文——runbook 步骤 5）；
 * 2. RLS 事务内读 run/conversation/最近消息，并按 prompt 的字符预算求可见尾部（§9.3）；
 * 3. 非 active run（cancelled/superseded/failed）直接返回——§6.5「cancel 后
 *    Worker 迟到 delta/final 被拒绝」，不重复 provider 调用；
 * 4. text_generation provider 生成（§9.5 参数）；输出经长度/cue/泄露校验；
 * 5. 终态事务内：fence claim（run 仍 active 才可写）→ assistant message →
 *    assistant.status/assistant.delta/assistant.final events（§5.2 wire 语义，
 *    delta ≤2000 code unit）→ run succeeded（prompt_version/hash）→
 *    该 run 全部 event expires_at 原子改 finished_at+24h → NOTIFY。
 *
 * provider 失败：run failed + error event（recoverable 分类），job 重试时
 * run 已非 active → 快速返回，不重复花钱（首个 delta 前 crash 可安全重试）。
 */

import { decideCompanionVoiceDelivery, findFormalAnswerTarget } from "../../lib/formal-answer-signal.ts";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import { sql } from "drizzle-orm";
import { logger } from "../../lib/logger.ts";
import { companionSavedNoteEditExists } from "../note/companion-note-edit.ts";
import { listSucceededWriteToolNames } from "../tools/companion-tool-call-ledger.ts";
import { ProviderRequestError } from "../../lib/provider-request-error.ts";
import { withWorkerWorkspaceTransaction } from "../../db.ts";
import { loadHereAndNow, renderHereAndNow } from "../proactive/companion-here-and-now.ts";
import { loadThisTurnFacts } from "./companion-this-turn-facts.ts";
import { renderSummaryInjection, type SummaryInjectionInput } from "../context/companion-summary-injection.ts";
import {
  CompanionStreamStoppedError,
  createCompanionStreamDelivery,
  readCompanionDeliveredPrefix,
  projectCompanionVisible,
  reconcileStreamedText,
} from "./companion-dialogue-stream.ts";
import { companionStreamFallbackText } from "../agent/companion-delivery-gates.ts";
import { createCompanionThinkingDelivery } from "./companion-thinking-stream.ts";
import { resolveRunPersonaPin } from "../memory/companion-run-persona-pin.ts";
import {
  AIConsentRequiredError,
  AIDataPolicyDeniedError,
  resolveAIGovernanceContext,
  resolveVisionReader,
} from "../../lib/governance.ts";
import { createCompanionContextReceipts } from "../context/companion-context-receipts.ts";
import { createCompanionReleaseEmbeddingPort, createCompanionReleaseRouterPort,
  resolveCompanionReleaseRouterMode } from "../agent/companion-release-router.ts";
import {
  createCompactionTraceRecorder,
  resolveRouteInputTokens,
  selectCompanionInteractiveReplayWindow,
} from "../context/companion-context-handoff.ts";
import { resolveCompanionTurnProviders } from "./companion-turn-providers.ts";
import { createCompactionCooldownPorts } from "../context/companion-compaction-cooldown.ts";
import { foldReplayUnderSummaryCoverage, replayToMessages, type SummaryCoverageBound } from "../context/companion-compaction.ts";
import type { ChatMessage } from "@astella/shared";
import { PET_PERSONA_PRESET_VERSION } from "@astella/shared/pet-persona-presets";
import { runCompanionAgentLoop } from "../agent/companion-agent-runtime.ts";
import { AgentOutputError, CompanionAgentBudgetExceededError, CompanionContextChangedError } from "../../lib/non-retryable-errors.ts";
import { AIContextOverflowError } from "../../lib/context-governor.ts";
import { AgentContextError } from "@astella/agent-core";
import { assertCompanionContextSourcesCurrent } from "../context/companion-context-sources.ts";
import { lockJobLease } from "../../lib/job-lease.ts";
import { lockCompanionRunForEventWrite } from "@astella/shared/companion-lock-order";
import type { AgentMemoryContextSourceV1, AgentVoiceStyleDecisionV1 } from "@astella/shared/agent-contracts";
import {
  companionSegmentId,
  splitCommittedDisplaySegments,
  type CompanionDisplaySegmentState,
} from "../../lib/tts-segments.ts";
import { resolveCompanionVoiceInstruction } from "./companion-voice-request-style.ts";
import { resolveCompanionEntryMode } from "./companion-entry-mode.ts";
import { persistCompanionDialectPreference, readCompanionDialectPreference } from "./companion-voice-preference.ts";
import { qwenDialectForInstruction } from "@astella/shared/tts-voice-catalog";
import { companionVoiceExpressionBoundaries, companionVoiceSegmentExpression, projectCompanionVoiceExpression } from "./companion-voice-expression.ts";
import {
  assembleCompanionContext,
  recordCompanionMemoryContextExposure,
  type ContextAssemblyResult,
} from "../context/companion-context-orchestrator.ts";
import {
  THINKING_CUE_PAYLOAD_V1,
  buildCompanionPersonaMessages,
  validateCompanionOutput,
  textOfCompanionBlocks,
  parsePageContext,
  boundCompanionRecentHistory,
  buildCompanionContextHandoffSnapshotV1,
  finalizeCompanionReplyText,
  renderCompanionContextHandoff,
  renderUserAttachedImagesLine,
} from "./companion-dialogue-content.ts";
import {
  type CompanionDialogueHandlerContext,
  type ReadContext,
  insertStreamEvent,
  emitCompanionTtsSegments,
  recordCompanionRunFailureSpanBestEffort,
  markCompanionRunFailed,
  readGroundedTutorContext,
  isActiveRun,
  isCompanionDialogueEnabled,
  isCompanionVoiceDialogueEnabled,
  isCompanionMemoryContextEnabled,
  readConversationSummaryChain,
  readCompanionActionLedger,
  readCompanionReplayHistoryRows,
  countCompanionHistoryMessages,
  companionRecentHistoryFromRows,
  persistCompanionContextHandoffSnapshot,
} from "./companion-dialogue-store.ts";
import {
  writeBatchedDeltas,
} from "./companion-dialogue-deltas.ts";
import {
  persistFailedPartial,
} from "./companion-dialogue-failure-retention.ts";
import { finalizeCompanionDialogueTurn } from "./companion-dialogue-finalization.ts";

/** LearningRun 是正式学习页，缺证据时必须 fail closed。 */
export function isGroundedTutorRequestedPageContext(
  pageContext: Record<string, unknown> | null,
): boolean {
  return pageContext?.pageKind === "learning_run"
    && pageContext.requestedCapability === "grounded_tutor";
}

// ─── run 编排 ─────────────────────────────────────────────────────────────

export async function runCompanionDialogue(
  ctx: CompanionDialogueHandlerContext,
): Promise<void> {
  // job 超时（runWithAbortTimeout）在进入 handler 前就已开始计时；Agent loop 用
  // 这个起点把 run 预算夹在 handler abort 之内（见 runCompanionAgentLoop）。
  const handlerStartedAtMs = Date.now();
  const payload = ctx.payload as { runId?: string; proposalId?: string };
  const runId = payload.runId;
  const continuationProposalId = typeof payload.proposalId === "string" ? payload.proposalId : undefined;
  if (!runId) throw new Error("companion_agent payload 缺 runId");
  if (ctx.signal.aborted) throw new Error("companion_agent aborted");

  // 折叠所需的两个事实：回放尾部每条消息的来源 seq，以及当前摘要覆盖到哪一段
  // （44 §5.2）。它们只在读事务里成立，因此提到外面给压缩用。
  let replayTailSeqs: Array<string | null> = [];
  let replaySummaryCoverage: SummaryCoverageBound | null = null;

  // ── 阶段 1：读（RLS 事务） ────────────────────────────────────────────
  let read: ReadContext | null = null;
  try {
    read = await withWorkerWorkspaceTransaction(
      { workspaceId: ctx.workspaceId, userId: ctx.requestedBy },
      async (tx) => {
        const runRows = await tx.execute<{
          id: string; conversation_id: string; user_id: string; generation: number;
          status: string; page_context: unknown; user_message_id: string | null; input_source: unknown;
          account_epoch: string | number | null;
          persona_profile_revision: number | null;
          persona_examples_revision: number | null;
          default_expression_version: string | null;
          context_grant_id: string | null; permission_level: string | null;
          permission_snapshot: unknown; cancel_requested_at: string | null;
          delivery_observation: unknown;
        }>(sql`
          SELECT id, conversation_id, user_id, generation, status, page_context, user_message_id, input_source,
                 account_epoch, context_grant_id, permission_level, permission_snapshot,
                 persona_profile_revision, persona_examples_revision, default_expression_version,
                 delivery_observation,
                 cancel_requested_at::text AS cancel_requested_at
          FROM companion_turn_runs WHERE id = ${runId}
        `);
        const run = runRows[0];
        if (!run) return null; // RLS 已 scope；run 不存在/属其他 workspace → 无副作用
        const convRows = await tx.execute<{
          next_message_seq: string; next_event_seq: string;
        }>(sql`
          SELECT next_message_seq, next_event_seq
          FROM companion_conversations WHERE id = ${run.conversation_id}
        `);
        const conv = convRows[0];
        if (!conv) return null;
        // 正式作答中就不念出来（doc 34 L15 的另一半）。判据与主动交流入口共用同一来源，
        // 在**这一轮**读一次就够：一次 provider 调用远长于六个阶段的跃迁窗口，
        // 中途放开等于在用户正在答的那一题上开口。
        // 同一次读取顺手把**正在作答的那一题的身份**也带出来（39d W2-6 要往
        // `learning_exposures_v2` 记一笔，必须拿到这一题冻结的那一版）。静音判据与
        // 记账判据因此是同一条 SQL，不会一处放宽一处收紧。
        const formalAnswerTarget = await findFormalAnswerTarget(tx, {
          workspaceId: ctx.workspaceId,
          userId: run.user_id,
        });
        const formalAnswerInProgress = formalAnswerTarget !== null;
        const userRows = await tx.execute<{ blocks: unknown; seq: string; created_at: string }>(sql`
          SELECT blocks, seq::text AS seq,
                 to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
          FROM companion_messages
          WHERE conversation_id = ${run.conversation_id}
            AND id = ${run.user_message_id}
          ORDER BY seq DESC LIMIT 1
        `);
        const userText = userRows[0] ? textOfCompanionBlocks(userRows[0].blocks) : "";
        // 这一轮用户附的图（2026-10-06 输入框传图）：assetId 由 API 在创建 turn 时
        // 按上传回执解析并写回块里；这里的读取与 companion_read_image 共用同一个 id。
        // 至多两张：消息契约允许一张，多出来的（历史遗留）不阻断对话。
        const userImageAttachments = (Array.isArray(userRows[0]?.blocks)
          ? (userRows[0]!.blocks as Array<Record<string, unknown>>)
          : [])
          .filter((block) => block.type === "image" && typeof block.assetId === "string")
          .slice(0, 2)
          .map((block) => ({
            assetId: String(block.assetId),
            label: typeof block.label === "string" && block.label.trim().length > 0
              ? block.label.trim().slice(0, 80)
              : "用户发来的图片",
          }));
        const currentUserSeq = userRows[0]?.seq ?? conv.next_message_seq;
        // 排除非对话与未完成的助手输出，保留用户连发的补充以及发送时间、回合状态；摘要水位
        // 必须从这份相同的可见尾部计算，不能让 system 注记占掉最近消息名额。
        const summaryChain = await readConversationSummaryChain(tx, run.conversation_id);
        const historyRows = await readCompanionReplayHistoryRows(tx, run.conversation_id, {
          beforeSeq: currentUserSeq,
          coverage: summaryChain.head ? {
            fromSeq: summaryChain.effectiveCoverageFromSeq,
            throughSeq: summaryChain.effectiveCoverageThroughSeq,
            sourceSha256: summaryChain.head.coverage_source_hash,
            uncovered: summaryChain.gaps,
          } : null,
        });
        const recentWithSeq = companionRecentHistoryFromRows(historyRows);
        const visibleRecent = boundCompanionRecentHistory(recentWithSeq);
        replayTailSeqs = visibleRecent.map((message) => message.seq ?? null);
        const recentMessages = visibleRecent;
        const historyStartSeq = visibleRecent[0]?.seq ?? currentUserSeq;
        const totalHistoryMessages = await countCompanionHistoryMessages(tx, run.conversation_id, currentUserSeq);
        const clippedMessageCount = Number(
          totalHistoryMessages > BigInt(visibleRecent.length)
            ? totalHistoryMessages - BigInt(visibleRecent.length)
            : 0n,
        );
        // §3.5：记忆检索由 Context Orchestrator 统一负责（向量/keyword fallback）。
        // read 阶段不再直接"取最近 30 条记忆"——当记忆上下文功能关闭时回退空记忆，
        // 开启时由后续 assembleCompanionContext 阶段检索填充。
        const residentMemories: { kind: string; content: string }[] = [];
        // ── 人格固定（40 §4.8.4「一次调用使用固定版本」/ 40b §5.3.2）──
        //
        // 账号人格现在有「当前 / 待生效」两版（companion_persona_profiles.pending_revision，
        // 0355 引入）。两条硬规则：
        //   1. 同一个 run 的每一轮都用它自己那个号，正文从**不可变版本行**读；
        //   2. 排队的（待生效）那一版对本次 run 不生效——它存在的意义是让用户看得见
        //      还没生效的那一版，而这里的判断发生在 run 建立**之后**。
        // 决策本身在纯函数 resolveRunPersonaPin 里（含"不得绑定待生效"的断言），
        // 这里只负责把两条 SQL 读出来交给它。
        // 一次读齐三列：当前号、当前正文、待生效那一号。第三列只交给断言——
        // 它不参与本次绑定，但必须被读到，否则"已固定的那一版恰好是排队那一版"
        // 这种状态没有任何地方会发现。
        const currentPersonaRows = await tx.execute<{
          revision: number;
          profile: unknown;
          pending_revision: number | null;
        }>(sql`
          SELECT revision, profile, pending_revision
          FROM companion_persona_profiles
          WHERE user_id = ${run.user_id}
          LIMIT 1
        `);
        const currentPersona = currentPersonaRows[0];
        let pinnedContent: unknown = null;
        if (run.persona_profile_revision !== null && run.persona_profile_revision > 0) {
          const versionRows = await tx.execute<{ profile: unknown }>(sql`
            SELECT profile
            FROM companion_persona_profile_versions
            WHERE user_id = ${run.user_id} AND revision = ${run.persona_profile_revision}
            LIMIT 1
          `);
          if (!versionRows[0]) throw new Error("pinned account persona version is unavailable");
          pinnedContent = versionRows[0].profile;
        }
        const personaPin = resolveRunPersonaPin({
          pinnedRevision: run.persona_profile_revision,
          pinnedExamplesRevision: run.persona_examples_revision,
          pinnedDefaultExpressionVersion: run.default_expression_version,
          currentRevision: currentPersona?.revision ?? null,
          currentContent: currentPersona?.profile ?? null,
          stagedRevision: currentPersona?.pending_revision ?? null,
          pinnedContent,
          currentDefaultExpressionVersion: String(PET_PERSONA_PRESET_VERSION),
        });
        const personaProfileRevision = personaPin.revision;
        const personaExamplesRevision = personaPin.examplesRevision;
        const defaultExpressionVersion = personaPin.defaultExpressionVersion;
        const personaProfileContent = personaPin.content;
        if (personaPin.fresh) {
          const frozen = await tx.execute<{ id: string }>(sql`
            UPDATE companion_turn_runs
            SET persona_profile_revision = ${personaProfileRevision},
                persona_examples_revision = ${personaExamplesRevision},
                default_expression_version = ${defaultExpressionVersion},
                updated_at = now()
            WHERE id = ${run.id}
              AND workspace_id = ${ctx.workspaceId}
              AND user_id = ${run.user_id}
              AND persona_profile_revision IS NULL
            RETURNING id
          `);
          if (!frozen[0]) throw new Error("could not pin account persona revision to companion run");
        }
        const petProfileRow = typeof personaProfileContent === "object"
          && personaProfileContent !== null
          && !Array.isArray(personaProfileContent)
          ? personaProfileContent as Record<string, unknown>
          : null;
        // 账号没写过人格档案（revision 0）时，**生效的人格是系统默认人格**，不是"没有人格"。
        // 此前这里给 null，于是她的性格来自通用角色底座——"没选人格也能正常聊天"，
        // 而选不选人格对第一句话毫无影响（用户 2026-10-05 的决定）。
        // 注意这不动版本记账：persona_profile_revision 仍然是 0，档案行仍然是空的。
        const petProfile = resolveCompanionPersonaContext(petProfileRow);
        const groundedTutorContext = await readGroundedTutorContext(
          tx,
          run.page_context,
          { workspaceId: ctx.workspaceId, userId: run.user_id },
        );
        // 环境快照跑在**同一个** RLS 读事务里：它是一组常量级聚合 SQL，另开事务
        // 只会多一次往返，而且脱离这里的作用域边界（方案 29 §4.1）。
        const snapshot = await loadHereAndNow(tx, {
          workspaceId: ctx.workspaceId,
          userId: run.user_id,
          conversationId: run.conversation_id,
          currentRequestSeq: currentUserSeq,
          pageContext: run.page_context,
          userText,
        });
        const hereAndNow = [
          renderHereAndNow(snapshot),
          renderUserAttachedImagesLine(userImageAttachments),
        ].filter((line): line is string => Boolean(line)).join("\n") || null;
        // 实体先行解析（39d W2-3）：这句话指到的对象先查出来。同一事务、不新开连接；
        // 没有指称时它一次查询都不发（`extractTurnReferences` 返回空就直接 null）。
        const thisTurnFacts = await loadThisTurnFacts(tx, {
          workspaceId: ctx.workspaceId,
          userId: run.user_id,
          conversationId: run.conversation_id,
          userText,
          liveView: snapshot.livePageView,
        });
        if (thisTurnFacts?.dropped) {
          // 超预算丢弃是设计内的降级（39b §9.3），但**要留一条读数**：静默丢掉会让人
          // 以为这块一直没触发，而它其实是每次都超时。
          logger.warn({ runId: run.id, ms: thisTurnFacts.ms }, "companion turn facts dropped over budget");
        }
        // 更早那段对话（历史回放只带真正进入 prompt 的尾部）。读**接续链**而不是只读
        // 最新一份（44 §5.2）：压缩分次发生，只取最新一份会把更早的覆盖索引丢掉——
        // 会话看起来「有摘要」，实际中间那段没人读过。不猜旧摘要边界，也不为它单开往返。
        //
        // 链头**不要求早于可见尾部**（44 §5.2「摘要与回放从同一实际保留边界派生」）：
        // 覆盖伸进回放窗口时，那段由摘要代表、可以折；没伸进来时折不动，也不该硬折。
        // 覆盖起点取**链的**有效起点而不是链头自己那一段的——链头只盖了最近一块，
        // 拿它当「摘要盖到多早」会让回执把更早的覆盖误报成「没人代表」。
        const summaryRow = summaryChain.head;
        replaySummaryCoverage = summaryRow
          ? {
            fromSeq: summaryChain.effectiveCoverageFromSeq ?? summaryRow.coverage_from_seq,
            throughSeq: summaryRow.coverage_through_seq,
            sourceSha256: summaryRow.coverage_source_hash,
            uncovered: summaryChain.gaps,
          }
          : null;
        const summaryCoverageVerified = Boolean(
          summaryRow?.coverage_from_seq
          && summaryRow.coverage_through_seq
          && summaryRow.coverage_source_hash,
        );
        const summaryInjection: SummaryInjectionInput = {
          source: summaryRow?.summary ?? null,
          coverageVerified: summaryCoverageVerified,
          chainGaps: summaryChain.gaps,
          throughSeq: summaryChain.effectiveCoverageThroughSeq
            ?? summaryRow?.coverage_through_seq ?? null,
        };
        // 动作账本按摘要覆盖线收边（判据与 omitted 计数都在 store 那一条读里）。
        const actionLedgerRead = await readCompanionActionLedger(tx, {
          conversationId: run.conversation_id,
          runId: run.id,
          coverageThroughSeq: replaySummaryCoverage?.throughSeq ?? null,
          coverageFromSeq: replaySummaryCoverage?.fromSeq ?? null,
          coverageGaps: summaryChain.gaps,
        });
        const proposalRows = await tx.execute<{
          id: string; status: string; decision: string | null; title: string;
          target_summary: string; result_safe_summary: string | null; expires_at: string | null;
        }>(sql`
          SELECT id::text AS id, status, decision, title, target_summary,
                 result_safe_summary, expires_at::text AS expires_at
          FROM companion_action_proposals
          WHERE conversation_id = ${run.conversation_id}
          ORDER BY CASE WHEN status IN ('pending', 'executing') THEN 0 ELSE 1 END,
                   updated_at DESC, id DESC
        `);
        return {
          runId: run.id,
          formalAnswerInProgress,
          formalAnswerTarget,
          livePageView: snapshot.livePageView,
          conversationId: run.conversation_id,
          userId: run.user_id,
          userMessageId: run.user_message_id,
          initiativeInput: run.input_source ? companionInitiativeInputV1Schema.parse(run.input_source) : null,
          generation: run.generation,
          runStatus: run.status,
          accountEpoch: Number(run.account_epoch ?? 0),
          pageContext: run.page_context,
          deliveryObservation: run.delivery_observation,
          contextHandoff: {
            runId: run.id,
            conversationId: run.conversation_id,
            throughMessageSeq: currentUserSeq,
            throughEventSeq: (BigInt(conv.next_event_seq) - 1n).toString(),
            historyStartSeq,
            clippedMessageCount,
            currentRequest: {
              source: run.input_source ? "host_observation" : "user",
              messageId: run.user_message_id,
              messageSeq: currentUserSeq,
              text: userText,
            },
            contextGrantId: run.context_grant_id,
            permissionLevel: run.permission_level,
            permissionSnapshot: run.permission_snapshot,
            runStatus: run.status,
            cancelRequestedAt: run.cancel_requested_at,
            pageContext: run.page_context,
            summaryCoverage: summaryRow
              ? {
                  fromSeq: summaryRow.coverage_from_seq,
                  throughSeq: summaryRow.coverage_through_seq,
                  sourceSha256: summaryRow.coverage_source_hash,
                }
              : null,
            historyTail: visibleRecent.flatMap((message) => message.seq
              ? [{ seq: message.seq, role: message.role, text: message.text }]
              : []),
          },
          actionLedger: actionLedgerRead.entries,
          proposals: proposalRows.map((proposal) => ({
            id: proposal.id,
            status: proposal.status,
            decision: proposal.decision,
            title: proposal.title,
            targetSummary: proposal.target_summary,
            resultSafeSummary: proposal.result_safe_summary,
            expiresAt: proposal.expires_at,
          })),
          groundedTutorContext,
          userText,
          recentMessages,
          conversationClock: snapshot.observedAt && snapshot.timezone ? {
            observedAt: snapshot.observedAt, timezone: snapshot.timezone,
            currentMessageCreatedAt: userRows[0]?.created_at ?? null,
          } : undefined,
          residentMemories,
          memoryDirectory: [],
          // 手册目录与整理结论在 assembleCompanionContext 阶段填；
          // 在此之前它们是"没有"，不是"有但为空"。
          playbookCatalog: [],
          playbookCandidates: [],
          organizationSurface: null,
          memoryRefs: [],
          actionLedgerOmitted: actionLedgerRead.omitted,
          hereAndNow,
          thisTurnFacts: thisTurnFacts?.block ?? null,
          factSpans: snapshot.factSpans,
          conversationSummary: null,
          summaryInjection,

          personaProfileRevision,
          personaExamplesRevision,
          defaultExpressionVersion,
          petProfile,
          nextMessageSeq: Number(conv.next_message_seq),
          nextEventSeq: Number(conv.next_event_seq),
        };
      },
    );
  } catch (err) {
    logger.warn({ jobId: ctx.id, runId, err }, "companion_agent read phase failed");
    throw err;
  }
  if (!read) return; // run 已删/非本 workspace——job 成功无副作用

  const parsedPageContext = parsePageContext(read.pageContext);
  if (isGroundedTutorRequestedPageContext(parsedPageContext) && !read.groundedTutorContext) {
    await markCompanionRunFailed(read, ctx, "ACTION_STALE", false, "grounded tutor evidence unavailable", "state");
    throw new Error("grounded tutor evidence unavailable");
  }

  // ── 阶段 2：provider（非 active run → 不重复调用） ───────────────────
  if (!isActiveRun(read.runStatus) && !(continuationProposalId && read.runStatus === "waiting_for_confirmation")) {
    logger.info({ runId, status: read.runStatus }, "companion run 非 active，跳过 provider");
    return;
  }
  if (!isCompanionDialogueEnabled()) {
    await markCompanionRunFailed(read, ctx, "INTERNAL_ERROR", false, "feature disabled", "execution");
    throw new Error("COMPANION_DIALOGUE_V1_ENABLED is false — companion dialogue disabled");
  }

  const govCtx = await resolveAIGovernanceContext(ctx.workspaceId, read.userId);
  if (!govCtx.consentOk) {
    await markCompanionRunFailed(
      read,
      ctx,
      "AI_CONSENT_REQUIRED",
      false,
      "workspace AI consent required",
      "state",
    );
    throw new AIConsentRequiredError();
  }
  if (govCtx.providerName !== "mock" && !govCtx.policy.sendToExternal) {
    const reason = "请在 AI 数据同意页开启「允许发送到外部模型服务」后继续。";
    await markCompanionRunFailed(read, ctx, "AI_DATA_POLICY_DENIED", false, reason, "state");
    throw new AIDataPolicyDeniedError(reason);
  }
  const contextReceipts = createCompanionContextReceipts();
  // 折叠轨迹收集器：loop 里折了就记，回合结束时并进交接快照的下一版（44 §3.3）。
  const compactionTrace = createCompactionTraceRecorder();
  // 两个 provider 槽（主链路 / 跨模型兜底）各自的理由见 companion-turn-providers。
  const { provider, fallbackProvider } = resolveCompanionTurnProviders({
    governance: govCtx,
    ctx,
    read,
    contextGate: contextReceipts.pressureGate,
    reserveCall: () => reserveCompanionProviderCall({ ctx, read }),
  });

  // Replace only complete older exchanges represented by a verified summary.
  // Uncovered history is kept whole, even above the pressure target; the full
  // request governor owns compaction and provider capacity checks.
  const availableSummary = read.summaryInjection
    ? renderSummaryInjection(read.summaryInjection) : read.conversationSummary;
  let replayWindow = selectCompanionInteractiveReplayWindow(
    read.recentMessages,
    resolveRouteInputTokens(provider.getCapabilities?.() ?? null, provider.resolveOutputTokenLimit?.()),
    availableSummary && !read.groundedTutorContext ? replaySummaryCoverage : null,
  );
  // 摘要注入块要在窗口裁完、`read.recentMessages` 还没被换掉时定稿（判据见 `companion-summary-injection.ts`）。
  if (read.summaryInjection) read.conversationSummary = renderSummaryInjection(
    read.summaryInjection, replayWindow.messages[0]?.seq ?? null, read.recentMessages);
  if (!read.conversationSummary && replayWindow.receipt.omittedCount > 0) {
    replayWindow = selectCompanionInteractiveReplayWindow(read.recentMessages,
      resolveRouteInputTokens(provider.getCapabilities?.() ?? null, provider.resolveOutputTokenLimit?.()));
  }
  if (!read.conversationSummary || read.groundedTutorContext) replaySummaryCoverage = null;
  read.recentMessages = replayWindow.messages;
  replayTailSeqs = replayWindow.messages.map((message) => message.seq ?? null);
  if (read.contextHandoff) {
    read.contextHandoff = {
      ...read.contextHandoff,
      historyStartSeq: replayWindow.messages[0]?.seq ?? read.contextHandoff.currentRequest.messageSeq,
      clippedMessageCount: read.contextHandoff.clippedMessageCount + replayWindow.receipt.omittedCount,
      historyTail: replayWindow.messages.flatMap((message) => message.seq
        ? [{ seq: message.seq, role: message.role, text: message.text }]
        : []),
      replayWindow: replayWindow.receipt,
    };
  }
  logger.info({
    runId: read.runId,
    modelId: provider.modelId,
    capacityTokens: replayWindow.receipt.capacityTokens,
    usedTokens: replayWindow.receipt.usedTokens,
    takenCount: replayWindow.receipt.takenCount,
    omittedCount: replayWindow.receipt.omittedCount,
  }, "companion interactive replay window selected");

  // 40 §4.6.6：resident 正文常驻，active 只注入有预算的目录（非 grounded_tutor）。
  const emptyMemoryContext = (): ContextAssemblyResult => ({
    residentMemories: read.residentMemories,
    memoryDirectory: read.memoryDirectory,
    playbookCatalog: [],
    playbookCandidates: [],
    organizationSurface: null,
    memoryRefs: read.memoryRefs,
    retrievalMode: "disabled",
    usedMemoryIds: [],
    residentMemoryIds: [],
    residentTokenEstimate: 0,
    residentByteCount: 0,
    directoryTokenEstimate: 0,
  });
  let memoryContext: ContextAssemblyResult = emptyMemoryContext();
  if (isCompanionMemoryContextEnabled() && !read.groundedTutorContext) {
    try {
      memoryContext = await withWorkerWorkspaceTransaction(
        { workspaceId: ctx.workspaceId, userId: read.userId },
        (tx) => assembleCompanionContext(
          tx,
          { workspaceId: ctx.workspaceId, userId: read.userId },
          {
            runId: read.runId,
            groundedTutorContext: read.groundedTutorContext,
            // 按页面类型推导 task 可见范围；无当前任务身份时不暴露 task 记忆。
            pageContext: read.pageContext,
          },
        ),
      );
      read.residentMemories = memoryContext.residentMemories;
      read.memoryDirectory = memoryContext.memoryDirectory;
      read.memoryRefs = memoryContext.memoryRefs;
      read.playbookCatalog = memoryContext.playbookCatalog;
      read.playbookCandidates = memoryContext.playbookCandidates;
      read.organizationSurface = memoryContext.organizationSurface;
    } catch (err) {
      // 目录读取失败不阻塞对话：本轮暂不注入长期记忆。
      logger.warn({ jobId: ctx.id, runId: read.runId, err }, "companion memory context assembly skipped");
      memoryContext = emptyMemoryContext();
    }
  }
  contextReceipts.recordMemoryOmissions({
    residentCount: memoryContext.residentOmittedCount ?? 0,
    directoryCount: memoryContext.directoryOmittedCount ?? 0,
    residentCharacters: memoryContext.residentOmittedCharacters ?? 0,
    directoryCharacters: memoryContext.directoryOmittedCharacters ?? 0,
    capacityEstimate: memoryContext.memoryCapacityTokens ?? 0,
  });

  const handoffInput = {
    ...(read.contextHandoff ?? {
      runId: read.runId,
      conversationId: read.conversationId,
      throughMessageSeq: "0",
      throughEventSeq: "0",
      historyStartSeq: "0",
      clippedMessageCount: 0,
      currentRequest: { messageId: read.userMessageId, messageSeq: "0", text: read.userText,
        source: read.initiativeInput ? "host_observation" : "user" },
      contextGrantId: null,
      permissionLevel: null,
      permissionSnapshot: null,
      runStatus: read.runStatus,
      cancelRequestedAt: null,
      pageContext: read.pageContext,
      summaryCoverage: null,
      historyTail: [],
    }),
    actionLedger: read.actionLedger ?? [],
    actionLedgerOmitted: read.actionLedgerOmitted ?? null,
    proposals: read.proposals ?? [],
    memoryRefs: memoryContext.memoryRefs,
    memoryDirectory: memoryContext.memoryDirectory,
    memorySourceVersions: [] as AgentMemoryContextSourceV1[],
  };
  const handoffDraft = buildCompanionContextHandoffSnapshotV1({
    ...handoffInput,
    modelMessages: [],
  });
  const selfNotes = read.groundedTutorContext ? [] : await withWorkerWorkspaceTransaction(
    { workspaceId: ctx.workspaceId, userId: read.userId }, tx => listCompanionSelfNotes(tx,
      { workspaceId: ctx.workspaceId, userId: read.userId }));
  // 上一轮说过「以后都用河南话」之后，账号里那一行就是这一轮的声音身份；正文也要
  // 跟着它，否则她开口是方言、写出来还是普通话。
  const accountVoiceDialect = await readCompanionDialectPreference({
    workspaceId: ctx.workspaceId, userId: read.userId,
  });
  let messages: ReturnType<typeof buildCompanionPersonaMessages>;
  try {
    messages = buildCompanionPersonaMessages({
      scope: { workspaceId: ctx.workspaceId, userId: read.userId },
      selfNotes: renderCompanionSelfNotes(selfNotes),
      methodCatalog: read.groundedTutorContext ? "" : renderPlaybookCatalog(read.playbookCatalog),
      methodCandidates: read.groundedTutorContext ? "" : renderPlaybookCandidates(read.playbookCandidates),
      deliveryObservation: renderCompanionDeliveryObservation(read.deliveryObservation),
      contextReceipt: receipts => {
        contextReceipts.recordAssembly(receipts);
        logger.info({ runId: read.runId, sources: receipts }, "agent context budget receipt");
      },
      userText: read.userText,
      initiativeInput: read.initiativeInput,
      participationPreferences: await withWorkerWorkspaceTransaction({ workspaceId: ctx.workspaceId, userId: read.userId },
        tx => readParticipationPreferences(tx, { workspaceId: ctx.workspaceId, userId: read.userId })),
      recentMessages: read.recentMessages,
      conversationClock: read.conversationClock,
      pageContext: read.pageContext,
      groundedTutorContext: read.groundedTutorContext,
      residentMemories: read.residentMemories,
      memoryDirectory: read.memoryDirectory,
      memoryOmissions: {
        residentCount: memoryContext.residentOmittedCount ?? 0,
        directoryCount: memoryContext.directoryOmittedCount ?? 0,
      },
      hereAndNow: read.hereAndNow,
      thisTurnFacts: read.thisTurnFacts,
      factSpans: read.factSpans?.block ?? null,
      conversationSummary: read.conversationSummary,
      continuationData: renderCompanionContextHandoff(handoffDraft),
      petProfile: read.petProfile,
      accountVoiceDialect,
    });
  } catch (error) {
    if (error instanceof AgentContextError) {
      const overflow = error.code === "required_context_overflow";
      await markCompanionRunFailed(read, ctx,
        overflow ? "AGENT_BUDGET_EXCEEDED" : "INTERNAL_ERROR", false,
        overflow ? "这次需要带入的内容太多，没法一次读完；可以按段继续。"
          : "这一轮的引用范围或装配配置不完整，请重新发起。", "execution");
    }
    throw error;
  }
  const admitted = contextReceipts.admittedSources();
  const residentSources = admitted.has("resident_memory") ? memoryContext.memorySourceVersions?.resident ?? [] : [];
  const directorySources = admitted.has("memory_directory") ? memoryContext.memorySourceVersions?.directory ?? [] : [];
  handoffInput.memoryRefs = admitted.has("resident_memory") ? memoryContext.memoryRefs : [];
  handoffInput.memoryDirectory = admitted.has("memory_directory") ? memoryContext.memoryDirectory : [];
  handoffInput.memorySourceVersions = [...residentSources, ...directorySources];
  const proposedHandoffSnapshot = buildCompanionContextHandoffSnapshotV1({
    ...handoffInput,
    modelMessages: messages,
  });
  const proposedHandoffSha256 = sha256Utf8V1(canonicalJsonV1(proposedHandoffSnapshot));
  const committedHandoff = await persistCompanionContextHandoffSnapshot({
    workspaceId: ctx.workspaceId,
    userId: read.userId,
    runId: read.runId,
    snapshot: proposedHandoffSnapshot,
    sha256: proposedHandoffSha256,
  }).catch(async error => {
    if (error instanceof CompanionContextChangedError)
      await markCompanionRunFailed(read, ctx, error.code, true, error.message, "execution");
    throw error;
  });
  // A retry must replay the exact committed messages and memory receipt set, even if
  // background memory maintenance changed what a fresh retrieval would return.
  const committedMessages = committedHandoff.snapshot.modelMessages as ChatMessage[];
  replayTailSeqs = committedHandoff.snapshot.historyTail.map(message => message.seq);
  // A retry can recover an older frozen replay after background maintenance.
  // Fresh summary bounds/gaps do not describe that committed replay.
  if (committedHandoff.sha256 !== proposedHandoffSha256) replaySummaryCoverage = null;
  memoryContext = { ...memoryContext, memoryRefs: committedHandoff.snapshot.memoryRefs };
  read.memoryRefs = memoryContext.memoryRefs;
  read.memoryDirectory = committedHandoff.snapshot.memoryDirectory ?? [];
  const directoryIds = new Set(read.memoryDirectory.map(source => source.memoryId));
  const committedSourceIds = [...new Set(committedHandoff.snapshot.memorySourceVersions?.map(source => source.memoryId) ?? [])];
  await recordCompanionMemoryContextExposure({ workspaceId: ctx.workspaceId, userId: read.userId }, read.runId, {
    residentMemoryIds: committedSourceIds.filter(id => !directoryIds.has(id)), usedMemoryIds: committedSourceIds,
  });

  // 量的是**要发出去的那份请求**，不是中间变量：`<conversation_summary>` 这条链
  // 单元级早就绿了，缺的是"真回合里它到底进没进 system 消息"这一环的证据
  // （方案 29 §12 C1）。INFO 级：dev 里读得到，一次回合一行。
  logger.info(
    {
      runId: read.runId,
      summaryInjected: String(committedMessages[0]?.content ?? "").includes("<conversation_summary>"),
      handoffSnapshotSha256: committedHandoff.sha256,
      summaryChars: read.conversationSummary?.length ?? 0,
    },
    "companion turn context assembled",
  );

  // ── 阶段 2a：fence claim + assistant.status（provider 调用前）─────────
  // 让客户端尽早进入 thinking；run 已被 cancel/supersede 时不调用 provider。
  const expiresAt = new Date(Date.now() + 24 * 3_600_000).toISOString();

  const notifyCompanionEvent = async (tx: { execute(q: unknown): Promise<unknown> }, seq: number): Promise<void> => {
    await tx.execute(sql`
      UPDATE companion_turn_runs
      SET last_event_seq = ${seq}, updated_at = now()
      WHERE id = ${read.runId}
    `);
    await tx.execute(sql`
      SELECT pg_notify('astella_companion_events_v1',
                       ${JSON.stringify({ conversationId: read.conversationId, maxSeq: seq })})
    `);
  };

  const claimed = await withWorkerWorkspaceTransaction(
    { workspaceId: ctx.workspaceId, userId: read.userId },
    async (tx) => {
      await lockCompanionRunForEventWrite(tx, read.runId);
      await lockJobLease(tx, ctx);
      await assertCompanionContextSourcesCurrent(tx, { workspaceId: ctx.workspaceId, userId: read.userId }, read.runId);
      const [account] = await tx.execute(sql`SELECT user_id FROM user_companion_account_state
        WHERE user_id=${read.userId} AND epoch=${read.accountEpoch} AND global_enabled`);
      if (!account) throw new Error("companion agent account epoch is stale or globally disabled");
      const claimedRow = await tx.execute<{ id: string }>(sql`
        UPDATE companion_turn_runs
        SET status = 'running', started_at = COALESCE(started_at, now())
        WHERE id = ${read.runId}
          AND (
            status IN ('accepted', 'running')
            OR (status = 'waiting_for_confirmation' AND waiting_proposal_id = ${continuationProposalId ?? null})
          )
          AND generation = ${read.generation}
          AND (job_id IS NULL OR job_id = ${ctx.id})
          AND account_epoch = ${read.accountEpoch}
          AND EXISTS (SELECT 1 FROM user_companion_account_state a
            WHERE a.user_id = companion_turn_runs.user_id AND a.epoch = companion_turn_runs.account_epoch AND a.global_enabled)
        RETURNING id
      `);
      if (!claimedRow[0]) {
        logger.info({ runId: read.runId }, "companion run 已被 cancel/supersede，丢弃迟到输出");
        return false;
      }
      const counters = await tx.execute<{ next_event_seq: string }>(sql`
        UPDATE companion_conversations
        SET next_event_seq = next_event_seq + 2
        WHERE id = ${read.conversationId}
        RETURNING next_event_seq
      `);
      const statusSeq = Number(counters[0].next_event_seq) - 2;
      const cueSeq = Number(counters[0].next_event_seq) - 1;
      await insertStreamEvent(tx, {
        conversationId: read.conversationId,
        workspaceId: ctx.workspaceId,
        userId: read.userId,
        runId: read.runId,
        generation: read.generation,
        accountEpoch: read.accountEpoch,
        seq: statusSeq,
        type: "assistant.status",
        // 这一刻还不知道这一轮开不开思考（判据要等本轮的注意力解释跑完），
        // 所以只显示等待回复。真开了思考，运行时会在判定之后补一条 thinking。
        payload: { status: "waiting", safeLabel: "正在准备回复…", inputKind: read.initiativeInput ? "initiative" : "user" },
        expiresAt,
      });
      // §5.2 确定性来源：thinking → think/curious/0.35（与 status 同事务原子下发）。
      await insertStreamEvent(tx, {
        conversationId: read.conversationId,
        workspaceId: ctx.workspaceId,
        userId: read.userId,
        runId: read.runId,
        generation: read.generation,
        accountEpoch: read.accountEpoch,
        seq: cueSeq,
        type: "character.cue",
        payload: { cue: THINKING_CUE_PAYLOAD_V1 },
        expiresAt,
      });
      await notifyCompanionEvent(tx, cueSeq);
      return true;
    },
  ).catch(async (error: unknown) => {
    /**
     * 这一格是"用户改了相处偏好／设了勿扰／页面换了"最早能被判定的地方，而它跑在
     * provider 之前、也在下面那个大 try 之外。原来这里抛出的 CONTEXT_STALE 没有任何
     * 失败收尾，run 就一直停在 accepted——界面上挂着一个永远不会开口的轮次，
     * 既不取消也不报错（2026-10-16 实库复现：改一次相处偏好即可稳定重现）。
     *
     * 走与别处同一条收尾：主动轮 + CONTEXT_STALE 是**静默停**（cancelled，无错误气泡），
     * 用户轮则记为确定失败。CONTEXT_STALE 本身是不可重试的，所以 recoverable=false。
     */
    if (error instanceof CompanionContextChangedError) {
      await markCompanionRunFailed(read, ctx, error.code, false, error.message, "state");
    }
    throw error;
  });
  if (!claimed) return;

  // ── 阶段 2b：统一 Agent loop（每一步真实流式下发） ────────────────────
  // 普通闲聊由 provider 以空工具列表单步完成；带 Skill 的请求在运行时内
  // 进行有限步工具循环。**每一步**（含带工具的那几步）的 provider 增量都经
  // 交付管线实时下发（稳定前缀 + 增量校验 + 边生成边落库），不再等全文取回后
  // 再补写 delta。带工具的一步在调用工具前说的开场白会作为正文的一部分保留
  // （见 runCompanionAgentLoop 的 visibleSegments）。
  let voiceSegmentState: CompanionDisplaySegmentState = { cursor: 0, sentCount: 0 };
  let voiceSegmentsEnabled = isCompanionVoiceDialogueEnabled();
  let voiceSegmentsWritten = false;
  let publishedVoiceChars = 0;
  const voiceExpressionEnabled = !read.groundedTutorContext && read.petProfile?.boundaries?.allowVoiceTags !== false;
  const voiceDeliveryDecision = decideCompanionVoiceDelivery({
    voiceDialogueEnabled: voiceSegmentsEnabled,
    formalAnswerInProgress: read.formalAnswerInProgress,
  });
  let semanticVoiceStyle: AgentVoiceStyleDecisionV1 | null = null;
  /**
   * 这一轮的字要不要落进笔记/卡片。判据取结构化解释的候选能力（工具面按声明装配），
   * 不等工具真跑起来——第一段话可能在调用工具之前就说完了，而文案轮整轮都回普通话。
   */
  let turnWritesDocumentContent = false;
  if (voiceDeliveryDecision === "formal_answer_in_progress") {
    // 这一句是这条门唯一的可查痕迹：没有它，"她今天怎么不念了"只能靠猜。
    logger.info({ runId: read.runId }, "正式作答中：这一轮伴星回复只出文字，不切句也不送合成");
  }
  const emitVisibleVoiceSegments = async (visibleText: string, isFinal: boolean, modelText: string, messageId?: string, displayOffset = publishedVoiceChars): Promise<void> => {
    // 不是"藏掉播放"：直接不发段事件，于是正文也不会被送去外部合成服务。
    // 上面那句 `voiceSegmentsEnabled` 是另一件事——它是"这一段写失败之后本回合别再试"，
    // 可以在一轮中途被关掉，而正式作答是整轮都不念。
    if (!voiceSegmentsEnabled) return;
    if (voiceDeliveryDecision !== "delivered") return;
    const expression = projectCompanionVoiceExpression(modelText, read.factSpans?.values ?? {});
    const expressionEnabled = voiceExpressionEnabled;
    // Whole-turn voice style is a user-directed semantic choice and remains available
    // even when the persona disables incidental emotion/rich-sound tags.
    const voiceInstruction = resolveCompanionVoiceInstruction(read.userText, semanticVoiceStyle, {
      accountDialect: accountVoiceDialect, documentWork: turnWritesDocumentContent,
    });
    if (isFinal) logger.info({ runId: read.runId, expressionEnabled,
      voiceStyleProtocol: "companion-voice-style-intent-v1",
      voiceStyleDecision: semanticVoiceStyle?.decision ?? "unavailable",
      voiceInstructionSource: voiceInstruction.source,
      voiceAccountDialect: accountVoiceDialect,
      voiceDocumentWork: turnWritesDocumentContent,
      voiceDialect: qwenDialectForInstruction(voiceInstruction.instruction),
      expressionProtocol: "companion-voice-expression-v1",
      controlTags: expression.marks.filter(mark => mark.kind === "control").map(mark => mark.tag).slice(0, 64),
      richTagCount: expression.marks.filter(mark => mark.kind === "rich").length,
      displayAligned: expression.displayText.startsWith(visibleText),
    }, "companion voice expression finalized");
    const split = splitCommittedDisplaySegments(visibleText, voiceSegmentState, isFinal, {
      // Leave room for a control tag and positioned rich sounds in the 160-character contract.
      maxSegmentChars: expressionEnabled ? 112 : 160,
      expressionBoundaries: expressionEnabled ? companionVoiceExpressionBoundaries(expression) : [],
    });
    voiceSegmentState = split.next;
    if (split.segments.length === 0) return;
    // turn 级风格指令直接来自并行结构化注意力解释器；显式请求识别只在解释没有
    // 声音变化时兜底，不覆盖 apply/clarify 的语义结果。它独立于句内情绪/拟声标签开关。
    // 随每段下发，服务端合成时从事件重读。
    const instruction = voiceInstruction.instruction;
    // Every speakable segment belongs to the delivery, including a long reply's
    // final sentence. Segment size bounds synthesis requests, never the reply.
    const segments = split.segments.flatMap((segment) => {
      const synthesis = companionVoiceSegmentExpression(expression, segment, expressionEnabled);
      if (!synthesis.text) return [];
      const synthesisText = synthesis.text;
      const synthesisTextSha256 = synthesis.textSha256;
      return [{
        version: 2 as const,
        ...(messageId ? { messageId } : {}),
        segmentId: companionSegmentId(read.runId, read.generation, segment.ordinal, synthesisTextSha256),
        ordinal: segment.ordinal,
        displayText: segment.displayText,
        displayStart: segment.displayStart + displayOffset,
        displayEnd: segment.displayEnd + displayOffset,
        synthesisText,
        synthesisTextSha256,
        cue: synthesis.cue,
        ...(instruction ? { instruction } : {}),
      }];
    });
    if (segments.length === 0) return;
    try {
      const written = await emitCompanionTtsSegments({
        job: ctx,
        workspaceId: ctx.workspaceId,
        userId: read.userId,
        runId: read.runId,
        generation: read.generation,
        accountEpoch: read.accountEpoch,
        conversationId: read.conversationId,
        expiresAt,
        notifyCompanionEvent,
        segments,
      });
      if (!written) voiceSegmentsEnabled = false;
      else voiceSegmentsWritten = true;
    } catch (error) {
      // 语音是渐进增强；事件写入失败不能把已经安全提交的文字回复一起判失败。
      voiceSegmentsEnabled = false;
      await recordCompanionRunFailureSpanBestEffort({
        workspaceId: ctx.workspaceId,
        userId: read.userId,
        runId: read.runId,
      }, "tts");
      logger.warn({ err: error, runId: read.runId }, "companion voice segment emission disabled for turn");
    }
  };
  const initialDelivery = await readCompanionDeliveredPrefix(ctx, read);
  const streamingDelivery = createCompanionStreamDelivery({
    initial: initialDelivery,
    job: ctx,
    ctx,
    read,
    expiresAt,
    // 流式下发的每一段都要经过目录渲染，否则用户会先看到 `{{f:today_minutes}}`。
    factSpanValues: read.factSpans?.values ?? {},
    notifyCompanionEvent,
    onVisibleCommitted: async (_committed, visibleText, modelText) => emitVisibleVoiceSegments(visibleText, false, modelText),
  });
  /**
   * 思考走**另一条通道**（2026-10-13）：不净化、不校验、不进正文、不进朗读，
   * 写失败只让它自己停下。放在这里而不是交付管线里，就是为了让它拿不到
   * `onVisibleCommitted`——语音分段只由已提交的可见正文驱动。
   */
  const thinkingDelivery = createCompanionThinkingDelivery({
    ctx,
    read,
    expiresAt,
    notifyCompanionEvent,
  });
  let assistantText: string;
  let ttsRawText: string | null = null;
  let agentResult;
  try {
    // L1 路由（默认关）：只有显式开启时才建 embedding 出口，且它走治理门（同意 + 外发政策）。
    const releaseRouterMode = resolveCompanionEntryMode() === "classified" ? resolveCompanionReleaseRouterMode() : "off";
    const releaseRouterEmbed = releaseRouterMode === "off" ? undefined
      : createCompanionReleaseEmbeddingPort({ workspaceId: ctx.workspaceId, userId: read.userId, job: ctx });
    const releaseRouter = releaseRouterMode !== "enforce" || !releaseRouterEmbed ? undefined
      : createCompanionReleaseRouterPort({
        mode: releaseRouterMode, scopeKey: `${ctx.workspaceId}:${read.userId}`, text: read.userText,
        recentMessages: read.recentMessages,
        activeLearningTask: read.groundedTutorContext !== null || read.formalAnswerInProgress,
        embed: releaseRouterEmbed, workspaceId: ctx.workspaceId, userId: read.userId,
      });
    agentResult = await runCompanionAgentLoop({
      ctx,
      read,
      provider,
      fallbackProvider,
      // 活跃度决定退化闸的字数线（方案 29 §9.17）：不传就等于忽略用户的设置。
      activeness: read.petProfile?.activeness ?? null,
      // 图片能不能出境是**账号级政策**，不是她这一轮可以自己争取的东西：政策关着、
      // 或当前没有可用的看图模型（resolveVisionReader 为 null）时，读图工具既不下发
      // 也不会执行，她看不见就不会答应去看。
      toolConstraints: {
        visionEnabled: govCtx.policy.sendImageContent === true && resolveVisionReader(govCtx) !== null,
      },
      ...(releaseRouterEmbed ? { embedText: releaseRouterEmbed } : {}),
      ...(releaseRouter ? { releaseRouter } : {}),
      baseMessages: committedMessages,
      initialVisibleText: initialDelivery.text,
      onVisibleCheckpoint: async modelText => {
        const projected = projectCompanionVisible(modelText, read.factSpans?.values ?? {});
        if (projected.kind !== "visible") return false;
        const delivered = streamingDelivery.deliveredText();
        // An interrupted input may have an additional committed partial step;
        // its recovery branch preserves that suffix and supplies correction.
        if (delivered.length > projected.text.length && delivered.startsWith(projected.text)) return true;
        return streamingDelivery.writeTail(projected.text, modelText);
      },
      historyForCompaction: committedHandoff.snapshot,
      compactionCheckpoints: committedHandoff.snapshot.compactions,
      persistCompactionTraces: async () => {
        await compactionTrace.commit({ workspaceId: ctx.workspaceId, userId: read.userId, runId: read.runId,
          snapshot: committedHandoff.snapshot, sha256: committedHandoff.sha256 });
      },
      contextReceipts,
      // 只有组装回放的这一层知道每条尾部消息的来源 seq 与摘要覆盖到哪（44 §5.2）。
      // Fold only covered whole exchanges. A semantic summary is lossy; source
      // messages remain recoverable from the database by conversation and seq.
      replayFold: (messages) => {
        const tail = replayTailSeqs.flatMap((seq, index) => (
          messages[index] ? [{ message: messages[index]!, seq }] : []
        ));
        if (tail.length === 0) return null;
        const folded = foldReplayUnderSummaryCoverage({
          system: [], tail, trailing: messages.slice(tail.length), coverage: replaySummaryCoverage,
        });
        return folded.receipt
          ? { messages: replayToMessages(folded.replay), receipt: folded.receipt }
          : null;
      },
      // 失败冷却跨轮次生效：同一份失败输入不会每轮都白折一次（44 §5.4）。
      compactionTrace,
      compactionCooldown: createCompactionCooldownPorts({
        workspaceId: ctx.workspaceId,
        userId: read.userId,
        conversationId: read.conversationId,
        // 来源版本 = 摘要覆盖的 sourceSha256（`CompactionCooldownContext` 的口径）。
        // 这里原来把整份请求的哈希放在前面，于是键每轮每步都变、同一个键永远只出现一次，
        // 跨轮保护名存实亡（44 §5.4「同一失败输入不能每轮重新触发」）。
        // 「折的是哪一类来源」由折叠侧补进键里（`CompactionCooldownPorts.foldSourceKind`）：
        // 摘要是跨轮的基座，工具回合是同一轮里的另一份来源，两者不能共键。
        sourceHash: () => replaySummaryCoverage?.sourceSha256 ?? null,
        latestPressure: () => contextReceipts.latestPressure(),
      }),
      expiresAt,
      continuationProposalId,
      onProviderDelta: read.initiativeInput ? undefined : (delta) => streamingDelivery.onRawDelta(delta),
      onReasoningDelta: thinkingDelivery.onReasoningDelta,
      onTurnInterpretation: async (interpretation) => {
        semanticVoiceStyle = interpretation.voiceStyle;
        turnWritesDocumentContent = companionTurnWritesDocumentContent(interpretation.candidateOperations);
        try {
          return await persistCompanionDialectPreference({
            workspaceId: ctx.workspaceId,
            userId: read.userId,
            change: interpretation.voiceStyle.persistentPreference,
          });
        } catch {
          logger.warn({ runId: read.runId }, "persistent companion dialect preference write failed");
          return "failed";
        }
      },
      onUtterancePublished: async (messageId, text, rawText) => {
        const draftCursor = voiceSegmentState.cursor;
        voiceSegmentState = { cursor: 0, sentCount: voiceSegmentState.sentCount };
        try { await emitVisibleVoiceSegments(text, true, rawText, messageId, draftCursor + publishedVoiceChars);
          publishedVoiceChars += text.length + 2; }
        finally { voiceSegmentState = { ...voiceSegmentState, cursor: draftCursor }; }
      },
      handlerStartedAtMs,
    });
  } catch (err) {
    // 兜底那条 INTERNAL_ERROR 过去只留下「companion agent execution failed」，
    // 到底是哪一支抛的没人知道（2026-10-16 查本地主动轮全挂时白绕了两圈）。
    // 只记日志，不改用户看到的那句实话。
    logger.warn({
      runId: read.runId,
      errorName: err instanceof Error ? err.name : typeof err,
      errorMessage: err instanceof Error ? String(err.message).slice(0, 240) : undefined,
      // 有一层把什么都盖成「存储不可用」，所以 `cause` 必须一起打出来。
      causeName: err instanceof Error && err.cause instanceof Error ? err.cause.name : undefined,
      causeMessage: err instanceof Error && err.cause instanceof Error
        ? String(err.cause.message).slice(0, 240) : undefined,
      thrownFrom: err instanceof Error ? err.stack?.split("\n")[1]?.trim().slice(0, 180) : undefined,
    }, "companion agent failure cause");
    // 预算耗尽（步数/工具数/执行时间）是确定性失败：标记 recoverable=false，
    // 队列侧同时按不可重试处理，避免空转重投（见 isNonRetryableError）。
    const contextOverflow = err instanceof AIContextOverflowError;
    const budgetExceeded = err instanceof CompanionAgentBudgetExceededError || contextOverflow;
    const contextChanged = err instanceof CompanionContextChangedError;
    // 交付管线主动叫停（增量校验命中泄露/超限、fence 失联）：同样不可重试——
    // 重投不会让"泄露"消失。已下发的部分必然是最终文本的前缀，客户端按 error 收尾。
    const streamStopped = err instanceof CompanionStreamStoppedError;
    const protocolLeak = (streamStopped && streamingDelivery.failureReason() === "tool_protocol_leak")
      || (err instanceof AgentOutputError && err.code === "tool_protocol_leak");
    const invalidReplyFailureText = "这次答复格式异常，已停止输出；已完成的操作仍然保留。";
    const outputIncomplete = err instanceof AgentOutputError && err.code === "output_truncated";
    const outputUnverified = err instanceof AgentOutputError && err.code === "unverified_quote";
    const argumentsInvalid = err instanceof AgentOutputError && err.code === "arguments_malformed";
    // 原地重放（同一个成功调用又被原样要了一次）：agent 里没有预算上限，
    // 所以这一类的收口必须是这句错误，而不是"步数到了"。见 companion-progress-guard.ts。
    const noProgress = err instanceof AgentOutputError && err.code === "no_progress";
    const actionUnverified = err instanceof AgentOutputError && err.code === "action_unverified";
    const invalidArgumentsFailureText = "这一步没能执行，已停止重复尝试；已完成的操作仍然保留。";
    const noProgressFailureText = "这一步反复要同一个操作、没有新的进展，已经停下；已完成的操作仍然保留。";
    let noteEditSaved = false;
    let savedWriteNames: string[] = [];
    if (outputUnverified) {
      try { noteEditSaved = await companionSavedNoteEditExists({ workspaceId: ctx.workspaceId, userId: read.userId }, read.runId); }
      catch { logger.warn({ runId: read.runId }, "could not verify saved note edit while reporting quote failure"); }
      try { savedWriteNames = await listSucceededWriteToolNames({ workspaceId: ctx.workspaceId, userId: read.userId }, read.runId); }
      catch { logger.warn({ runId: read.runId }, "could not list succeeded writes while reporting quote failure"); }
    }
    // 终答被引文判不过不等于这轮什么都没做：写操作已经落库、不会随终答回滚。
    // 只说"答复没有完成"就把她做成的事报成没做——照实点名哪些留下了。
    const unverifiedQuoteFailureText = noteEditSaved
      ? "笔记正文修改已保存；这次修改说明的引文没有核对通过，说明未完成。"
      : savedWriteNames.length > 0
        ? `这次引文与已读取的原文对不上，说明没有完成；已经做成的操作仍保留：${
          savedWriteNames.map((name) => COMPANION_AGENT_TOOL_LABELS[name] ?? name).join("、")}。`
        : "这次引文与已读取的原文对不上，答复没有完成。";
    const providerRejected = err instanceof ProviderRequestError;
    const rateLimited = providerRejected && err.status === 429;
    const policyDenied = err instanceof AIDataPolicyDeniedError;
    await markCompanionRunFailed(
      read,
      ctx,
      contextChanged ? err.code : policyDenied ? "AI_DATA_POLICY_DENIED" : protocolLeak ? "REPLY_FORMAT_INVALID" : actionUnverified ? "ACTION_NOT_EXECUTED" : argumentsInvalid ? "TOOL_ARGUMENTS_INVALID" : noProgress ? "AGENT_NO_PROGRESS" : outputIncomplete ? "REPLY_LENGTH_LIMIT" : budgetExceeded ? "AGENT_BUDGET_EXCEEDED" : rateLimited ? "RATE_LIMITED" : providerRejected ? "PROVIDER_UNAVAILABLE" : "INTERNAL_ERROR",
      !policyDenied && !protocolLeak && !budgetExceeded && !contextChanged && !outputIncomplete && !outputUnverified && !actionUnverified && !argumentsInvalid && !noProgress && !streamStopped && !(providerRejected && [401,402,403].includes(err.status)),
      contextChanged ? err.message : policyDenied ? "请在 AI 数据同意页开启「允许发送到外部模型服务」后继续。" : contextOverflow ? "这次需要带入的内容太多，没法一次读完；可以按段继续。" : protocolLeak ? invalidReplyFailureText : actionUnverified ? "这次没有取得所要求操作的执行或无需变更回执，不能确认完成；已完成的其他操作仍保留。" : outputUnverified ? unverifiedQuoteFailureText : argumentsInvalid ? invalidArgumentsFailureText : noProgress ? noProgressFailureText : outputIncomplete ? "这次答复达到长度上限，已说出的内容保留；可以接着分段讲。" : budgetExceeded
        ? "companion agent budget exceeded"
        : streamStopped
          ? `companion stream stopped: ${streamingDelivery.failureReason() ?? "delivery pipeline"}`.slice(0, 240)
          : rateLimited ? "模型服务暂时繁忙，请稍后重试；已经完成的操作仍保留。"
            : providerRejected ? "模型服务暂时无法完成这次请求，已经完成的操作仍保留。"
              : "companion agent execution failed",
      policyDenied ? "state" : protocolLeak ? "output" : streamStopped ? "delivery" : outputUnverified || actionUnverified || argumentsInvalid || noProgress ? "output" : budgetExceeded || outputIncomplete || contextChanged ? "execution" : "transport",
    );
    // 她已经说出来的那半句不能随失败一起消失（2026-09-19）。
    await persistFailedPartial({
      workspaceId: ctx.workspaceId,
      userId: read.userId,
      conversationId: read.conversationId,
      runId: read.runId,
      deliveredText: streamingDelivery.deliveredText(),
      failureText: protocolLeak ? invalidReplyFailureText : outputUnverified ? unverifiedQuoteFailureText : argumentsInvalid ? invalidArgumentsFailureText : noProgress ? noProgressFailureText : undefined,
    });
    throw err;
  } finally {
    // 循环一结束（成功、失败、还是等着确认）就不再有新思考了；把压在节流窗口里的
    // 最后一块刷出去，这条通道就此关门。放 finally 是因为三个出口都不该带着半块
    // 思考离开，而它的成败与快慢**不影响**这一轮怎么收尾。
    await thinkingDelivery.finish();
  }
  // 折叠轨迹并进交接快照（44 §3.3）。位置要紧：必须紧跟 loop、在任何分支之前——
  // 围栏允许 waiting_for_confirmation 时写（那一步同样可能折过），而这个分支自己会
  // 提前 return；放在分支之后，提议确认那一步折掉的内容就永远进不了审计。

  await compactionTrace.commit({
    workspaceId: ctx.workspaceId, userId: read.userId, runId: read.runId,
    snapshot: committedHandoff.snapshot, sha256: committedHandoff.sha256,
  });
  if (agentResult.status === "waiting_for_confirmation") {
    
    // 等用户确认：本轮不写 assistant.final（终态消息由确认后的续跑产出）。
    // 但**必须把已下发的稳定前缀落库关门**（④-b）：带工具的一步现在也会流式，
    // 这一步可能正是提议确认的那一步，开场白已经发给客户端——不 finish 的话
    // 压在节流窗口里的尾巴永远写不出去，客户端草稿会缺一截。
    const flushed = await streamingDelivery.finish();
    if (!flushed.ok) {
      logger.warn(
        { runId: read.runId, reason: flushed.reason },
        "companion stream flush failed on a waiting-for-confirmation turn",
      );
    } else {
      await emitVisibleVoiceSegments(flushed.text, true, streamingDelivery.modelText());
    }
    return;
  }
  if (!agentResult.text.trim() || read.initiativeInput?.facts.canSpeak === false) {
    await thinkingDelivery.finish();
    await finishCompanionParticipation(ctx, read, expiresAt);
    return;
  }
  // 定成下游唯一看到的文本（剥信封 → 渲染占位符 → 目录外的键留痕；三步顺序是契约，
  // 理由见 finalizeCompanionReplyText）。
  const finalized = finalizeCompanionReplyText({
    text: agentResult.text, factSpans: read.factSpans?.values ?? null, runId: read.runId,
  });
  ttsRawText = finalized.text;

  // A host occasion may end without speech. Providers can return only voice
  // markers instead of an empty string; that still has no visible
  // content. Do not turn this quiet decision into an unsolicited failure card.
  //
  // 2026-10-16 生产 run `df40b8a9`：用户只发「哈哈哈」，她回了一个 `[neutral]`。
  // 这个豁免当时只接在主动轮上，人问那一支往下掉进普通失败路径，被判
  // `INTERNAL_ERROR` 并留下「这次回复没能完成」——一次没发生的内部错误。
  // 上面那条 `!agentResult.text.trim()` 早就让人问轮的"真·空回复"安静收尾了，
  // 只回标记与它是同一个语义，只差一层信封；剥完信封为空不该变成另一种结局。
  // 退化阶梯本应先接住这种形状（`looksTruncatedReply("")` 返回 true），但它第一道
  // `canRepair` 要求配了 `companion_fallback`，生产没配，于是整条降级是空的。
  if (!streamingDelivery.deliveredText().trim() && agentResult.blocks.length === 0) {
    const visible = validateCompanionOutput(ttsRawText);
    if (!visible.ok && visible.reason === "empty_after_markdown_strip") {
      await finishCompanionParticipation(ctx, read, expiresAt);
      return;
    }
  }

  // 信任边界：流式期间每个 flush 前都已跑过增量校验（长度/泄露），这里收尾。
  //
  // 2026-10-16：判错之后的后果与三道产出闸收成同一形状（补正按判据、销毁按权威事实）。
  // 本轮真落下写回执、且**已经下发给客户端的那段稳定前缀**自己站得住时，就把前缀当终答交付：
  // 用户已经看见它了，再报一次「这次回复没能完成」只会把她做成的事抹掉——那正是
  // run `fb2da98f` 那类事故的收尾版。只有交付管线真的断了（`delta_stream_lost`，
  // 此时没有任何文本还发得出去）或前缀也拿不出手时，才按权威事实作废整轮。
  const landedWrites = agentResult.writesLanded === true;
  const alreadyDelivered = streamingDelivery.deliveredText();
  const stablePrefix = validateCompanionOutput(alreadyDelivered);
  // 降级只能交付**客户端已经看到的那一份**，一字不差：净化若还会剥掉字符，
  // 存下来的正文就与气泡里的流式内容不等，`assistant.final` 与 delta 会指两种文本。
  const deliverablePrefix = stablePrefix.ok && stablePrefix.text.length > 0
    && stablePrefix.text === alreadyDelivered ? alreadyDelivered : "";
  let deliveredPrefixOnly = false;
  let finalVisibleText = "";
  const streamed = await streamingDelivery.finish();
  if (!streamed.ok) {
    const fallback = companionStreamFallbackText({ gate: "stream_validation", landedWrites,
      reason: streamed.reason, deliveredPrefix: deliverablePrefix });
    if (!fallback.deliver) {
      await markCompanionRunFailed(read, ctx, "INTERNAL_ERROR", false, streamed.reason, "output");
      await persistFailedPartial({
        workspaceId: ctx.workspaceId,
        userId: read.userId,
        conversationId: read.conversationId,
        runId: read.runId,
        deliveredText: streamingDelivery.deliveredText(),
      });
      throw new Error(`companion stream validation failed: ${streamed.reason}`);
    }
    logger.warn({ runId: read.runId, reason: streamed.reason }, fallback.note);
    finalVisibleText = fallback.text;
    // 交付管线已经判死，尾部再也补不进去；前缀就是本轮要发的全部正文。
    deliveredPrefixOnly = true;
  }
  // 全文校验（markdown/标签净化、信封拒绝）必须对完整文本成立；已下发的稳定前缀
  // 必须是最终文本的前缀，否则两条路径漂移。漂移本身仍由这里判，但**后果**走同一道闸：
  // 有落库成果就把已经发出去的那段前缀当终答，不再因为一次判错把整轮作废。
  const validated: { ok: true; text: string } | { ok: false; reason: string } = streamed.ok
    ? reconcileStreamedText({
      delivered: streamed.text,
      validated: validateCompanionOutput(ttsRawText),
    })
    // 上面已经决定交付前缀，不再对账（`finalVisibleText` 就是那份前缀）。
    : { ok: true as const, text: finalVisibleText };
  if (!validated.ok) {
    // 诊断（2026-09-19）：流式前缀与全文净化不一致时，必须能一眼看出差在哪——
    // 只记长度与首个差异点 + 两小段上下文，不整段落日志。
    if (validated.reason === "stream_full_text_diverged") {
      const deliveredText = alreadyDelivered;
      const finalText = validateCompanionOutput(ttsRawText);
      const finalValue = finalText.ok ? finalText.text : "";
      let divergeAt = 0;
      while (
        divergeAt < deliveredText.length
        && divergeAt < finalValue.length
        && deliveredText[divergeAt] === finalValue[divergeAt]
      ) {
        divergeAt += 1;
      }
      logger.warn(
        {
          runId: read.runId,
          deliveredChars: deliveredText.length,
          finalChars: finalValue.length,
          divergeAt,
          deliveredExcerpt: deliveredText.slice(Math.max(0, divergeAt - 12), divergeAt + 12),
          finalExcerpt: finalValue.slice(Math.max(0, divergeAt - 12), divergeAt + 12),
        },
        "companion streamed prefix diverged from validated text",
      );
    }
    const protocolLeak = validated.reason === "tool_protocol_leak";
    const fallback = companionStreamFallbackText({ gate: "stream_reconcile", landedWrites,
      reason: validated.reason, deliveredPrefix: deliverablePrefix });
    if (fallback.deliver) {
      logger.warn({ runId: read.runId, reason: validated.reason }, fallback.note);
      finalVisibleText = fallback.text;
      // 被拒的那段原文不能再驱动语音：它正是这两道闸拦住的内容，念出来等于把判掉的尾巴
      // 送到外部合成服务；本轮的正文就只有已经下发的那一段。
      deliveredPrefixOnly = true;
    } else {
      await markCompanionRunFailed(read, ctx, protocolLeak ? "REPLY_FORMAT_INVALID" : "INTERNAL_ERROR", false,
        protocolLeak ? "这次答复格式异常，已停止输出；已完成的操作仍然保留。" : validated.reason, "output");
      await persistFailedPartial({
        workspaceId: ctx.workspaceId,
        userId: read.userId,
        conversationId: read.conversationId,
        runId: read.runId,
        deliveredText: streamingDelivery.deliveredText(),
      });
      if (protocolLeak) throw new AgentOutputError("tool_protocol_leak", "companion returned native tool syntax as prose");
      throw new Error(`companion output validation failed: ${validated.reason}`);
    }
  }
  // delta 与终态 assistant message 使用同一份净化文本（markdown/标签剥离后），
  // 否则客户端流式渲染的内容与 assistant.final 指向的消息不一致。
  assistantText = validated.ok ? validated.text : finalVisibleText;
  if (await companionFollowupRepeatsParent(read, { workspaceId: ctx.workspaceId, userId: read.userId }, assistantText)) {
    await finishCompanionParticipation(ctx, read, expiresAt);
    return;
  }
  if (streamingDelivery.deliveredChars() === 0) {
    // 没走成流式（provider 无流式实现 / 信封守卫 / 空流）：回退到整段补写 delta，
    // 事件布局与 2026-09-18 之后的实现完全一致。
    try {
      const batched = await writeBatchedDeltas({
        assistantText,
        ctx,
        read,
        expiresAt,
        notifyCompanionEvent,
      });
      if (!batched) return;
    } catch (err) {
      await markCompanionRunFailed(read, ctx, err instanceof CompanionContextChangedError ? err.code : "INTERNAL_ERROR",
        true, err instanceof CompanionContextChangedError ? err.message : "companion delta write failed", "delivery");
      throw err;
    }
  } else if (!deliveredPrefixOnly && !(await streamingDelivery.writeTail(assistantText, ttsRawText))) {
    // 已下发内容与终态文本必须逐字对齐（appendFrom 的基准就是下发长度）。
    // 这条是**权威事实**（写不进去了），不产生命名上的"判错"，所以不进出料闸。
    await markCompanionRunFailed(read, ctx, "INTERNAL_ERROR", false, "delta_stream_diverged", "delivery");
    await persistFailedPartial({
      workspaceId: ctx.workspaceId,
      userId: read.userId,
      conversationId: read.conversationId,
      runId: read.runId,
      deliveredText: streamingDelivery.deliveredText(),
    });
    throw new Error("companion streamed text diverged from validated text");
  }
  // 强制刷新最后一个未闭合句。已经在增量阶段发出的区间由 cursor 保证不会重复。
  // 降级交付时模型原文里带着被这两道闸拦下的尾巴，语音只认已经下发的那段正文。
  await emitVisibleVoiceSegments(assistantText, true,
    deliveredPrefixOnly ? assistantText : ttsRawText, undefined, publishedVoiceChars);


  // 阶段 3c（终态事务）搬到 companion-dialogue-finalization.ts：回答收尾自成一域，
  // 编排文件只保留调用。搬迁是纯搬运——判据、事务边界、事件布局一字未改。
  await finalizeCompanionDialogueTurn({
    ctx, read, runId, provider, agentResult, assistantText, ttsRawText, voiceExpressionEnabled,
    memoryContext, voiceSegmentsWritten, expiresAt, streamingDelivery, notifyCompanionEvent,
  });
}
