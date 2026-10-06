import { reserveCompanionProviderCall } from "./companion-agent-events.ts";
import { renderPlaybookCatalog } from "./companion-playbooks.ts";
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

import { randomUUID } from "node:crypto";
import { decideCompanionVoiceDelivery, findFormalAnswerTarget } from "../lib/formal-answer-signal.ts";
import { assessAnswerExposure, isFormalAnswerLivePage, recordCompanionAnswerExposure } from "./companion-answer-exposure.ts";
import { canonicalJsonV1, sha256Utf8V1 } from "@ailearn/shared/content-hash";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.ts";
import { ProviderRequestError } from "../lib/provider-request-error.ts";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { loadHereAndNow, renderHereAndNow } from "./companion-here-and-now.ts";
import { loadThisTurnFacts } from "./companion-this-turn-facts.ts";
import { renderConversationSummary } from "./companion-summarizer.ts";
import {
  CompanionStreamStoppedError,
  createCompanionStreamDelivery,
  reconcileStreamedText,
} from "./companion-dialogue-stream.ts";
import {
  AIConsentRequiredError,
  resolveAIGovernanceContext,
} from "../lib/governance.ts";
import { createCompanionContextReceipts } from "./companion-context-receipts.ts";
import { createCompactionTraceRecorder } from "./companion-context-handoff.ts";
import { resolveCompanionTurnProviders } from "./companion-turn-providers.ts";
import { createCompactionCooldownPorts } from "./companion-compaction-cooldown.ts";
import { foldReplayUnderSummaryCoverage, replayToMessages } from "./companion-compaction.ts";
import {
  COMPANION_PERSONA_V7_PROMPT_ID,
  COMPANION_PERSONA_V7_SHA256,
  type ChatMessage,
  type PetPersonaPresetBoundaries,
  type PetProfileActiveness,
} from "@ailearn/shared";
import { PET_PERSONA_PRESET_VERSION, resolveCompanionPersonaProfile } from "@ailearn/shared/pet-persona-presets";
import { runCompanionAgentLoop } from "./companion-agent-runtime.ts";
import { CompanionAgentBudgetExceededError, CompanionContextChangedError } from "../lib/non-retryable-errors.ts";
import { assertCompanionContextSourcesCurrent } from "./companion-context-sources.ts";
import type { AgentMemoryContextSourceV1 } from "@ailearn/shared/agent-contracts";
import {
  companionSegmentId,
  splitCommittedDisplaySegments,
  type CompanionDisplaySegmentState,
} from "../lib/tts-segments.ts";
import { applyDeterministicToneToSegments, resolveReplyToneEmotion } from "../lib/companion-tone.ts";
import {
  assembleCompanionContext,
  recordCompanionMemoryContextExposure,
  type ContextAssemblyResult,
} from "./companion-context-orchestrator.ts";
import {
  THINKING_CUE_PAYLOAD_V1,
  buildFinalCuePayload,
  buildCompanionPersonaMessages,
  validateCompanionOutput,
  textOfCompanionBlocks,
  parsePageContext,
  GROUNDED_TUTOR_COMPANION_PROMPT,
  boundCompanionRecentHistory,
  buildCompanionContextHandoffSnapshotV1,
  finalizeCompanionReplyText,
  renderCompanionContextHandoff,
  REPLAY_WINDOW_MESSAGES,
} from "./companion-dialogue-content.ts";
import {
  type CompanionDialogueHandlerContext,
  type ReadContext,
  insertStreamEvent,
  emitCompanionTtsSegments,
  recordCompanionRunFailureSpanBestEffort,
  recoverCompanionRunFailureSpanInTransaction,
  markCompanionRunFailed,
  readGroundedTutorContext,
  isActiveRun,
  isCompanionDialogueEnabled,
  isCompanionVoiceDialogueEnabled,
  isCompanionMemoryContextEnabled,
  enqueueCompanionMemoryJobs,
  readConversationSummaryChain,
  readCompanionHistoryRows,
  countCompanionHistoryMessages,
  companionHistoryText,
  persistCompanionContextHandoffSnapshot,
  GROUNDED_TUTOR_PROMPT_ID,
  computeGroundedTutorPromptSha256,
} from "./companion-dialogue-store.ts";
import {
  writeBatchedDeltas,
} from "./companion-dialogue-deltas.ts";

const groundedTutorPromptSha256 = computeGroundedTutorPromptSha256(GROUNDED_TUTOR_COMPANION_PROMPT);

/**
 * 用户"停止"后至少留下多少字才算值得留档（2026-09-19）。
 *
 * 与"太短不念"同一口径：一两句寒暄都没说完就停下（如"好"、"嗯我"），
 * 留在历史里是噪音而不是记录。可调，集中在这里改。
 */
const COMPANION_CANCELLED_MIN_CHARS = 12;

/**
 * 一轮**失败**之后，把她已经下发给客户端的部分留档（2026-09-19）。
 *
 * 与"用户按停止"那条留档对称：取消路径早就留了 `kind='cancelled'` 的部分记录，
 * 而失败路径此前只写 `error` 事件、**不写消息**——于是气泡里她已经说过的那半句，
 * 在收尾的一瞬间从对话历史里彻底消失（用户看到的是"内容没了"，历史里连这条都查不到）。
 *
 * 三条护栏：
 * - 只在 run 的真实终态是 `failed` 时落（`assistant_message_id IS NULL` 同时保证幂等：
 *   同一个 run 的重试/多次失败收尾不会插出第二条）；用户取消走 `cancelled` 路径，
 *   supersede 走新回合，都不在这里落。
 * - 太短不落（与取消同一个阈值）——碎片是噪音，不是记录。
 * - 不写 `assistant.final` / `character.cue`:事件侧由 `error` 收尾，一个回合出现两个
 *   "结束"会让客户端状态机打架。
 *
 * 落的是**已下发的可见前缀**（`deliveredText`），也就是用户真的看到过的那段字。
 */
/**
 * 失败兜底话术（方案 29 §4.9：fail-open，绝不空白）。
 *
 * 抱怨 #4「经常性的出现输出不了东西了」的直接来源：任何一道校验判失败时，
 * 旧实现只写一条 `error` 事件就 throw，而 `persistFailedPartial` 在"一个字都没
 * 下发"时**直接放弃落消息**——于是界面上什么都没有，像她突然不理人。
 *
 * 三条轮换（按 runId 确定性取，同一轮重投不会换话，也不会连着两轮一模一样）。
 * 口径：只承认"这句没成"并邀请重试，**不编造任何内容、不虚构已完成的事**，
 * 也不暴露 provider / prompt / 错误码。
 */
const COMPANION_FAILURE_FALLBACK_LINES = [
  "诶，这句我没组织好，你再跟我说一次？",
  "刚刚那句话卡住了，我没听清，你再说一遍嘛。",
  "我走神了一下下，这条没答上来，你重新问我一次？",
] as const;

/** 按 runId 确定性挑一句（同一 run 重投得到同一句，避免话术来回跳）。 */
export function pickCompanionFailureFallbackLine(runId: string): string {
  let hash = 0;
  for (const ch of runId) hash = (hash * 31 + ch.charCodeAt(0)) % 1_000_003;
  return COMPANION_FAILURE_FALLBACK_LINES[hash % COMPANION_FAILURE_FALLBACK_LINES.length];
}

export async function persistFailedPartial(args: {
  workspaceId: string;
  userId: string;
  conversationId: string;
  runId: string;
  deliveredText: string;
}): Promise<boolean> {
  // fail-open：已经说出来的半句优先保留；连半句都没有时，落一句诚实的兜底话，
  // 而不是让用户面对空白（旧实现在这里 `return false`，界面什么都不显示）。
  const delivered = args.deliveredText.trim();
  const text = delivered.length >= COMPANION_CANCELLED_MIN_CHARS
    ? delivered
    : pickCompanionFailureFallbackLine(args.runId);
  const blocks = [{ type: "text" as const, text, emotion: resolveReplyToneEmotion(text) }];
  const contentSha256 = sha256Utf8V1(canonicalJsonV1(blocks));
  const messageId = randomUUID();
  try {
    return await withWorkerWorkspaceTransaction(
      { workspaceId: args.workspaceId, userId: args.userId },
      async (tx) => {
        // 先锁住"这一轮确实失败了、且还没留过档"。用 SELECT ... FOR UPDATE 而不是
        // 先写 assistant_message_id：那是指向 companion_messages 的**立即**外键，
        // 消息行还没插进去就回填，整笔事务会被 FK 打回（取消路径踩过这个坑）。
        const claimed = await tx.execute<{ id: string }>(sql`
          SELECT id FROM companion_turn_runs
          WHERE id = ${args.runId} AND status = 'failed' AND assistant_message_id IS NULL
          FOR UPDATE
        `);
        if (!claimed[0]) return false;
        const counters = await tx.execute<{ next_message_seq: string }>(sql`
          UPDATE companion_conversations
          SET next_message_seq = next_message_seq + 1, last_message_at = now()
          WHERE id = ${args.conversationId}
          RETURNING next_message_seq
        `);
        const seqRow = counters[0];
        if (!seqRow) return false;
        await tx.execute(sql`
          INSERT INTO companion_messages
            (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, run_id, content_sha256)
          VALUES (${messageId}, ${args.workspaceId}, ${args.userId},
                  ${args.conversationId}, ${Number(seqRow.next_message_seq) - 1},
                  'assistant', 'error',
                  ${JSON.stringify(blocks)}, ${args.runId}, ${contentSha256})
        `);
        await tx.execute(sql`
          UPDATE companion_turn_runs
          SET assistant_message_id = ${messageId}, updated_at = now()
          WHERE id = ${args.runId}
        `);
        return true;
      },
    );
  } catch (err) {
    // 留档是"别把用户看过的字弄丢"的补救，不是主链路：它失败不该盖掉真正的失败原因。
    logger.warn({ runId: args.runId, err }, "companion failed-partial retention skipped");
    return false;
  }
}

/** 活跃度三档白名单（与 `PetProfileActiveness` 同源）。 */
const ACTIVENESS_VALUES = new Set<string>(["quiet", "moderate", "active"]);

/**
 * boundaries 是 jsonb，库里可能是 null / 数组 / 任意对象。只认"纯对象且键值合法"
 * 的形状，其余一律当没设置——这个对象会被渲染进 system prompt，不能原样透传。
 */
function isPetBoundaryObject(value: unknown): value is PetPersonaPresetBoundaries {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const boolKeys = ["allowPlayful", "allowNudgeLearning", "allowVoiceTags"];
  const known = new Set([...boolKeys, "catchphrase"]);
  if (!Object.keys(record).every((key) => known.has(key))) return false;
  if (!boolKeys.every((key) => record[key] === undefined || typeof record[key] === "boolean")) return false;
  return record.catchphrase === undefined || record.catchphrase === null || typeof record.catchphrase === "string";
}

/** LearningRun 是正式学习页，缺证据时必须 fail closed。 */
export function isGroundedTutorRequestedPageContext(
  pageContext: Record<string, unknown> | null,
): boolean {
  return pageContext?.pageKind === "learning_run"
    && pageContext.requestedCapability === "grounded_tutor";
}

export interface RunPersonaPin {
  /** 本次调用绑定的人格版本号。 */
  revision: number;
  examplesRevision: number;
  defaultExpressionVersion: string;
  /** 绑定的那一版的正文（来自不可变版本行，或首次固定时的账号当前档案）。 */
  content: unknown;
  /** true = 这一次是首次固定（随后要把三个身份字段写回 run）。 */
  fresh: boolean;
}

/**
 * 一个 run 绑定哪一版人格（40 §4.8.4 / 40b §5.3.2 / A50）。
 *
 * ## 两条硬规则，写在这个纯函数里
 *
 * 1. **一次调用使用固定版本。** 已经固定过的 run 只认它自己那个号，正文从那条
 *    **不可变版本行**读；只有首次固定才读账号当前档案，随后把号写回 run，
 *    之后每一轮都走"已固定"分支。于是同一个 run 的第 1 轮与第 40 轮拿到的是
 *    同一份人格，不会因为中途改设置而分属两版。
 *
 * 2. **排队的（待生效）那一版对当前 run 不生效。** 账号人格现在有「当前 / 待生效」
 *    两版（`companion_persona_profiles.pending_revision`）。待生效存在的意义是
 *    "让用户看得见还没生效的那一版"，不是"让某个 run 提前用上它"——合同把它的生效
 *    时点写成"下一次会话建立时"，而这里的判断发生在 run **已经建立之后**。
 *    所以这个函数只认 `currentRevision`，并对 `stagedRevision` 做一次硬断言：
 *    万一将来有人把待生效也当成候选传进来，当场抛错，而不是让用户在一次
 *    已经进行中的对话里被悄悄换掉人格。
 */
export function resolveRunPersonaPin(input: {
  /** run 上已固定的号；null = 这一次还没固定过。 */
  pinnedRevision: number | null;
  pinnedExamplesRevision: number | null;
  pinnedDefaultExpressionVersion: string | null;
  /** 账号当前生效的版本号与正文（只有首次固定时才用得上）。 */
  currentRevision: number | null;
  currentContent: unknown;
  /** 账号排队的待生效版本号（明确不参与本次绑定）。 */
  stagedRevision: number | null;
  /** 已固定那一版的不可变版本行正文。 */
  pinnedContent: unknown;
  currentDefaultExpressionVersion: string;
}): RunPersonaPin {
  const fresh = input.pinnedRevision === null;
  const revision = fresh
    ? Number(input.currentRevision ?? 0)
    : Number(input.pinnedRevision);
  if (input.stagedRevision !== null && revision === input.stagedRevision) {
    throw new Error(
      "companion run must not bind the pending persona revision before it is activated",
    );
  }
  const examplesRevision = fresh
    ? revision
    : Number(input.pinnedExamplesRevision ?? input.pinnedRevision);
  return {
    revision,
    examplesRevision,
    defaultExpressionVersion: fresh
      ? input.currentDefaultExpressionVersion
      : (input.pinnedDefaultExpressionVersion ?? input.currentDefaultExpressionVersion),
    // 首次固定读当前档案；已固定读那一版的不可变版本行（revision 0 = 无覆盖）。
    content: fresh ? (input.currentContent ?? null) : (input.pinnedContent ?? null),
    fresh,
  };
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
  let replaySummaryCoverage: { fromSeq: string | null; throughSeq: string | null; sourceSha256: string | null } | null = null;

  // ── 阶段 1：读（RLS 事务） ────────────────────────────────────────────
  let read: ReadContext | null = null;
  try {
    read = await withWorkerWorkspaceTransaction(
      { workspaceId: ctx.workspaceId, userId: ctx.requestedBy },
      async (tx) => {
        const runRows = await tx.execute<{
          id: string; conversation_id: string; user_id: string; generation: number;
          status: string; page_context: unknown; user_message_id: string;
          account_epoch: string | number | null;
          persona_profile_revision: number | null;
          persona_examples_revision: number | null;
          default_expression_version: string | null;
          context_grant_id: string | null; permission_level: string | null;
          permission_snapshot: unknown; cancel_requested_at: string | null;
        }>(sql`
          SELECT id, conversation_id, user_id, generation, status, page_context, user_message_id,
                 account_epoch, context_grant_id, permission_level, permission_snapshot,
                 persona_profile_revision, persona_examples_revision, default_expression_version,
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
        // 正式作答中就不念出来（doc 34 L15 的另一半）。判据与念头管线同一个来源，
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
        const userRows = await tx.execute<{ blocks: unknown; seq: string }>(sql`
          SELECT blocks, seq::text AS seq FROM companion_messages
          WHERE conversation_id = ${run.conversation_id}
            AND id = ${run.user_message_id}
          ORDER BY seq DESC LIMIT 1
        `);
        const userText = userRows[0] ? textOfCompanionBlocks(userRows[0].blocks) : "";
        const currentUserSeq = userRows[0]?.seq ?? "0";
        // 先在 SQL 排除非对话与失败消息，再按模型真实采用的字符预算裁尾；摘要水位
        // 必须从这份相同的可见尾部计算，不能让 system 注记占掉最近消息名额。
        const historyRows = await readCompanionHistoryRows(tx, run.conversation_id, {
          beforeSeq: currentUserSeq, limit: REPLAY_WINDOW_MESSAGES,
        });
        const recentWithSeq = historyRows
          .slice()
          .reverse()
          .map((m) => ({
            seq: m.seq,
            role: m.role as "user" | "assistant",
            text: companionHistoryText(m),
          }));
        const visibleRecent = boundCompanionRecentHistory(recentWithSeq);
        replayTailSeqs = visibleRecent.map((message) => message.seq ?? null);
        const recentMessages = visibleRecent.map(({ role, text }) => ({ role, text }));
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
        const effectivePersona = resolveCompanionPersonaProfile(petProfileRow);
        const petProfile = {
          name: String(effectivePersona.name ?? "伴星"),
          speakingStyle: String(effectivePersona.speakingStyle ?? ""),
          personalityTags: Array.isArray(effectivePersona.personalityTags)
            ? effectivePersona.personalityTags.map(String)
            : [],
          examples: Array.isArray(effectivePersona.examples)
            ? (effectivePersona.examples as Array<{ text?: unknown }>)
                .map((e) => ({ text: String(e.text ?? "") }))
                .filter((e) => e.text.length > 0)
            : [],
          // 活跃度与边界进对话链路（方案 29 §3.3，抱怨 #2）。取值按契约白名单
          // 收窄，不认识的写 null——宁可当"没设置"也不要把她导向一个不存在的档。
          activeness: ACTIVENESS_VALUES.has(String(effectivePersona.activeness ?? ""))
            ? (effectivePersona.activeness as PetProfileActiveness)
            : null,
          boundaries: isPetBoundaryObject(effectivePersona.boundaries)
            ? effectivePersona.boundaries
            : null,
        };
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
          pageContext: run.page_context,
          userText,
        });
        const hereAndNow = renderHereAndNow(snapshot);
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
        const summaryChain = await readConversationSummaryChain(tx, run.conversation_id, historyStartSeq);
        const summaryRow = summaryChain.head;
        replaySummaryCoverage = summaryRow
          ? {
            fromSeq: summaryRow.coverage_from_seq,
            throughSeq: summaryRow.coverage_through_seq,
            sourceSha256: summaryRow.coverage_source_hash,
          }
          : null;
        const conversationSummary = renderConversationSummary(summaryRow?.summary, {
          coverageVerified: Boolean(
            summaryRow?.coverage_from_seq
            && summaryRow.coverage_through_seq
            && summaryRow.coverage_source_hash,
          ),
          // 链上有洞就如实告诉她：谈那部分之前要先按线索取回原文（44 §5.5）。
          coverageGaps: summaryChain.gaps,
        });
        const toolCallRows = await tx.execute<{
          receipt_id: string; tool_call_id: string; name: string; status: string;
          result_safe_summary: string | null;
        }>(sql`
          SELECT id::text AS receipt_id, tool_call_id, name, status, result_safe_summary
          FROM companion_agent_tool_calls
          WHERE conversation_id = ${run.conversation_id}
          ORDER BY CASE WHEN status IN ('requested', 'executing', 'waiting_confirmation', 'outcome_unknown')
                        THEN 0 ELSE 1 END,
                   updated_at DESC, id DESC
          LIMIT 64
        `);
        const proposalRows = await tx.execute<{
          id: string; status: string; decision: string | null; title: string;
          target_summary: string; result_safe_summary: string | null; expires_at: string;
        }>(sql`
          SELECT id::text AS id, status, decision, title, target_summary,
                 result_safe_summary, expires_at::text AS expires_at
          FROM companion_action_proposals
          WHERE conversation_id = ${run.conversation_id}
          ORDER BY CASE WHEN status IN ('pending', 'executing') THEN 0 ELSE 1 END,
                   updated_at DESC, id DESC
          LIMIT 32
        `);
        return {
          runId: run.id,
          formalAnswerInProgress,
          formalAnswerTarget,
          livePageView: snapshot.livePageView,
          conversationId: run.conversation_id,
          userId: run.user_id,
          userMessageId: run.user_message_id,
          generation: run.generation,
          runStatus: run.status,
          accountEpoch: Number(run.account_epoch ?? 0),
          pageContext: run.page_context,
          contextHandoff: {
            runId: run.id,
            conversationId: run.conversation_id,
            throughMessageSeq: currentUserSeq,
            throughEventSeq: (BigInt(conv.next_event_seq) - 1n).toString(),
            historyStartSeq,
            clippedMessageCount,
            currentRequest: {
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
          actionLedger: toolCallRows.map((action) => ({
            receiptId: action.receipt_id,
            toolCallId: action.tool_call_id,
            name: action.name,
            status: action.status,
            safeSummary: action.result_safe_summary,
          })),
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
          residentMemories,
          memoryDirectory: [],
          // 手册目录与整理结论在 assembleCompanionContext 阶段填；
          // 在此之前它们是"没有"，不是"有但为空"。
          playbookCatalog: [],
          organizationSurface: null,
          memoryRefs: [],
          hereAndNow,
          thisTurnFacts: thisTurnFacts?.block ?? null,
          factSpans: snapshot.factSpans,
          conversationSummary,
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
    await markCompanionRunFailed(read, ctx.workspaceId, "ACTION_STALE", false, "grounded tutor evidence unavailable", "state");
    throw new Error("grounded tutor evidence unavailable");
  }

  // ── 阶段 2：provider（非 active run → 不重复调用） ───────────────────
  if (!isActiveRun(read.runStatus) && !(continuationProposalId && read.runStatus === "waiting_for_confirmation")) {
    logger.info({ runId, status: read.runStatus }, "companion run 非 active，跳过 provider");
    return;
  }
  if (!isCompanionDialogueEnabled()) {
    await markCompanionRunFailed(read, ctx.workspaceId, "INTERNAL_ERROR", false, "feature disabled", "execution");
    throw new Error("COMPANION_DIALOGUE_V1_ENABLED is false — companion dialogue disabled");
  }

  const govCtx = await resolveAIGovernanceContext(ctx.workspaceId, read.userId);
  if (!govCtx.consentOk) {
    await markCompanionRunFailed(
      read,
      ctx.workspaceId,
      "AI_CONSENT_REQUIRED",
      false,
      "workspace AI consent required",
      "state",
    );
    throw new AIConsentRequiredError();
  }
  const contextReceipts = createCompanionContextReceipts();
  // 折叠轨迹收集器：loop 里折了就记，回合结束时并进交接快照的下一版（44 §3.3）。
  const compactionTrace = createCompactionTraceRecorder();
  // 三个 provider 槽（主链路 / 思考档重试 / 跨模型兜底）各自的理由见 companion-turn-providers。
  const { provider, thinkingProvider, fallbackProvider } = resolveCompanionTurnProviders({
    governance: govCtx,
    ctx,
    read,
    contextGate: contextReceipts.pressureGate,
    reserveCall: () => reserveCompanionProviderCall({ ctx, read }),
  });

  // 40 §4.6.6：resident 正文常驻，active 只注入有预算的目录（非 grounded_tutor）。
  const emptyMemoryContext = (): ContextAssemblyResult => ({
    residentMemories: read.residentMemories,
    memoryDirectory: read.memoryDirectory,
    playbookCatalog: [],
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
      read.organizationSurface = memoryContext.organizationSurface;
    } catch (err) {
      // 目录读取失败不阻塞对话：本轮暂不注入长期记忆。
      logger.warn({ jobId: ctx.id, runId: read.runId, err }, "companion memory context assembly skipped");
      memoryContext = emptyMemoryContext();
    }
  }

  const handoffInput = {
    ...(read.contextHandoff ?? {
      runId: read.runId,
      conversationId: read.conversationId,
      throughMessageSeq: "0",
      throughEventSeq: "0",
      historyStartSeq: "0",
      clippedMessageCount: 0,
      currentRequest: { messageId: read.userMessageId, messageSeq: "0", text: read.userText },
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
    proposals: read.proposals ?? [],
    memoryRefs: memoryContext.memoryRefs,
    memoryDirectory: memoryContext.memoryDirectory,
    memorySourceVersions: [] as AgentMemoryContextSourceV1[],
  };
  const handoffDraft = buildCompanionContextHandoffSnapshotV1({
    ...handoffInput,
    modelMessages: [],
  });
  const messages = buildCompanionPersonaMessages({
    scope: { workspaceId: ctx.workspaceId, userId: read.userId },
    methodCatalog: read.groundedTutorContext ? "" : renderPlaybookCatalog(read.playbookCatalog),
    contextReceipt: receipts => {
      contextReceipts.recordAssembly(receipts);
      logger.info({ runId: read.runId, sources: receipts }, "agent context budget receipt");
    },
    userText: read.userText,
    recentMessages: read.recentMessages,
    pageContext: read.pageContext,
    groundedTutorContext: read.groundedTutorContext,
    residentMemories: read.residentMemories,
    memoryDirectory: read.memoryDirectory,
    hereAndNow: read.hereAndNow,
    thisTurnFacts: read.thisTurnFacts,
    factSpans: read.factSpans?.block ?? null,
    conversationSummary: read.conversationSummary,
    continuationData: renderCompanionContextHandoff(handoffDraft),
    petProfile: read.petProfile,
  });
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
      await markCompanionRunFailed(read, ctx.workspaceId, error.code, true, error.message, "execution");
    throw error;
  });
  // A retry must replay the exact committed messages and memory receipt set, even if
  // background memory maintenance changed what a fresh retrieval would return.
  const committedMessages = committedHandoff.snapshot.modelMessages as ChatMessage[];
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
      SELECT pg_notify('ailearn_companion_events_v1',
                       ${JSON.stringify({ conversationId: read.conversationId, maxSeq: seq })})
    `);
  };

  const claimed = await withWorkerWorkspaceTransaction(
    { workspaceId: ctx.workspaceId, userId: read.userId },
    async (tx) => {
      const claimedRow = await tx.execute<{ id: string }>(sql`
        UPDATE companion_turn_runs
        SET status = 'running', started_at = COALESCE(started_at, now())
        WHERE id = ${read.runId}
          AND (
            status IN ('accepted', 'running')
            OR (status = 'waiting_for_confirmation' AND waiting_proposal_id = ${continuationProposalId ?? null})
          )
          AND generation = ${read.generation}
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
        payload: { status: "thinking", safeLabel: "思考中" },
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
  );
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
  const voiceDeliveryDecision = decideCompanionVoiceDelivery({
    voiceDialogueEnabled: voiceSegmentsEnabled,
    formalAnswerInProgress: read.formalAnswerInProgress,
  });
  if (voiceDeliveryDecision === "formal_answer_in_progress") {
    // 这一句是这条门唯一的可查痕迹：没有它，"她今天怎么不念了"只能靠猜。
    logger.info({ runId: read.runId }, "正式作答中：这一轮伴星回复只出文字，不切句也不送合成");
  }
  const emitVisibleVoiceSegments = async (visibleText: string, isFinal: boolean): Promise<void> => {
    // 不是"藏掉播放"：直接不发段事件，于是正文也不会被送去外部合成服务。
    // 上面那句 `voiceSegmentsEnabled` 是另一件事——它是"这一段写失败之后本回合别再试"，
    // 可以在一轮中途被关掉，而正式作答是整轮都不念。
    if (!voiceSegmentsEnabled) return;
    if (voiceDeliveryDecision !== "delivered") return;
    const split = splitCommittedDisplaySegments(visibleText, voiceSegmentState, isFinal);
    voiceSegmentState = split.next;
    if (split.segments.length === 0) return;
    const emotion = resolveReplyToneEmotion(visibleText);
    const cue = buildFinalCuePayload(visibleText);
    const toned = applyDeterministicToneToSegments(
      split.segments.map((segment) => ({
        ordinal: segment.ordinal,
        text: segment.displayText,
        textSha256: sha256Utf8V1(segment.displayText),
      })),
      emotion,
      read.petProfile?.boundaries?.allowVoiceTags !== false,
    );
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
        segments: split.segments.map((segment, index) => {
          const synthesis = toned[index];
          const synthesisText = synthesis?.text ?? segment.displayText;
          const synthesisTextSha256 = synthesis?.textSha256 ?? sha256Utf8V1(synthesisText);
          return {
            version: 2 as const,
            segmentId: companionSegmentId(read.runId, read.generation, segment.ordinal, synthesisTextSha256),
            ordinal: segment.ordinal,
            displayText: segment.displayText,
            displayStart: segment.displayStart,
            displayEnd: segment.displayEnd,
            synthesisText,
            synthesisTextSha256,
            cue,
          };
        }),
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
  const streamingDelivery = createCompanionStreamDelivery({
    job: ctx,
    ctx,
    read,
    expiresAt,
    // 流式下发的每一段都要经过目录渲染，否则用户会先看到 `{{f:today_minutes}}`。
    factSpanValues: read.factSpans?.values ?? {},
    notifyCompanionEvent,
    onVisibleCommitted: async (_committed, visibleText) => emitVisibleVoiceSegments(visibleText, false),
  });
  let assistantText: string;
  let ttsRawText: string | null = null;
  let agentResult;
  try {
    agentResult = await runCompanionAgentLoop({
      ctx,
      read,
      provider,
      thinkingProvider,
      fallbackProvider,
      // 活跃度决定退化闸的字数线（方案 29 §9.17）：不传就等于忽略用户的设置。
      activeness: read.petProfile?.activeness ?? null,
      // 图片能不能出境是**账号级政策**，不是她这一轮可以自己争取的东西：
      // 关着的时候读图工具既不下发也不会执行，她看不见就不会答应去看。
      toolConstraints: { visionEnabled: govCtx.policy.sendImageContent === true },
      baseMessages: committedMessages,
      contextReceipts,
      // 只有组装回放的这一层知道每条尾部消息的来源 seq 与摘要覆盖到哪（44 §5.2）。
      // 折叠是无损的：折掉的每条都被一份校验过的摘要盖住，原文仍在库里按 seq 可读回。
      replayFold: (messages) => {
        const tail = replayTailSeqs.flatMap((seq, index) => (
          seq && messages[index] ? [{ message: messages[index]!, seq }] : []
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
        sourceHash: () => replaySummaryCoverage?.sourceSha256 ?? null,
        latestPressure: () => contextReceipts.latestPressure(),
      }),
      expiresAt,
      continuationProposalId,
      onProviderDelta: (delta) => streamingDelivery.onRawDelta(delta),
      handlerStartedAtMs,
    });
  } catch (err) {
    // 预算耗尽（步数/工具数/执行时间）是确定性失败：标记 recoverable=false，
    // 队列侧同时按不可重试处理，避免空转重投（见 isNonRetryableError）。
    const budgetExceeded = err instanceof CompanionAgentBudgetExceededError;
    const contextChanged = err instanceof CompanionContextChangedError;
    // 交付管线主动叫停（增量校验命中泄露/超限、fence 失联）：同样不可重试——
    // 重投不会让"泄露"消失。已下发的部分必然是最终文本的前缀，客户端按 error 收尾。
    const streamStopped = err instanceof CompanionStreamStoppedError;
    const providerRejected = err instanceof ProviderRequestError;
    const rateLimited = providerRejected && err.status === 429;
    await markCompanionRunFailed(
      read,
      ctx.workspaceId,
      contextChanged ? err.code : budgetExceeded ? "AGENT_BUDGET_EXCEEDED" : rateLimited ? "RATE_LIMITED" : providerRejected ? "PROVIDER_UNAVAILABLE" : "INTERNAL_ERROR",
      !budgetExceeded && !streamStopped && !(providerRejected && [401,402,403].includes(err.status)),
      contextChanged ? err.message : budgetExceeded
        ? "companion agent budget exceeded"
        : streamStopped
          ? `companion stream stopped: ${streamingDelivery.failureReason() ?? "delivery pipeline"}`.slice(0, 240)
          : rateLimited ? "模型服务暂时繁忙，请稍后重试；已经完成的操作仍保留。"
            : providerRejected ? "模型服务暂时无法完成这次请求，已经完成的操作仍保留。"
              : "companion agent execution failed",
      streamStopped ? "delivery" : budgetExceeded || contextChanged ? "execution" : "transport",
    );
    // 她已经说出来的那半句不能随失败一起消失（2026-09-19）。
    await persistFailedPartial({
      workspaceId: ctx.workspaceId,
      userId: read.userId,
      conversationId: read.conversationId,
      runId: read.runId,
      deliveredText: streamingDelivery.deliveredText(),
    });
    throw err;
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
      await emitVisibleVoiceSegments(flushed.text, true);
    }
    return;
  }
  // 定成下游唯一看到的文本（剥信封 → 渲染占位符 → 目录外的键留痕；三步顺序是契约，
  // 理由见 finalizeCompanionReplyText）。
  const finalized = finalizeCompanionReplyText({
    text: agentResult.text, factSpans: read.factSpans?.values ?? null, runId: read.runId,
  });
  ttsRawText = finalized.text;

  // 信任边界：流式期间每个 flush 前都已跑过增量校验（长度/泄露），这里收尾；
  // 校验失败在此终结：已投递的稳定前缀仍在（它是最终文本的前缀），run 按失败收尾。
  const streamed = await streamingDelivery.finish();
  if (!streamed.ok) {
    await markCompanionRunFailed(read, ctx.workspaceId, "INTERNAL_ERROR", false, streamed.reason, "output");
    await persistFailedPartial({
      workspaceId: ctx.workspaceId,
      userId: read.userId,
      conversationId: read.conversationId,
      runId: read.runId,
      deliveredText: streamingDelivery.deliveredText(),
    });
    throw new Error(`companion stream validation failed: ${streamed.reason}`);
  }
  // 全文校验（markdown/标签净化、信封拒绝）必须对完整文本成立；已下发的稳定前缀
  // 必须是最终文本的前缀，否则两条路径漂移——宁可判失败，也不给客户端一个
  // 前后不一致的回复。
  const validated = reconcileStreamedText({
    delivered: streamed.text,
    validated: validateCompanionOutput(ttsRawText),
  });
  if (!validated.ok) {
    // 诊断（2026-09-19）：流式前缀与全文净化不一致时，必须能一眼看出差在哪——
    // 只记长度与首个差异点 + 两小段上下文，不整段落日志。
    if (validated.reason === "stream_full_text_diverged") {
      const deliveredText = streamed.text;
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
    await markCompanionRunFailed(read, ctx.workspaceId, "INTERNAL_ERROR", false, validated.reason, "output");
    await persistFailedPartial({
      workspaceId: ctx.workspaceId,
      userId: read.userId,
      conversationId: read.conversationId,
      runId: read.runId,
      deliveredText: streamingDelivery.deliveredText(),
    });
    throw new Error(`companion output validation failed: ${validated.reason}`);
  }
  // delta 与终态 assistant message 使用同一份净化文本（markdown/标签剥离后），
  // 否则客户端流式渲染的内容与 assistant.final 指向的消息不一致。
  assistantText = validated.text;
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
      await markCompanionRunFailed(read, ctx.workspaceId, err instanceof CompanionContextChangedError ? err.code : "INTERNAL_ERROR",
        true, err instanceof CompanionContextChangedError ? err.message : "companion delta write failed", "delivery");
      throw err;
    }
  } else if (!(await streamingDelivery.writeTail(assistantText))) {
    // 已下发内容与终态文本必须逐字对齐（appendFrom 的基准就是下发长度）。
    await markCompanionRunFailed(read, ctx.workspaceId, "INTERNAL_ERROR", false, "delta_stream_diverged", "delivery");
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
  await emitVisibleVoiceSegments(assistantText, true);

  // ── 阶段 3c：终态事务（message + final + run succeeded） ──
  // 15b：TTS 段已在 delta 过程（流式）或 validate 后（非流式）逐个下发完毕，
  // 终态事务不再携带 segments——事件布局变为 final @ eventStart、cue @ +1、
  // character.cue @ +1。
  const assistantMessageId = randomUUID();
  // 情绪接表情（2026-09-18）：语气层分类结果随消息落库，渲染层据此驱动 Live2D。
  const replyEmotion = resolveReplyToneEmotion(assistantText);
  // 工具带出的跳转块跟在正文之后（方案 29 §4.8）。正文仍是**第一个块**：
  // 按 `blocks[0].text` 取正文的老读法（含下一轮装配 prompt）不受影响，
  // 而 `textOfCompanionBlocks` 只认 text/code/citation，nav 不会污染模型上下文。
  const blocks = [
    { type: "text", text: assistantText, emotion: replyEmotion },
    ...agentResult.blocks.slice(0, 31),
  ];
  const contentSha256 = sha256Utf8V1(canonicalJsonV1(blocks));
  const textSha256 = sha256Utf8V1(assistantText);
  try {
    await withWorkerWorkspaceTransaction(
      { workspaceId: ctx.workspaceId, userId: read.userId },
      async (tx) => {
        await assertCompanionContextSourcesCurrent(tx, { workspaceId: ctx.workspaceId, userId: read.userId }, read.runId);
        const alive = await tx.execute<{ id: string }>(sql`
          UPDATE companion_turn_runs
          SET status = 'running', updated_at = now()
          WHERE id = ${read.runId} AND status IN ('accepted', 'running')
            AND generation = ${read.generation}
          RETURNING id
        `);
        if (!alive[0]) {
          // fence 未命中：run 已不是 active（cancelled / superseded / 并发终态已收尾）。
          //
          // 用户按了"停止"时，气泡里**已经出现过**的字必须留下来——否则取消一发生，
          // 这段内容就从历史里彻底消失（迟到的 assistant.final 被 fence 拒绝，而
          // companion_messages 只在 final 时写入）。这里是全仓**唯一**写 assistant
          // 消息的地方，对话与 agent 两条链路都汇到这里，所以补这一处即可覆盖两者。
          //
          // 落库判据用一条原子 UPDATE：只有 run 的真实终态是 'cancelled' 才留档。
          //   - `superseded`（被用户的新提问顶掉）不落：那一轮由新回合接替，落碎片是噪音；
          //   - 太短不落：1–2 字的碎片进历史是噪音，不是记录（阈值见常量）。
          // 顺带回填 assistant_message_id，让"这条消息属于哪轮 run"在数据里成立。
          if (assistantText.trim().length >= COMPANION_CANCELLED_MIN_CHARS) {
            // 先锁住"确属取消、且还没留过档"的那一行。**不能**先回填
            // `assistant_message_id`：它是指向 `companion_messages` 的立即外键，
            // 消息行还没插就回填会被 FK 打回、整笔终态事务回滚——留档会一声不响地
            // 从未发生过（实机库里 9 个 cancelled run、0 条 cancelled 消息）。
            const cancelled = await tx.execute<{ id: string }>(sql`
              SELECT id FROM companion_turn_runs
              WHERE id = ${read.runId} AND status = 'cancelled' AND assistant_message_id IS NULL
              FOR UPDATE
            `);
            if (cancelled[0]) {
              const partialCounters = await tx.execute<{ next_message_seq: string }>(sql`
                UPDATE companion_conversations
                SET next_message_seq = next_message_seq + 1, last_message_at = now()
                WHERE id = ${read.conversationId}
                RETURNING next_message_seq
              `);
              const partialSeqRow = partialCounters[0];
              if (partialSeqRow) {
                // blocks 与 contentSha256 直接复用成功路径算好的那份：两条路径
                // 必须是同一套散列口径，否则同一段文本在库里有两个 contentSha256。
                // 不写 assistant.final / character.cue：run 已是终态，事件侧由 cancel
                // 那条 turn.cancelled 收尾——一个回合出现两个"结束"会让客户端状态机打架。
                await tx.execute(sql`
                  INSERT INTO companion_messages
                    (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, run_id, content_sha256)
                  VALUES (${assistantMessageId}, ${ctx.workspaceId}, ${read.userId},
                          ${read.conversationId}, ${Number(partialSeqRow.next_message_seq) - 1},
                          'assistant', 'cancelled',
                          ${JSON.stringify(blocks)}, ${read.runId}, ${contentSha256})
                `);
                await tx.execute(sql`
                  UPDATE companion_turn_runs
                  SET assistant_message_id = ${assistantMessageId}, updated_at = now()
                  WHERE id = ${read.runId}
                `);
              }
            }
          }
          return;
        }

        // 事件布局：final @ eventStart，character.cue @ +1
        //（15b：TTS 段已前置于 delta 过程/validate 后，终态事务不再含 segments）。
        const eventCount = 2; // final + cue
        const counters = await tx.execute<{ next_message_seq: string; next_event_seq: string }>(sql`
          UPDATE companion_conversations
          SET next_message_seq = next_message_seq + 1,
              next_event_seq = next_event_seq + ${eventCount},
              last_message_at = now()
          WHERE id = ${read.conversationId}
          RETURNING next_message_seq, next_event_seq
        `);
        const next = counters[0];
        if (!next) throw new Error("conversation counter update returned no row");
        const messageSeq = Number(next.next_message_seq) - 1;
        const eventStart = Number(next.next_event_seq) - eventCount;

        await tx.execute(sql`
          INSERT INTO companion_messages
            (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, run_id, content_sha256)
          VALUES (${assistantMessageId}, ${ctx.workspaceId}, ${read.userId},
                  ${read.conversationId}, ${messageSeq}, 'assistant', 'text',
                  ${JSON.stringify(blocks)}, ${read.runId}, ${contentSha256})
        `);

        await tx.execute(sql`
          INSERT INTO companion_stream_events
            (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
          VALUES
            (${read.conversationId}, ${eventStart}, ${ctx.workspaceId}, ${read.userId},
             ${read.runId}, ${read.generation}, ${read.accountEpoch}, 'assistant.final',
             ${JSON.stringify({
               messageId: assistantMessageId,
               textLength: assistantText.length,
               textSha256,
               messageContentSha256: contentSha256,
               ...(memoryContext.memoryRefs.length > 0
                 ? { memoryRefs: memoryContext.memoryRefs }
                 : {}),
             })}, ${expiresAt})
        `);

        // §11.3 voice.segment.ready（15b：已在 delta 过程/validate 后逐个下发，
        // 终态事务不再写段事件；此处仅保留 cue）。

        // 终态回复情绪 cue：本地确定性分类器（soullink MessageReactionClassifier
        // 思路迁移）从全文分类 emotion；中性/空文本回落 explain/neutral/0.30。
        // 分类失败不可能抛错（纯函数），故无需额外兜底分支。
        await insertStreamEvent(tx, {
          conversationId: read.conversationId,
          workspaceId: ctx.workspaceId,
          userId: read.userId,
          runId: read.runId,
          generation: read.generation,
          accountEpoch: read.accountEpoch,
          seq: eventStart + 1,
          type: "character.cue",
          payload: { cue: buildFinalCuePayload(assistantText) },
          expiresAt,
        });

        // run 终态 + prompt 元数据（§9.1：promptVersion 与 hash 一起写入）
        // waiting_proposal_id 必须一并清空：run 已终结，残留的挂起指针会让"仍在
        // 等待确认"的判据在终态 run 上继续成立（续跑与回收扫描都会被它误导）。
        //
        // `AND status IN ('accepted','running')` 是**状态栅栏**，不是装饰：
        // 用户在这几步里点了取消/换了一代，整轮随后就终结了；没有这道 WHERE，
        // 一个迟到的 final 会把 cancelled 覆盖成 succeeded，用户看到的是
        // 「她答完了」而他明明已经打断了（40b §3.3「取消不得落 completed」）。
        // 命中 0 行时下面整段都要让位——所以先取回 id 再继续写事件。
        const finished = await tx.execute<{ id: string }>(sql`
          UPDATE companion_turn_runs
          SET status = 'succeeded',
              assistant_message_id = ${assistantMessageId},
              waiting_proposal_id = NULL,
              provider_id = ${provider.id},
              model_id = ${provider.modelId},
              prompt_version = ${read.groundedTutorContext ? GROUNDED_TUTOR_PROMPT_ID : COMPANION_PERSONA_V7_PROMPT_ID},
              prompt_hash = ${read.groundedTutorContext ? groundedTutorPromptSha256 : COMPANION_PERSONA_V7_SHA256},
              finished_at = now()
          WHERE id = ${read.runId}
            AND status IN ('accepted', 'running')
          RETURNING id
        `);
        if (!finished[0]) {
          // 已经被取消或换代：本轮的正文**不再交付**。
          // 不是失败——取消路径已经写过 turn.cancelled，这里再写一遍会让用户
          // 同时看到"已取消"和一条本该没发出来的回复。
          logger.info(
            { runId: read.runId, jobId: ctx.id },
            "companion final answer dropped: run left the active states",
          );
          return;
        }

        const failureSpanScope = {
          workspaceId: ctx.workspaceId,
          userId: read.userId,
          runId: read.runId,
        };
        await recoverCompanionRunFailureSpanInTransaction(tx, failureSpanScope, "transport");
        await recoverCompanionRunFailureSpanInTransaction(tx, failureSpanScope, "output");
        await recoverCompanionRunFailureSpanInTransaction(tx, failureSpanScope, "delivery");
        await recoverCompanionRunFailureSpanInTransaction(tx, failureSpanScope, "execution");
        await recoverCompanionRunFailureSpanInTransaction(tx, failureSpanScope, "state");
        if (voiceSegmentsWritten) {
          await recoverCompanionRunFailureSpanInTransaction(tx, failureSpanScope, "tts");
        }

        // P5（39b §9.7 / 39d W2-6）：**她自己是泄露源时由服务端记账**。写入门不在她嘴里
        // （她没有一个"我泄露了"的工具），判据是她这句话与本题题面/答案的连续重合，
        // 幂等用现成唯一键 `companion-turn:<本轮 runId>`——job 重试不会记成两次。
        // 两个条件都要：①服务端确有正式题目在进行（拿到冻结的那一版身份）；
        // ②这一轮问的时候人在作答页（实时那一行的 interaction_state）。
        if (read.formalAnswerTarget
          && isFormalAnswerLivePage(read.livePageView, read.formalAnswerTarget.runId)) {
          const exposure = assessAnswerExposure({
            replyText: assistantText,
            taskPrompt: read.formalAnswerTarget.taskPrompt,
            publicSummary: read.formalAnswerTarget.publicSummary,
            canonicalAnswer: read.formalAnswerTarget.canonicalAnswer,
          });
          if (exposure) {
            const recorded = await recordCompanionAnswerExposure(tx, {
              workspaceId: ctx.workspaceId,
              userId: read.userId,
              companionRunId: read.runId,
              target: read.formalAnswerTarget,
              kind: exposure.kind,
            });
            // 记不上（撞幂等键）与记上了一样要留痕：这条读数是"绕过有没有真的被堵住"的唯一证据。
            logger.info(
              {
                runId: read.runId, kind: exposure.kind,
                overlapChars: exposure.overlapChars, promptCoverage: Number(exposure.promptCoverage.toFixed(2)),
                recorded,
              },
              "companion answer exposure ledger",
            );
          }
        }

        // 22 方案：终态事务内异步入队记忆提取/摘要任务。
        await enqueueCompanionMemoryJobs(tx, {
          workspaceId: ctx.workspaceId,
          userId: read.userId,
          runId: read.runId,
          conversationId: read.conversationId,
          messageSeq,
        });

        // 终态事务：该 run 全部 event 的 expires_at 原子改为 finished_at+24h
        await tx.execute(sql`
          UPDATE companion_stream_events
          SET expires_at = ${expiresAt}
          WHERE conversation_id = ${read.conversationId} AND run_id = ${read.runId}
        `);

        // §5.4 PostgreSQL wake-up（payload 只含 conversationId/maxSeq）。
        const maxSeq = eventStart + eventCount - 1;
        await notifyCompanionEvent(tx, maxSeq);
        logger.info(
          { runId: read.runId, messageId: assistantMessageId, seq: messageSeq },
          "companion dialogue run succeeded",
        );
      },
    );
    // §10.5 关系状态：对话成功完成一次 turn，familiarity +0.01（上限 1）、
    // interaction_count +1、刷新 last_active_at。独立事务 + 失败静默：
    // 关系状态是弱事实，绝不影响对话主链路（迁移 0178 前该 UPDATE 无权限也安全跳过）。
    try {
      await withWorkerWorkspaceTransaction(
        { workspaceId: ctx.workspaceId, userId: read.userId },
        async (tx) => {
          await tx.execute(sql`
            INSERT INTO pet_profiles (workspace_id, user_id, familiarity, interaction_count, last_active_at)
            VALUES (${ctx.workspaceId}, ${read.userId}, 0.01, 1, now())
            ON CONFLICT (workspace_id, user_id) DO UPDATE
            SET familiarity = LEAST(pet_profiles.familiarity + 0.01, 1),
                interaction_count = pet_profiles.interaction_count + 1,
                last_active_at = now(),
                updated_at = now()
          `);
        },
      );
    } catch (err) {
      logger.debug({ runId: read.runId, err }, "companion relationship bump skipped");
    }
  } catch (err) {
    // 写阶段失败：终态事务回滚，但前面已落库的 delta 仍然存在；显式
    // 投影 failed/error，避免 job retry/dead-letter 后 run 永久停在 running。
    logger.warn({ jobId: ctx.id, runId, err }, "companion_agent write phase failed");
    await markCompanionRunFailed(read, ctx.workspaceId, err instanceof CompanionContextChangedError ? err.code : "INTERNAL_ERROR",
      true, err instanceof CompanionContextChangedError ? err.message : "companion response commit failed", "delivery");
    await persistFailedPartial({
      workspaceId: ctx.workspaceId,
      userId: read.userId,
      conversationId: read.conversationId,
      runId: read.runId,
      deliveredText: streamingDelivery.deliveredText(),
    });
    throw err;
  }
}
