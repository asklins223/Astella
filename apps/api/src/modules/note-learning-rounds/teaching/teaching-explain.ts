/** Teaching kernel: real model in production, explicit deterministic provider in offline tests.
 * Saved note-version blocks are frozen before external calls. Explanations do not
 * award mastery; proposed practice targets require a separate grounding check.
 * The persisted attempt ledger owns round budgets, including failed calls.
 */
import { randomUUID } from "node:crypto";
import { asc, and, eq } from "drizzle-orm";
import type { ApiTransaction } from "../../../db/client.ts";
import { noteBlocks, noteVersions } from "@astella/shared/db-schema/note";
import {
  runAiTask,
  type AiStepResult,
  type AiTaskDefinition,
} from "@astella/shared/ai-task-kernel";
import type { RoundTeachingContentV1 } from "@astella/shared/note-learning-round-contracts";
import type { RoundTargetDraft } from "./round-target-contract.ts";
import type { NoteReflectionTeachingSnapshotV1 } from "@astella/shared/note-learning-reflection-contracts";
import type { RoundSuspectClaimV1 } from "@astella/shared/note-learning-round-contracts";
import type { SuspectClaimRecheckTargetV1 } from "../suspect-claim-recheck.ts";

export const NOTE_TEACHING_EXPLAIN_TASK_ID = "note_teaching_explain_v1";
export const NOTE_TEACHING_EXPLAIN_TASK_VERSION = 3;
/** 提示词与输出合同的版本（回执与审计用）。 */
export const NOTE_TEACHING_EXPLAIN_PROMPT_VERSION = "note-teaching-explain-v3";

/**
 * 快照正文块（**引用，不带别的**）：`ordinal` 是它在快照里的位置，也是产物行
 * `source_block_ordinals` 记的那个数——依据要能点开定位到那一块。
 */
export type TeachingExplainBlockV1 = { ordinal: number; type: string; text: string; blockId?: string };

/** 任务输入：本轮问题 ＋ 最新计划 ＋ 快照正文块（＋ 形状提示由块自带的 `type` 给出）。 */
export type TeachingExplainInputV1 = {
  drivingQuestion: string;
  /** 最新一版计划的步骤文字（0283）；没有计划就是空数组。 */
  planSteps: string[];
  blocks: TeachingExplainBlockV1[];
  /** Explicitly selected private notes; contextual only, never evidence for targets. */
  personalSources?: NoteReflectionTeachingSnapshotV1[];
  /** Previously flagged units whose exact quoted source slice changed in this note version. */
  suspectRechecks?: SuspectClaimRecheckTargetV1[];
  /** Warnings stay visible until a matching rechecked unit is independently accepted. */
  pendingSuspectClaims?: RoundSuspectClaimV1[];
  /** Server-read observation for a requested follow-up explanation; never grading evidence. */
  practiceObservation?: {
    outcome: "partial" | "needs_repair" | "declared_unable" | "practice_completed";
    gapFacets: Array<"recall" | "paraphrase" | "explain" | "example" | "apply" | "boundary" | "procedure" | "relate" | "repair">;
  };
};

/** Material-only input allowed at the formal grounding and target-freeze boundary. */
export type TeachingEvidenceInputV1 = Pick<TeachingExplainInputV1, "drivingQuestion" | "planSteps" | "blocks">;

export type TeachingExplainOutputV1 = RoundTeachingContentV1 & {
  sourceBlockOrdinals: number[];
  target?: RoundTargetDraft | null;
  /** A proposed public task setting, held privately until an independent check approves it. */
  applicationScenario?: string | null;
};

/**
 * provider 端口：把"怎么生成"与"什么时候允许再花一次钱"分开（内核只管后者）。
 * 返回 `AiStepResult` 而不是裸值——失败分类（可重试／不可重试）是 provider 的知识，
 * 内核按 `AI_TASK_RETRYABLE_FAILURE_CLASSES` 决定要不要再试。
 */
export type TeachingExplainProviderV1 = (
  input: TeachingExplainInputV1,
  step: { readonly signal: AbortSignal; readonly scope: TeachingExplainScope },
) => Promise<AiStepResult<TeachingExplainOutputV1>>;

/**
 * 这一次外发是谁发起的。
 *
 * 它跟着 step 走而不是跟着 provider 的构造走：provider 实例在路由里是**长驻**的，
 * 而 scope 是每一次调用的真实值（同一进程里服务多个用户）。把它固定在构造期，
 * 就会变成"用上一个用户的身份给下一个用户外发"——而那正是治理出口要挡的东西。
 */
export interface TeachingExplainScope {
  readonly workspaceId: string;
  readonly userId: string;
}

/**
 * 「这一段正文说的是什么」的可读化：只做最小的一层标记剥离。
 *
 * 2026-09-29（P2-15）：实现搬到 `@astella/shared` 的
 * `plainTextForGroundingV1`（逐字相同的 11 行，此前在这个文件里重写了一遍）。
 * 同一个目录下 `routes.ts` 早就在 import shared 那份——两份的规则必须逐字一致，
 * 差一个正则就会让"带 `**` 的同一段话"在两条路上算成不同的东西。
 *
 * 本文件保留的只是名字：`plainTextOfBlockV1` 在教学侧被叫了五年，
 * 改名的收益不抵动 5 处调用点 + 1 个测试的成本。
 */
import { plainTextForGroundingV1 as plainTextOfBlockV1 } from "@astella/shared/note-dynamic-artifact/round-artifact-measure";

export { plainTextOfBlockV1 };
/** 确定性输出的单段上限：够说清一件事，又不至于把整节抄进来。 */
const DETERMINISTIC_TEXT_LIMIT_V1 = 600;
/** 一节最多引用几块正文（合同上限 200 是形状上的界，这里给的是产品上的克制）。 */
const DETERMINISTIC_SECTION_BLOCK_LIMIT_V1 = 12;

function clip(text: string): string {
  if (text.length <= DETERMINISTIC_TEXT_LIMIT_V1) return text;
  return `${text.slice(0, DETERMINISTIC_TEXT_LIMIT_V1 - 1)}…`;
}

const EXAMPLE_MARKERS = ["例如", "比如", "举例", "示例", "举个例子"] as const;

export function isTeachingExampleV1(text: string): boolean {
  return EXAMPLE_MARKERS.some((marker) => text.includes(marker));
}

/**
 * 确定性解释（纯函数）：**只从材料里取**，不生成新材料。
 *
 * 选节规则（按优先级，都是"材料里看得见的东西"）：
 *  1. 问句里点名了某一节（"先弄懂「X」这一节"）⇒ 取标题为 X 的那一节；
 *  2. 否则取第一个小节；
 *  3. 全篇没有小节 ⇒ 从第一块可读正文开始，取到上限为止。
 *
 * 拼不出可用材料时返回 `null`（调用方按"这一篇现在没有可讲的正文"如实处理，
 * 不用一句编出来的话把它盖过去）。
 */
export function buildDeterministicTeachingV1(
  input: TeachingExplainInputV1,
): TeachingExplainOutputV1 | null {
  const readable = input.blocks
    .map((block) => ({ ...block, plain: plainTextOfBlockV1(block.text) }))
    .filter((block) => block.plain.length > 0);
  if (readable.length === 0) return null;

  const headings = readable.filter((block) => block.type === "heading");
  // 标题里以整篇题名开头的那些不算"收窄了方向"的小节吗？——那是笔记页选句那条判据的
  // 规矩（W4-3），这里不套用：解释的对象就是问句点名的那一节，只要它在材料里就取。
  const named = headings
    .filter((heading) => input.drivingQuestion.includes(heading.plain))
    .sort((a, b) => b.plain.length - a.plain.length)[0];
  const target = named ?? headings[0] ?? null;

  const sectionStart = target ? readable.indexOf(target) : 0;
  const section = readable
    .slice(sectionStart)
    .slice(0, target ? sectionEndIndex(readable, sectionStart) : DETERMINISTIC_SECTION_BLOCK_LIMIT_V1);
  const body = section.filter((block) => block.type !== "heading");
  const firstBody = body[0];
  if (!target && !firstBody) return null;

  const lead = target ? `「${clip(target.plain)}」这一节说的是：` : "";
  const explanation = firstBody
    ? `${lead}${clip(firstBody.plain)}`
    : `${lead}这一节还没有正文，只有这个小节标题。`;
  const exampleBlock = body.find((block) => block !== firstBody && isTeachingExampleV1(block.plain));
  const used = [target, firstBody, exampleBlock].filter((block): block is NonNullable<typeof block> => Boolean(block));

  return {
    explanation,
    ...(exampleBlock ? { example: clip(exampleBlock.plain) } : {}),
    // 依据按块序去重：同一块不会因为"既是首段又是例子"被记两次。
    sourceBlockOrdinals: [...new Set(used.map((block) => block.ordinal))].sort((a, b) => a - b),
  };
}

/** 从 `start` 往后数到下一个标题为止（不含下一个标题）。 */
function sectionEndIndex(
  blocks: Array<{ type: string }>,
  start: number,
): number {
  for (let index = start + 1; index < blocks.length; index += 1) {
    if (blocks[index]?.type === "heading") return index - start;
  }
  return blocks.length - start;
}

/** 确定性 provider：今天的生产实现。不花模型钱，离线可测。 */
export function deterministicTeachingExplainProviderV1(): TeachingExplainProviderV1 {
  return async (input) => {
    const derived = buildDeterministicTeachingV1(input);
    if (!derived) {
      // 不可重试：材料里没有可讲的东西，重试一百次也一样（内核按失败类别决定不重试）。
      return { ok: false, class: "invalid_input", message: "这一篇现在没有可以用来解释的正文" };
    }
    return { ok: true, output: derived };
  };
}

/**
 * 单步与整任务的时长上界：与评估那一步**同一把尺子**（一次生成＝一次模型调用的量级），
 * 而且都显著小于任何外层租约/请求上界——真模型接进来时不至于把一次用户动作拖过它。
 */
const TEACHING_STEP_TIMEOUT_MS = 55_000;
const TEACHING_TASK_DEADLINE_MS = 110_000;

export type NoteTeachingExplainTaskDepsV1 = {
  provider: TeachingExplainProviderV1;
  /**
   * 本次外发的真实 workspace/user。**必填**：provider 的治理出口按它建，
   * 缺了 scope 就没法证明"谁同意了这笔外发"，因此不留默认值。
   */
  scope: TeachingExplainScope;
  /** 冻结好的输入（路由在短事务里读齐：轮次＋快照块＋最新计划）。 */
  input: TeachingExplainInputV1;
  usageContext?: AiTaskDefinition<TeachingExplainInputV1, TeachingExplainOutputV1>["usageContext"];
  maxModelCalls?: number;
  maxDurationMs?: number;
};

export function createNoteTeachingExplainTaskV1(
  deps: NoteTeachingExplainTaskDepsV1,
): AiTaskDefinition<TeachingExplainInputV1, TeachingExplainOutputV1> {
  return {
    id: NOTE_TEACHING_EXPLAIN_TASK_ID,
    version: NOTE_TEACHING_EXPLAIN_TASK_VERSION,
    mode: "structured",
    // 用户当下在等这一发：走交互名额，不与批量制卡抢（D5 §3 第 2 条）。
    resourceClass: "interactive_ai",
    budget: {
      // Transport retries consume the same reserved call budget.
      maxModelCalls: deps.maxModelCalls ?? 2,
      stepTimeoutMs: Math.min(TEACHING_STEP_TIMEOUT_MS, deps.maxDurationMs ?? TEACHING_TASK_DEADLINE_MS),
      taskDeadlineMs: Math.min(TEACHING_TASK_DEADLINE_MS, deps.maxDurationMs ?? TEACHING_TASK_DEADLINE_MS),
      maxAutoRetries: 1,
    },
    completion: { kind: "structured_parsed" },
    usageContext: deps.usageContext ?? {
      modelId: "deterministic",
      promptVersion: NOTE_TEACHING_EXPLAIN_PROMPT_VERSION,
      resourceClass: "interactive_ai",
    },
    // 输入由路由在短事务里冻结好（轮次＋快照块＋最新计划），`prepare` 原样交出它——
    // 与评估那一步同一形状（`run-critic.ts` 那个 per-call 定义）。它**不在这里读库**：
    // "校验权限与业务版本"那一步在冻结输入的那个事务里已经做过。
    prepare: async () => deps.input,
    execute: async (input, step) => deps.provider(input, { signal: step.signal, scope: deps.scope }),
    // 恒等提交：产物行的写入在路由的第二段短事务里（服务层 `createTeaching`），
    // 内核这一步没有可提交的业务写入——与评估那一步同一分工。
    commit: async (_ctx, _attempt, output) => ({
      outcome: "committed" as const,
      output,
      usage: { modelCalls: 0, promptTokens: 0, completionTokens: 0, elapsedMs: 0, autoRetriesUsed: 0 },
      failure: null,
      preservedValidResult: false,
      resumedFromCheckpoint: false,
      modelCalls: 0,
    }),
  };
}

/** Runs outside database transactions; the route persists the kernel receipt and call count. */
export async function runTeachingExplainV1(options: {
  provider: TeachingExplainProviderV1;
  input: TeachingExplainInputV1;
  scope: { workspaceId: string; userId: string };
  round: { roundId: string; noteVersionId: string; sourceContentHash: string };
  /** 这一条产物的轮内序号（= 已生成条数 + 1），进幂等键。 */
  ordinal: number;
  currentActiveTransaction: () => unknown;
  reportDevelopmentError?: (message: string) => void;
  modelId?: string;
  maxModelCalls?: number;
  maxDurationMs?: number;
  attemptId?: string;
}): Promise<AiStepResult<TeachingExplainOutputV1> & { attemptRef: string; modelCalls: number }> {
  const task = createNoteTeachingExplainTaskV1({ provider: options.provider, input: options.input,
    scope: options.scope,
    maxModelCalls: options.maxModelCalls, maxDurationMs: options.maxDurationMs,
    usageContext: { modelId: options.modelId ?? "deterministic", promptVersion: NOTE_TEACHING_EXPLAIN_PROMPT_VERSION,
      resourceClass: "interactive_ai" } });
  const receipt = await runAiTask(task, {
    ctx: {
      workspaceId: options.scope.workspaceId,
      userId: options.scope.userId,
      inputSnapshotRef: {
        // 输入快照就是这一轮冻结的那一版正文（D3 §2：版本 id 与哈希一起给）。
        kind: "note_version",
        id: options.round.noteVersionId,
        hash: options.round.sourceContentHash,
      },
      permissionLevel: "server",
    },
    attempt: {
      taskId: task.id,
      taskVersion: task.version,
      attemptId: options.attemptId ?? randomUUID(),
      leaseToken: `note-round:${options.round.roundId}`,
      idempotencyKey: `round:${options.round.roundId}:explain:${options.round.sourceContentHash}:${options.ordinal}`,
      workspaceId: options.scope.workspaceId,
      userId: options.scope.userId,
    },
    currentActiveTransaction: options.currentActiveTransaction,
    reportDevelopmentError: options.reportDevelopmentError,
  });

  if (receipt.outcome !== "committed" && receipt.outcome !== "resumed_and_committed") {
    const failure = receipt.failure ?? { ok: false as const, class: "transport" as const, message: receipt.outcome };
    return { ...failure, attemptRef: `${task.id}@v${task.version}:${receipt.outcome}`, modelCalls: receipt.modelCalls };
  }
  if (!receipt.output) {
    return {
      ok: false,
      class: "transport",
      message: "内核回执说提交了，却没有输出",
      attemptRef: `${task.id}@v${task.version}:empty`,
      modelCalls: receipt.modelCalls,
    };
  }
  return { ok: true, output: receipt.output, attemptRef: `${task.id}@v${task.version}`, modelCalls: receipt.modelCalls };
}

/**
 * 生成失败/不可生成时的对外形状（纯函数：三种类别各有一条用例，不必真造 provider 故障）。
 *
 * 两类话必须分开说（39 §6.2）：**材料里没有可讲的东西**是"这一篇现在没有可以用来解释的
 * 正文"（换一次请求也一样，不该让用户等）；**provider 那边没成**是"这次没生成，
 * 已经有的内容不受影响"（可以稍后再试）。把它们都说成"失败了"是最坏的一种误报。
 */
export function teachingFailureResponseV1(failure: { class: string; message: string }): {
  status: 409 | 503;
  error: string;
  message: string;
} {
  if (failure.class === "invalid_input" && failure.message !== "teaching_model_unconfigured") {
    return {
      status: 409,
      error: "teaching_material_missing",
      message: "这一篇现在没有可以用来解释的正文",
    };
  }
  return {
    status: 503,
    error: "teaching_failed",
    message: "这次解释没有生成；已经有的内容不受影响，可以稍后再试。",
  };
}

/**
 * 读出这一轮快照的那一版正文块（按 `ordinal` 升序）。
 *
 * 读的是**快照指向的那一版**（`round.noteVersionId`），不是"现在这一版"——
 * D3 §5：内容变了就不复用旧产物，而"这次解释按哪一版做的"由快照哈希回答。
 */
export async function loadTeachingSnapshotBlocks(
  tx: ApiTransaction,
  workspaceId: string,
  versionId: string,
): Promise<TeachingExplainBlockV1[]> {
  const [version] = await tx.select({ content: noteVersions.contentJson }).from(noteVersions)
    .where(and(eq(noteVersions.id, versionId), eq(noteVersions.workspaceId, workspaceId))).limit(1);
  const content = version?.content as { blocks?: Array<{ type?: unknown; content?: unknown }> } | undefined;
  const frozen = (Array.isArray(content?.blocks) ? content.blocks : []).map((block, index) => ({
    ordinal: index + 1, type: typeof block.type === "string" ? block.type : "paragraph",
    text: typeof block.content === "string" ? block.content : "",
  }));
  const rows = await tx
    .select({ blockId: noteBlocks.id, ordinal: noteBlocks.ordinal, type: noteBlocks.type, content: noteBlocks.content })
    .from(noteBlocks)
    .where(and(eq(noteBlocks.versionId, versionId), eq(noteBlocks.workspaceId, workspaceId)))
    .orderBy(asc(noteBlocks.ordinal));
  // note_blocks follow the live editing document. Only content_json is the saved
  // immutable version; attach a locator only when the live row still matches it.
  return frozen.map((block) => ({ ...block, blockId: rows.find((row) => row.ordinal === block.ordinal
    && row.content === block.text && row.type === block.type)?.blockId }));
}
