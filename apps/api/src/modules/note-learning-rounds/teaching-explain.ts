/**
 * 教学产物：解释生成（39d W4-6 刀一；内核任务 `note_teaching_explain_v1`）。
 *
 * 这一刀只做"解释＋示例"的文字表达，**确定性 provider 先行**（离线可测、不花模型钱）；
 * 真模型（按知识形态选表达方式、动态产物）在后续刀里接同一个任务定义——换的是 provider，
 * 不是外壳。四条边界先钉死（见 [39d-w46](./39d-w46-teaching-flow-slices-2026-09-26.md) §1）：
 *
 *   1. **解释不判分**：这里只产出解释与示例，不产生 LearningRun、不产生能力证据、
 *      不进调度（W4-3 ⑥ 的 A 否决案继续成立：拿笔记原文当标准答案＝把复述当能力判定）。
 *   2. **产物绑定快照**：输入里的正文块来自轮次行上那份不可改写的快照
 *      （`noteVersionId` + `sourceContentHash`），依据块序号是**快照里的定位**。
 *   3. **例子里只说材料里有的**：确定性 provider 的 `example` 只从材料里取（含
 *      "例如／比如／举例"的那一块），拼不出来就没有这一格——不自己编。
 *   4. **预算触顶不是学习失败**：触顶那一档在服务层（`assertTeachingBudgetAvailable`），
 *      这里只负责"生成"本身。
 *
 * 为什么跑在 API 侧（而不是 worker 的 job）：发起它的是用户当下的一次动作
 * （打开教学面、点"开始讲"），它要的是**一次往返内**的答复；与评估那一步同一个理由
 * （`learning_assessments` 也是 API 侧的写）。内核外壳给的是"事务外执行 + 单步超时 +
 * 有界重试 + 尝试身份"，不是"必须进队列"。
 */
import { randomUUID } from "node:crypto";
import { asc, and, eq } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { noteBlocks } from "@ailearn/shared/db-schema/note";
import {
  runAiTask,
  type AiStepResult,
  type AiTaskDefinition,
} from "@ailearn/shared/ai-task-kernel";
import type { RoundTeachingContentV1 } from "@ailearn/shared/note-learning-round-contracts";

export const NOTE_TEACHING_EXPLAIN_TASK_ID = "note_teaching_explain_v1";
export const NOTE_TEACHING_EXPLAIN_TASK_VERSION = 1;
/** 提示词与输出合同的版本（回执与审计用；确定性 provider 下它标记的是这一步的形状版本）。 */
export const NOTE_TEACHING_EXPLAIN_PROMPT_VERSION = "note-teaching-explain-v1";

/**
 * 快照正文块（**引用，不带别的**）：`ordinal` 是它在快照里的位置，也是产物行
 * `source_block_ordinals` 记的那个数——依据要能点开定位到那一块。
 */
export type TeachingExplainBlockV1 = { ordinal: number; type: string; text: string };

/** 任务输入：本轮问题 ＋ 最新计划 ＋ 快照正文块（＋ 形状提示由块自带的 `type` 给出）。 */
export type TeachingExplainInputV1 = {
  drivingQuestion: string;
  /** 最新一版计划的步骤文字（0283）；没有计划就是空数组。 */
  planSteps: string[];
  blocks: TeachingExplainBlockV1[];
};

export type TeachingExplainOutputV1 = RoundTeachingContentV1 & { sourceBlockOrdinals: number[] };

/**
 * provider 端口：把"怎么生成"与"什么时候允许再花一次钱"分开（内核只管后者）。
 * 返回 `AiStepResult` 而不是裸值——失败分类（可重试／不可重试）是 provider 的知识，
 * 内核按 `AI_TASK_RETRYABLE_FAILURE_CLASSES` 决定要不要再试。
 */
export type TeachingExplainProviderV1 = (
  input: TeachingExplainInputV1,
  step: { readonly signal: AbortSignal },
) => Promise<AiStepResult<TeachingExplainOutputV1>>;

/**
 * 「这一段正文说的是什么」的可读化：只做最小的一层标记剥离。
 *
 * 为什么在服务端也要一份：确定性 provider 要把材料原文拼进解释，带着 `**` 上屏
 * 就是"同一句话两处显示不一样"（W4-3 那一刀在问句上踩过同形返工）。这一份**不是**
 * 渲染层 `noteInlineDisplayText` 的替代（那边才是唯一权威），它只求"不把标记符号
 * 端给用户"；真模型那一刀进来后，材料以纯文本进提示词，这一层仍要留着。
 */
export function plainTextOfBlockV1(content: string): string {
  return content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/`{1,3}/g, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

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
  /** 冻结好的输入（路由在短事务里读齐：轮次＋快照块＋最新计划）。 */
  input: TeachingExplainInputV1;
  usageContext?: AiTaskDefinition<TeachingExplainInputV1, TeachingExplainOutputV1>["usageContext"];
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
      // 今天确定性 provider 不调模型；这个数按"接真模型时一次生成＋一次结构修复"给。
      maxModelCalls: 2,
      stepTimeoutMs: TEACHING_STEP_TIMEOUT_MS,
      taskDeadlineMs: TEACHING_TASK_DEADLINE_MS,
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
    execute: async (input, step) => deps.provider(input, { signal: step.signal }),
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

/**
 * 跑一次"生成解释"的内核任务（**事务外**：内核自己会核当前作用域有没有活动事务，
 * W3-2 第三刀那道闸门对这条链同样生效）。
 *
 * 幂等键＝`round:{roundId}:explain:{snapshotHash}:{ordinal}`（W4-6 刀一的约定）：
 * 同快照同序号复用，不重付模型钱。今天"要不要复用"由服务层预读决定（重复请求根本
 * 不走这里），所以没有挂检查点端口；接真模型那一刀再按内核回执把检查点落到它自己的
 * 物理形状上（W3-3 已经把那个形状定在 `jobs.payload`，而这一条链今天没有 jobs 行）。
 */
export async function runTeachingExplainV1(options: {
  provider: TeachingExplainProviderV1;
  input: TeachingExplainInputV1;
  scope: { workspaceId: string; userId: string };
  round: { roundId: string; noteVersionId: string; sourceContentHash: string };
  /** 这一条产物的轮内序号（= 已生成条数 + 1），进幂等键。 */
  ordinal: number;
  currentActiveTransaction: () => unknown;
  reportDevelopmentError?: (message: string) => void;
}): Promise<AiStepResult<TeachingExplainOutputV1> & { attemptRef: string }> {
  const task = createNoteTeachingExplainTaskV1({ provider: options.provider, input: options.input });
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
      attemptId: randomUUID(),
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
    return { ...failure, attemptRef: `${task.id}@v${task.version}:${receipt.outcome}` };
  }
  if (!receipt.output) {
    return {
      ok: false,
      class: "transport",
      message: "内核回执说提交了，却没有输出",
      attemptRef: `${task.id}@v${task.version}:empty`,
    };
  }
  return { ok: true, output: receipt.output, attemptRef: `${task.id}@v${task.version}` };
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
  if (failure.class === "invalid_input") {
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
  const rows = await tx
    .select({ ordinal: noteBlocks.ordinal, type: noteBlocks.type, content: noteBlocks.content })
    .from(noteBlocks)
    .where(and(eq(noteBlocks.versionId, versionId), eq(noteBlocks.workspaceId, workspaceId)))
    .orderBy(asc(noteBlocks.ordinal));
  return rows.map((row) => ({ ordinal: row.ordinal, type: row.type, text: row.content }));
}
