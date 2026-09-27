/**
 * 制卡简化链（V3）的**任务定义工厂**（39d W7-1 刀a；39c §6.1–6.2）。
 *
 * 两次语义调用的那两次：`card_generate_v3`（选目标＋出候选草稿，一次）与
 * `card_content_check_v3`（批量内容检查，一次）。合同在
 * `@ailearn/shared/card-generation-v3-contracts`；本模块只做三件事：
 *
 *   1. **提示词组装**（纯函数）：把服务端准备好的输入（快照正文块、可用依据 id、
 *      已有目标、用户请求、预算上限）拼成要求按合同 JSON 回答的提示。
 *   2. **草稿级程序校验**（纯函数）：合同 zod 之外、只有整批上下文才判得出的两件
 *      ——重复 `objectiveLocalId`、超出本 run 候选上限。依据是否越界**不在这里判**：
 *      那条判据已由 `runCandidateDeterministicGatesV2` 的 `evidenceSpanGate` 承担
 *      （冻结 code `evidence_not_in_sealed_scope`），在组装之后跑一次，见
 *      `plan-assembly.ts` 的 `runCardGenerateV3ProgramChecks`。
 *   3. **任务外壳**（工厂）：execute = 组提示 → provider 端口 → 按合同解析（解析
 *      失败归类 output_shape）→ 盖章与程序校验。
 *      prepare/commit 由调用方注入——生产接线（刀b）给 DB 版本，单测给内存版本。
 *      **注意**：output_shape 在内核那张表里是"可重试"的，可这条链的生产接线直接调
 *      `execute`（没有 `runAiTask`），所以那一发不会自动重试；`budget` 今天只是声明。
 *
 * **端口只有一条**：`complete({ prompt, input })`。确定性版本（`deterministic.ts`）
 * 与真模型版本实现同一个端口，因此两条路走的是同一段 execute、同一次解析、同一份
 * 校验——不是"测试跑一条捷径、生产跑另一条"。
 *
 * 模型调用计数是 §16.28 的判据：普通短文本成功路径**恰好 2 次**（每任务 1 次）。
 * 失败路径今天**不**在这里加次数——没有内核在跑，output_shape 不会自动重试一次，
 * 而是整发抛给分发点按可重试分类重投（重投不重付的那一段只覆盖已提交的计划）。
 */
import {
  cardCandidateRewriteV3OutputSchema,
  cardContentCheckV3OutputSchema,
  cardGenerateV3CandidateDraftSchema,
  cardGenerateV3ObjectiveProposalSchema,
  cardGenerateV3OutputSchema,
  type CardCandidateRewriteV3Output,
  type CardContentCheckV3Output,
  type CardGenerateV3CandidateDraft,
  type CardGenerateV3Output,
} from "@ailearn/shared/card-generation-v3-contracts";
import type {
  CardHintPairV2,
  LearningCardCandidateRevisionV2,
} from "@ailearn/shared/card-generation-v2-contracts";
// 词表的**那一份数组**（不是类型）：提示词里必须把合法取值逐字列出来，而列第二份就会和
// 合同分叉——2026-09-27 第一发真模型栽的正是这一格。
import {
  computeGroundingReportHashV2,
  extractAnswerText,
  runDeterministicGroundingContract,
  type AssemblerEvidenceManifest,
} from "@ailearn/shared/card-generation-v2-pipeline";
import type {
  AiAttemptToken,
  AiTaskBudget,
  AiTaskContext,
  AiTaskDefinition,
  AiStepResult,
} from "@ailearn/shared/ai-task-kernel";
import type {
  CardContentCheckV3TaskOutput,
  CardGenerateV3DroppedCandidate,
  CardGenerateV3TaskOutput,
} from "./output-types.ts";

/** execute 的解析失败形状（内核 AiStepFailure 的结构复刻）。 */
interface ParseFailure {
  readonly ok: false;
  readonly class: "output_shape";
  readonly message: string;
}

/** 一次语义调用的端口：确定性版与真模型版各实现一份。 */
export interface CardGenerationV3ProviderPort<TInput> {
  readonly modelId: string;
  /** 确定性实现可以不看 prompt 只看 input；真模型实现把 prompt 发出去。 */
  complete(request: {
    prompt: string;
    input: TInput;
    signal?: AbortSignal;
  }): Promise<{ text: string; promptTokens?: number; completionTokens?: number }>;
}

// ── ① 生成任务 ──────────────────────────────────────────────────────────

export interface CardGenerateV3TaskInput {
  readonly runId: string;
  readonly noteTitle: string;
  /**
   * 快照正文块（0282 快照引用的那一版；D3：只引用不内联）。
   *
   * `blockId` 是 note_blocks 的真 id：依据（sealed manifest）按块挂，原子也按块抽，
   * 这里只给序号的话，"这一句出自哪一块"就只能在提示词里说说，落不了地。
   */
  readonly noteBlocks: ReadonlyArray<{
    readonly blockId: string;
    readonly ordinal: number;
    readonly text: string;
  }>;
  /** 已有目标的摘要（39 §8.6 第 1 步："已有本轮目标时复用"）。 */
  readonly existingObjectives: ReadonlyArray<{ readonly objectiveId: string; readonly statement: string }>;
  readonly userRequest: string | null;
  /**
   * sealed manifest 里可用的依据（id ＋它出自哪一块）。
   *
   * 只给 id 清单是不够的：确定性那一版要按"这一句出自哪一块"把依据挂到卡上，
   * 而原子自己不带 evidenceSnapshotId（它认块）。块 id 就在这里。
   */
  readonly evidence: ReadonlyArray<{ readonly evidenceSnapshotId: string; readonly blockId: string }>;
  readonly inputSnapshotHash: string;
  readonly planVersion: number;
  readonly cardContentEpoch: number;
  readonly activationHardMax: number;
}

/**
 * 合同某一层**必须给出的键**，现取不抄：`safeParse(undefined)` 过得了的就是可选项。
 * 用这个判据而不是读 zod 的内部标记——升级 zod 版本时内部标记会变，而"不给行不行"这件事不会。
 */

/**
 * 把一份 zod 合同展开成**逐层的必填清单与取值表**（提示词用）。
 *
 * 为什么必须整个展开而不是补一两格：三发真模型各栽在一层上——`knowledgeForm:"…"`（词没列）
 * → `objectiveDraft:{…完整对象…}`（键没列）→ `preferredTaskIntents[0]`（**再往里一层**没列）。
 * 手补是"报错一层补一层"，每次一发真调用；这一份是"合同里模型要填的每一层一次性说出来"。
 * 判"必填"用 `safeParse(undefined)` 过不过（`.optional()`／可空的会过），不读 zod 内部标记；
 * 递归深度设上限是因为 `relations` 这类会自引用。
 */
function contractSheetV3(node: unknown, path: string, out: string[], depth = 0): void {
  if (depth > 4 || node === null || typeof node !== "object") return;
  const n = node as {
    _def?: { typeName?: string; innerType?: unknown; type?: unknown };
    shape?: Record<string, unknown>; element?: unknown; options?: readonly string[];
  };
  // 这里**只能**按 `_def.typeName` 分派：`instanceof z.ZodObject` 在跨包时恒为假
  // （合同在 `@ailearn/shared` 里用另一份 zod 实例构造），第一次试就输出了空表——
  // 空表比缺这一格更坏，因为它看起来像"已经说清楚了"。
  // 注意只在这里读类型名；"这一格必填吗"仍然用 `safeParse(undefined)` 判，不读内部标记。
  switch (n._def?.typeName) {
    case "ZodOptional":
    case "ZodNullable":
      contractSheetV3(n._def?.innerType ?? null, path, out, depth + 1);
      return;
    case "ZodArray":
      contractSheetV3(n.element, `${path}[]`, out, depth + 1);
      return;
    case "ZodEnum":
      out.push(`${path || "（根）"} 只能取：${(n.options ?? []).join("|")}`);
      return;
    case "ZodObject": {
      const shape = n.shape ?? {};
      const required = Object.entries(shape)
        .filter(([, field]) => (field as { safeParse: (v: unknown) => { success: boolean } })
          .safeParse(undefined).success === false)
        .map(([key]) => key);
      if (path) out.push(`${path} 必填：${required.join("、") || "（这一层没有必填）"}`);
      for (const [key, field] of Object.entries(shape)) {
        contractSheetV3(field, path ? `${path}.${key}` : key, out, depth + 1);
      }
      return;
    }
    case "ZodEffects":
      // `.refine()`/`.transform()` 包着的那一层才是形状本体，剥开继续走。
      contractSheetV3((n as { _def?: { schema?: unknown } })._def?.schema ?? null, path, out, depth + 1);
      return;
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = (n as { options?: unknown[] }).options ?? [];
      out.push(`${path} 取以下任一形状：${options.length} 种`);
      for (const option of options) contractSheetV3(option, `${path}(任一)`, out, depth + 1);
      return;
    }
    case "ZodLiteral":
      // 字面量多半是判别式的取值（`kind:"pairs"` 那一类），不写出来的话，展开成 7 个
      // "必填：kind、items" 的形状对模型等于没说。
      out.push(`${path} 只能取：${String((n as { _def?: { value?: unknown } })._def?.value ?? "")}`);
      return;
    default: {
      // 标量叶子（字符串/数字/布尔）不值得占一行；认不出的**结构**类型才必须喊出来——
      // 静默跳过就等于把那一层留给模型猜，而猜错要等下一次真调用才看得见。
      const scalar = new Set(["ZodString", "ZodNumber", "ZodBoolean", "ZodNull", "ZodDate",
        "ZodNaN", "ZodBigint", "ZodUndefined", "ZodNever", "ZodAny", "ZodUnknown"]);
      const typeName = n._def?.typeName ?? "?";
      if (path && !scalar.has(typeName)) out.push(`${path} 形状未展开（${typeName}）——这一层模型只能猜`);
      return;
    }
  }
}

function contractSheetForV3(schemas: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [root, schema] of Object.entries(schemas)) contractSheetV3(schema, root, lines);
  // 同一层重复出现（数组元素与父对象各报一次）时去重，提示词不要注水。
  return [...new Set(lines)].map((line) => `- ${line}`).join("\n");
}

const CANDIDATE_SHEET_V3 = contractSheetForV3({
  objectiveProposals: cardGenerateV3ObjectiveProposalSchema,
  candidates: cardGenerateV3CandidateDraftSchema,
});

export function buildCardGenerateV3Prompt(input: CardGenerateV3TaskInput): string {
  const blocks = input.noteBlocks
    .map((block) => `[块 ${block.blockId}]\n${block.text}`)
    .join("\n\n");
  const existing = input.existingObjectives.length > 0
    ? input.existingObjectives
      .map((objective) => `- (${objective.objectiveId.slice(0, 8)}…) ${objective.statement}`)
      .join("\n")
    : "（这篇还没有任何目标）";
  const evidence = input.evidence
    .map((entry) => `- ${entry.evidenceSnapshotId}（块 ${entry.blockId}）`)
    .join("\n");
  const request = input.userRequest ?? "（用户没有额外要求）";
  return [
    "你是学习卡制卡助手。下面给出一篇笔记的正文、可用依据、已有目标与用户请求。",
    "请选出最多 " + input.activationHardMax + " 个值得制卡的目标，并为每个目标出一张候选卡的完整草稿。",
    "只依据正文作答；每张卡的 evidenceRefIds 只能从下面的\"可用依据\"里选；",
    "没有值得制卡的内容就返回 no_cards_recommended，不要凑数。",
    "严格按以下 JSON 形状回答（不加任何其他文字）：",
    '{"planIntent":{"kind":"author_candidates","recommendedCardCount":n} 或 ' +
    '{"kind":"no_cards_recommended","reasonCodes":[…}],',
    ' "objectiveProposals":[…], "candidates":[…]}',
    "# 这两块的合同（逐层必填键与合法取值，服务端按同一份 schema 校验；少一格就会被判 output_shape）",
    CANDIDATE_SHEET_V3,
    "（哈希与身份（rubricHash／reportHash／id／strategy）服务端会重算或整批分配，不用自己凑；",
    "evidenceRefIds 只能取下面「可用依据」里出现过的 id。）",
    "",
    `# 笔记标题\n${input.noteTitle}`,
    `# 正文（快照 ${input.inputSnapshotHash.slice(0, 12)}，版本 v${input.planVersion}，内容纪元 ${input.cardContentEpoch}）\n${blocks}`,
    `# 可用依据（evidenceSnapshotId）\n${evidence || "（这一版没有可引用的依据）"}`,
    `# 已有目标\n${existing}`,
    `# 用户请求\n${request}`,
  ].join("\n");
}

/**
 * 草稿级程序校验：只判**必须看到整批**才判得出的两件（重复 localId、超上限）。
 * 依据越界不在这里（见文件头第 2 条），一份判据不在两处各写一遍。
 */
export function validateCardGenerateV3Drafts(
  candidates: readonly CardGenerateV3CandidateDraft[],
  input: { readonly activationHardMax: number },
): { kept: CardGenerateV3CandidateDraft[]; dropped: CardGenerateV3DroppedCandidate[] } {
  const dropped: CardGenerateV3DroppedCandidate[] = [];
  const kept: CardGenerateV3CandidateDraft[] = [];
  const seenLocalIds = new Set<string>();
  for (const candidate of candidates) {
    if (seenLocalIds.has(candidate.objectiveLocalId)) {
      dropped.push({
        objectiveLocalId: candidate.objectiveLocalId,
        reason: "重复的 objectiveLocalId（同批只保留第一张）",
      });
      continue;
    }
    if (kept.length >= input.activationHardMax) {
      dropped.push({
        objectiveLocalId: candidate.objectiveLocalId,
        reason: `超出本 run 的候选上限（${input.activationHardMax}）`,
      });
      continue;
    }
    seenLocalIds.add(candidate.objectiveLocalId);
    kept.push(candidate);
  }
  return { kept, dropped };
}

/** 兼容既有读法的导出（同名旧函数已收窄成"草稿级"）。 */
export const validateCardGenerateV3Output = validateCardGenerateV3Drafts;

/**
 * 三个任务共用的默认预算（调用方可以整份换掉）。
 *
 * **`maxModelCalls: 2` 不是"允许调两次模型"，是"首次＋内核那一次结构修复"这两发**，
 * 与另外三个跑在内核上的任务同一取值（`run-critic`／`teaching-explain`／语音转写都
 * 是 2）。写成 1 会出事而且是安静的：内核在**发出下一次之前**检查调用数预算，于是
 * `maxAutoRetries: 1` 那一发根本没机会花，回执还把它报成 `timeout`／"model call
 * budget reached"——一次合同形状失败被读成了一次超时（2026-09-27 接内核当天量到的）。
 */
const V3_TASK_DEFAULT_BUDGET: AiTaskBudget = {
  maxModelCalls: 2,
  stepTimeoutMs: 120_000,
  taskDeadlineMs: 240_000,
  maxAutoRetries: 1,
};

type GeneratePrepare = AiTaskDefinition<CardGenerateV3TaskInput, CardGenerateV3TaskOutput>["prepare"];

export interface CardGenerateV3TaskDeps {
  readonly provider: CardGenerationV3ProviderPort<CardGenerateV3TaskInput>;
  readonly prepare: GeneratePrepare;
  readonly commit: (ctx: AiTaskContext, attempt: AiAttemptToken, output: CardGenerateV3TaskOutput) => Promise<void>;
  readonly budget?: AiTaskDefinition<CardGenerateV3TaskInput, CardGenerateV3TaskOutput>["budget"];
}

export function createCardGenerateV3Task(
  deps: CardGenerateV3TaskDeps,
): AiTaskDefinition<CardGenerateV3TaskInput, CardGenerateV3TaskOutput> {
  const budget = deps.budget
    ?? V3_TASK_DEFAULT_BUDGET;
  return {
    id: "card_generate_v3",
    version: 1,
    mode: "structured",
    resourceClass: "card_foreground",
    budget,
    completion: { kind: "structured_parsed" },
    usageContext: { modelId: deps.provider.modelId, promptVersion: "card-generate-v3", resourceClass: "card_foreground" },
    prepare: deps.prepare,
    execute: async (input, env): Promise<AiStepResult<CardGenerateV3TaskOutput>> => {
      const completion = await deps.provider.complete({
        prompt: buildCardGenerateV3Prompt(input),
        input,
        signal: env.signal,
      });
      let parsed: CardGenerateV3Output;
      try {
        parsed = cardGenerateV3OutputSchema.parse(JSON.parse(completion.text));
      } catch (error) {
        const failure: ParseFailure = {
          ok: false,
          class: "output_shape",
          message: `生成输出不符合 V3 合同：${(error as Error).message.slice(0, 400)}`,
        };
        return failure;
      }
      const { kept, dropped } = validateCardGenerateV3Drafts(parsed.candidates, input);
      return {
        ok: true,
        output: {
          parsed: kept.length === parsed.candidates.length ? parsed : { ...parsed, candidates: kept },
          droppedCandidates: dropped,
          acceptedCount: kept.length,
        },
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
      };
    },
    commit: async (ctx, attempt, output) => {
      await deps.commit(ctx, attempt, output);
      return {
        outcome: "committed",
        output,
        usage: { modelCalls: 1, promptTokens: 0, completionTokens: 0, elapsedMs: 0, autoRetriesUsed: 0 },
        failure: null,
        preservedValidResult: false,
        resumedFromCheckpoint: false,
        modelCalls: 1,
      };
    },
  };
}

// ── ② 内容检查任务 ──────────────────────────────────────────────────────

/**
 * 检查任务的输入是**组装并过程序校验之后**的候选：它检的是要交给用户的那一份，
 * 不是模型草稿。依据清单一起进来，确定性实现与提示词都读它。
 */
export interface CardContentCheckV3TaskInput {
  readonly runId: string;
  readonly sourceContent: string;
  readonly candidates: ReadonlyArray<{
    readonly objectiveLocalId: string;
    readonly candidate: LearningCardCandidateRevisionV2;
  }>;
  readonly evidenceManifest: AssemblerEvidenceManifest;
}

export function buildCardContentCheckV3Prompt(input: CardContentCheckV3TaskInput): string {
  const manifest = input.evidenceManifest.evidence
    .map((entry) => `- ${entry.evidenceSnapshotId}：${(entry.content ?? "").slice(0, 200)}`)
    .join("\n");
  const candidates = input.candidates
    .map(({ objectiveLocalId, candidate }) => [
      `### 候选 ${objectiveLocalId}`,
      `解释：${candidate.objective.learningSupport.explanation}`,
      `答案：${extractAnswerText(candidate.objective.canonicalAnswer)}`,
      `题面：${candidate.presentation.front.cue} / ${candidate.presentation.front.prompt}`,
    ].join("\n"))
    .join("\n\n");
  return [
    "你是学习卡内容检查助手。对下面每一张候选卡独立判断：",
    '- "keep"：依据支持、答案可用、题面清楚——可交给用户保留；',
    '- "rewrite"：内容方向可以但需要改写（说明改什么）；',
    '- "insufficient"：依据不足或存在实质疑点——不得作为标准答案。',
    "每一项都必须带 grounding 报告（对答案单元/教学支撑/关系/评分依据逐项给出 entailed/unsupported 与证据 id）；",
    "证据引用只能用给出的证据 id；身份与哈希字段服务端会重算，不用自己凑。",
    "**每一张候选都要有一条结论**，漏掉一张就等于那张没被检查过。",
    "严格按以下 JSON 形状回答：",
    '{"perCandidate":[{"objectiveLocalId":"id","verdict":"keep|rewrite|insufficient","issues":[{"code":"…","severity":"hard|soft","detail":"…"}],',
    ' "grounding":{…grounding 报告…}}],"setIssues":[]}',
    "",
    `# 依据（sealed manifest）\n${manifest || "（这一版没有可引用的依据）"}`,
    `# 候选\n${candidates}`,
  ].join("\n");
}

/**
 * 服务端盖章：模型给的身份字段一律不采信。
 *
 * 审核页的"可保留"门槛要 binding plan hash，而 binding plan 的组装按候选修订的
 * 身份闭包算——那份闭包只能是服务端的，否则一次改写回答里的错 id 就能把结论挂到
 * 别的候选上。漏检的候选按 `insufficient` 记账（**没检查不等于检查通过**）。
 */
export async function stampCardContentCheckV3Output(
  parsed: CardContentCheckV3Output,
  input: CardContentCheckV3TaskInput,
): Promise<{ stamped: CardContentCheckV3Output; unchecked: string[] }> {
  const byLocalId = new Map(input.candidates.map((entry) => [entry.objectiveLocalId, entry.candidate]));
  const stamped: CardContentCheckV3Output["perCandidate"] = [];
  const seen = new Set<string>();
  for (const entry of parsed.perCandidate) {
    const candidate = byLocalId.get(entry.objectiveLocalId);
    if (!candidate) continue; // 模型凭空多出来的候选：不入库也不给它盖章。
    seen.add(entry.objectiveLocalId);
    const { reportHash: _modelSuppliedHash, ...reportWithoutHash } = entry.grounding;
    const modelHardIssues = entry.issues
      .filter((issue) => issue.severity === "hard")
      .map((issue) => `${issue.code}: ${issue.detail}`);
    const report = {
      ...reportWithoutHash,
      candidateRevisionId: candidate.candidateRevisionId,
      candidateRevisionHash: candidate.candidateRevisionHash,
      evidenceSetHash: candidate.evidenceSetHash,
      evidenceEligibilityVectorHash: candidate.evidenceSetHash,
      inputHash: candidate.evidenceSetHash,
      verdict: entry.verdict === "insufficient" ? ("fail" as const) : ("pass" as const),
      // 判"依据不足"却一条硬问题都没给：结论仍然成立（那张不能交给用户），但报告
      // 不能带着空的 hardIssues 落库——下游按 hardIssues 取证据，空的会被读成"没有
      // 问题"。这里补一条自己的口径，不替模型编内容。
      hardIssues: entry.verdict !== "insufficient"
        ? []
        : (modelHardIssues.length > 0 ? modelHardIssues : ["insufficient_without_hard_issue"]),
    };
    stamped.push({
      ...entry,
      grounding: {
        ...report,
        reportHash: computeGroundingReportHashV2({
          candidateRevisionId: report.candidateRevisionId,
          evidenceSetHash: report.evidenceSetHash,
          verdict: report.verdict,
          hardIssues: report.hardIssues,
        }),
      },
    });
  }
  const unchecked = input.candidates
    .map((entry) => entry.objectiveLocalId)
    .filter((localId) => !seen.has(localId));
  return {
    stamped: {
      perCandidate: [
        ...stamped,
        ...await Promise.all(unchecked.map(async (localId) => {
          const missed = byLocalId.get(localId)!;
          // 底稿用那份确定性报告（它按候选把逐单元的形状填成合同要的样子），
          // 再把结论改写成"没检查过"——这里不另写一份"怎么列答案单元"。
          const base = await runDeterministicGroundingContract(missed, input.evidenceManifest);
          const { reportHash: _baseHash, ...withoutHash } = base;
          return {
            objectiveLocalId: localId,
            verdict: "insufficient" as const,
            issues: [{
              code: "check_missing",
              severity: "hard" as const,
              detail: "批量检查没有给出这一张的结论，按未检查处理",
            }],
            grounding: {
              ...withoutHash,
              verdict: "fail" as const,
              answerUnits: withoutHash.answerUnits.map((unit) => ({
                ...unit,
                verdict: "insufficient" as const,
              })),
              rubricSupport: withoutHash.rubricSupport.map((unit) => ({
                ...unit,
                verdict: "unsupported" as const,
              })),
              hardIssues: ["check_missing"],
              criticVersion: "server-stamped-v3",
              reportHash: computeGroundingReportHashV2({
                candidateRevisionId: withoutHash.candidateRevisionId,
                evidenceSetHash: withoutHash.evidenceSetHash,
                verdict: "fail",
                hardIssues: ["check_missing"],
              }),
            },
          };
        })),
      ],
      setIssues: parsed.setIssues,
    },
    unchecked,
  };
}

type CheckPrepare = AiTaskDefinition<CardContentCheckV3TaskInput, CardContentCheckV3TaskOutput>["prepare"];

export interface CardContentCheckV3TaskDeps {
  readonly provider: CardGenerationV3ProviderPort<CardContentCheckV3TaskInput>;
  readonly prepare: CheckPrepare;
  readonly commit: (ctx: AiTaskContext, attempt: AiAttemptToken, output: CardContentCheckV3TaskOutput) => Promise<void>;
  readonly budget?: AiTaskDefinition<CardContentCheckV3TaskInput, CardContentCheckV3TaskOutput>["budget"];
}

export function createCardContentCheckV3Task(
  deps: CardContentCheckV3TaskDeps,
): AiTaskDefinition<CardContentCheckV3TaskInput, CardContentCheckV3TaskOutput> {
  const budget = deps.budget
    ?? V3_TASK_DEFAULT_BUDGET;
  return {
    id: "card_content_check_v3",
    version: 1,
    mode: "structured",
    resourceClass: "card_foreground",
    budget,
    completion: { kind: "structured_parsed" },
    usageContext: { modelId: deps.provider.modelId, promptVersion: "card-check-v3", resourceClass: "card_foreground" },
    prepare: deps.prepare,
    execute: async (input, env): Promise<AiStepResult<CardContentCheckV3TaskOutput>> => {
      const completion = await deps.provider.complete({
        prompt: buildCardContentCheckV3Prompt(input),
        input,
        signal: env.signal,
      });
      let parsed: CardContentCheckV3Output;
      try {
        parsed = cardContentCheckV3OutputSchema.parse(JSON.parse(completion.text));
      } catch (error) {
        const failure: ParseFailure = {
          ok: false,
          class: "output_shape",
          message: `检查输出不符合 V3 合同：${(error as Error).message.slice(0, 400)}`,
        };
        return failure;
      }
      const { stamped, unchecked } = await stampCardContentCheckV3Output(parsed, input);
      return {
        ok: true,
        output: { parsed: stamped, unchecked },
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
      };
    },
    commit: async (ctx, attempt, output) => {
      await deps.commit(ctx, attempt, output);
      return {
        outcome: "committed",
        output,
        usage: { modelCalls: 1, promptTokens: 0, completionTokens: 0, elapsedMs: 0, autoRetriesUsed: 0 },
        failure: null,
        preservedValidResult: false,
        resumedFromCheckpoint: false,
        modelCalls: 1,
      };
    },
  };
}

export type { CardContentCheckV3TaskOutput, CardGenerateV3TaskOutput } from "./output-types.ts";

// ── ③ 增量改写任务（card_candidate_rewrite_v3，刀c）─────────────────────

/**
 * 一次只改**一张**：`rewrite` 命中几张就有几次这个调用（§16.28 要求它们如实计入
 * 调用数），改完对这些候选做一次重检就收口——不再有"修复—再检查"的第二轮。
 */
export interface CardCandidateRewriteV3TaskInput {
  readonly runId: string;
  readonly sourceContent: string;
  readonly candidate: LearningCardCandidateRevisionV2;
  /** 提示对是候选行的兄弟列、不在修订体里，所以要单独带进来（改写不许顺手把它们清了）。 */
  readonly hints: CardHintPairV2;
  /** 批量检查给这一张的那几条问题——改写的唯一依据，不自己发明要改什么。 */
  readonly issues: ReadonlyArray<{ readonly code: string; readonly detail: string }>;
  readonly evidenceManifest: AssemblerEvidenceManifest;
}

export interface CardCandidateRewriteV3TaskOutput {
  readonly draft: CardGenerateV3CandidateDraft;
}

export function buildCardCandidateRewriteV3Prompt(
  input: CardCandidateRewriteV3TaskInput,
): string {
  const evidence = input.evidenceManifest.evidence
    .map((entry) => `- ${entry.evidenceSnapshotId}：${(entry.content ?? "").slice(0, 200)}`)
    .join("\n");
  const issues = input.issues.map((issue) => `- ${issue.code}：${issue.detail}`).join("\n");
  const { candidate } = input;
  return [
    "你是学习卡改写助手。下面这张候选卡被内容检查判为「需要改写」。",
    "请只针对列出的问题改这一张，不要换题型、不要扩目标、不要引用没给出的依据。",
    "交回的仍是与生成任务同一种草稿形状（服务端会重算全部哈希）：",
    '{"rewrites":[{"objectiveLocalId":"' + candidate.planObjectiveLocalId + '",',
    ' "objectiveDraft":{…}, "presentationDraft":{…}, "hints":{"level1":"…","level2":"…"}}]}',
    "",
    `# 这一张要改的问题\n${issues || "（检查没写具体问题）"}`,
    `# 现在的题面\n${candidate.presentation.front.cue} / ${candidate.presentation.front.prompt}`,
    `# 现在的答案\n${extractAnswerText(candidate.objective.canonicalAnswer)}`,
    `# 依据（sealed manifest）\n${evidence || "（这一版没有可引用的依据）"}`,
  ].join("\n");
}

type RewritePrepare = AiTaskDefinition<CardCandidateRewriteV3TaskInput, CardCandidateRewriteV3TaskOutput>["prepare"];

export interface CardCandidateRewriteV3TaskDeps {
  readonly provider: CardGenerationV3ProviderPort<CardCandidateRewriteV3TaskInput>;
  readonly prepare: RewritePrepare;
  readonly commit: (ctx: AiTaskContext, attempt: AiAttemptToken, output: CardCandidateRewriteV3TaskOutput) => Promise<void>;
  readonly budget?: AiTaskDefinition<CardCandidateRewriteV3TaskInput, CardCandidateRewriteV3TaskOutput>["budget"];
}

export function createCardCandidateRewriteV3Task(
  deps: CardCandidateRewriteV3TaskDeps,
): AiTaskDefinition<CardCandidateRewriteV3TaskInput, CardCandidateRewriteV3TaskOutput> {
  const budget = deps.budget
    ?? V3_TASK_DEFAULT_BUDGET;
  return {
    id: "card_candidate_rewrite_v3",
    version: 1,
    mode: "structured",
    resourceClass: "card_foreground",
    budget,
    completion: { kind: "structured_parsed" },
    usageContext: { modelId: deps.provider.modelId, promptVersion: "card-rewrite-v3", resourceClass: "card_foreground" },
    prepare: deps.prepare,
    execute: async (input, env): Promise<AiStepResult<CardCandidateRewriteV3TaskOutput>> => {
      const completion = await deps.provider.complete({
        prompt: buildCardCandidateRewriteV3Prompt(input),
        input,
        signal: env.signal,
      });
      let drafts: CardCandidateRewriteV3Output;
      try {
        drafts = cardCandidateRewriteV3OutputSchema.parse(JSON.parse(completion.text));
      } catch (error) {
        const failure: ParseFailure = {
          ok: false,
          class: "output_shape",
          message: `改写输出不符合 V3 合同：${(error as Error).message.slice(0, 400)}`,
        };
        return failure;
      }
      const wanted = input.candidate.planObjectiveLocalId;
      const draft = drafts.rewrites.find((item) => item.objectiveLocalId === wanted);
      if (!draft) {
        const failure: ParseFailure = {
          ok: false,
          class: "output_shape",
          message: `改写没有交回这一张（要的是 ${wanted}，给的是 ${drafts.rewrites.map((i) => i.objectiveLocalId).join("/") || "空"}）`,
        };
        return failure;
      }
      return {
        ok: true,
        output: { draft },
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
      };
    },
    commit: async (ctx, attempt, output) => {
      await deps.commit(ctx, attempt, output);
      return {
        outcome: "committed",
        output,
        usage: { modelCalls: 1, promptTokens: 0, completionTokens: 0, elapsedMs: 0, autoRetriesUsed: 0 },
        failure: null,
        preservedValidResult: false,
        resumedFromCheckpoint: false,
        modelCalls: 1,
      };
    },
  };
}
