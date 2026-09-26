/**
 * 制卡简化链（V3）刀a 的单测：两个任务定义＋服务端组装＋确定性 provider。
 *
 * 不碰数据库：prepare/commit 用内存实现，provider 用脚本或确定性版本。要钉的六件事：
 *  1. **§16.28 的调用数形状**——普通成功路径 generate 1 发 + check 1 发 = 恰好 2 次
 *     语义调用；确定性那一版同样是 2 次端口往返、0 次真模型；
 *  2. **合同即闸**——候选引用未提案的 localId、no_cards 还带着候选，解析当场归
 *     output_shape（吃内核那一次自动重试，失败如实计入调用数）；
 *  3. **一份判据**——草稿级只判"必须看整批"的两件（重复 localId、超上限）；依据越界
 *     由组装后的 `evidence_not_in_sealed_scope` 抓（V2 那份冻结 code，不另写）；
 *  4. **服务端盖章**——模型给的身份与哈希一律不采信；漏检的候选按"没检查过"记账；
 *  5. **整批分配**——题型由批次决定，同时落到计划目标与候选的题面上；
 *  6. **零候选是正常结果**——no_cards 出得来一份合法计划，全被剔除时也出得来。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCardGenerateV3Prompt,
  buildCardContentCheckV3Prompt,
  createCardGenerateV3Task,
  createCardContentCheckV3Task,
  stampCardContentCheckV3Output,
  validateCardGenerateV3Drafts,
  type CardContentCheckV3TaskInput,
  type CardGenerateV3TaskInput,
  type CardGenerationV3ProviderPort,
} from "./tasks.ts";
import {
  assembleCardGenerationV3,
  buildCandidateRevisionV3,
  runCardGenerateV3CandidateGates,
} from "./plan-assembly.ts";
import {
  createDeterministicCardGenerateV3Provider,
  createDeterministicCardContentCheckV3Provider,
} from "./deterministic.ts";
import { cardGenerateV3OutputSchema } from "@ailearn/shared/card-generation-v3-contracts";
import type {
  CardGenerateV3CandidateDraft,
} from "@ailearn/shared/card-generation-v3-contracts";
import type { LearningCardCandidateRevisionV2 } from "@ailearn/shared/card-generation-v2-contracts";
import type { AiTaskContext } from "@ailearn/shared/ai-task-kernel";
import type { GroundingCriticReportV2 } from "@ailearn/shared/card-quality-v2-contracts";
import {
  computeRubricHashV2,
} from "@ailearn/shared/card-generation-v2-hashing";
import {
  extractAtomsDeterministic,
  type AssemblerEvidenceManifest,
  type SealedEvidenceEntryV2,
} from "@ailearn/shared/card-generation-v2-pipeline";

const RUN_ID = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";
const PLAN_REVISION_ID = "aaaa0000-0000-4000-8000-000000000001";
const EVIDENCE_A = "1f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";
const EVIDENCE_B = "2f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";
const EVIDENCE_C = "3f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";
const BLOCK_ONE = "bbbb0000-0000-4000-8000-000000000001";
const BLOCK_TWO = "bbbb0000-0000-4000-8000-000000000002";
const SNAPSHOT_HASH = "a".repeat(64);

const noteBlocks = [
  { blockId: BLOCK_ONE, ordinal: 1, text: "间隔重复把复习安排在快忘的时候，比集中重读更省力。" },
  { blockId: BLOCK_TWO, ordinal: 2, text: "提取练习要求先想出答案，因此长期保持优于重新阅读。" },
];

const generateInput: CardGenerateV3TaskInput = {
  runId: RUN_ID,
  noteTitle: "记忆的两条规律",
  noteBlocks,
  existingObjectives: [{ objectiveId: EVIDENCE_C, statement: "已有的目标：说出重读为什么不够" }],
  userRequest: null,
  evidence: [
    { evidenceSnapshotId: EVIDENCE_A, blockId: BLOCK_ONE },
    { evidenceSnapshotId: EVIDENCE_B, blockId: BLOCK_TWO },
  ],
  inputSnapshotHash: SNAPSHOT_HASH,
  planVersion: 1,
  cardContentEpoch: 1,
  activationHardMax: 3,
};

const sealedEvidence: SealedEvidenceEntryV2[] = [
  entry(EVIDENCE_A, BLOCK_ONE),
  entry(EVIDENCE_B, BLOCK_TWO),
];

const evidenceManifest: AssemblerEvidenceManifest = {
  workspaceId: "workspace-1",
  sourceSnapshotId: "source-1",
  evidence: sealedEvidence,
};

function entry(evidenceSnapshotId: string, blockId: string): SealedEvidenceEntryV2 {
  return {
    evidenceSnapshotId,
    evidenceSnapshotHash: `h-${evidenceSnapshotId.slice(0, 8)}`,
    sourceSnapshotId: "source-1",
    blockId,
    startOffset: 0,
    endOffset: 20,
    quoteHash: "q".repeat(64),
    blockContentHash: "c".repeat(64),
    content: "间隔重复把复习安排在快忘的时候",
  };
}

/** 一份能过 `cardGenerateV3OutputSchema` 的候选草稿（真合同形状，不是随手拼的）。 */
function candidateDraft(
  objectiveLocalId: string,
  evidenceRefIds: string[] = [EVIDENCE_A],
): CardGenerateV3CandidateDraft {
  return {
    objectiveLocalId,
    objectiveDraft: {
      objectiveStatement: "说得出间隔重复为什么把复习点安排在即将遗忘的时候",
      publicSummary: "复习点与遗忘曲线",
      conceptLabel: "间隔重复",
      knowledgeForm: "causal_model",
      preferredTaskIntents: ["recall"],
      canonicalAnswer: {
        kind: "text",
        unit: { unitId: "u1", text: "因为那时重新编码最省力，保持最久。" },
      },
      learningSupport: { explanation: "它把复习安排在快忘的时候，而不是集中重读。" },
      rubric: {
        version: 2,
        units: [{
          rubricUnitId: "ru1",
          facet: "recall",
          criterion: "能说出复习点安排在即将遗忘的理由",
          required: true,
          answerUnitIds: ["u1"],
          evidenceRefIds,
        }],
        passingPolicy: { requireAllRequiredUnits: true, allowContradiction: false },
        // 模型自己凑的一个：服务端必须丢掉重算（测试就钉这个"丢掉"真发生了）。
        rubricHash: "0".repeat(64),
      },
      relations: [],
      difficulty: "introductory",
      evidenceRefIds,
    },
    presentationDraft: {
      strategy: "recall",
      transformationKind: "mechanism_reconstruction",
      front: { cue: "复习点为什么安排在快忘的时候", prompt: "用一句话说出理由" },
      estimatedReviewSeconds: 30,
    },
    hints: { level1: "想想遗忘曲线", level2: "关键词：重新编码" },
  };
}

function generateJson(
  drafts: CardGenerateV3CandidateDraft[],
  intent: Record<string, unknown> = {
    kind: "author_candidates",
    recommendedCardCount: drafts.length,
  },
): string {
  return JSON.stringify({
    planIntent: intent,
    objectiveProposals: drafts.map((draft) => ({
      objectiveLocalId: draft.objectiveLocalId,
      objectiveStatement: draft.objectiveDraft.objectiveStatement,
      priority: "important",
      knowledgeForm: draft.objectiveDraft.knowledgeForm,
      rationale: "这一句在正文里说清了机制",
    })),
    candidates: drafts,
  });
}

/** 一次一发的脚本端口；多取即抛（调用数因此可见）。 */
function scriptedProvider(responses: string[]): CardGenerationV3ProviderPort<unknown> & { calls: number } {
  let index = 0;
  return {
    modelId: "scripted-v3",
    calls: 0,
    async complete() {
      this.calls += 1;
      if (index >= responses.length) throw new Error("脚本端口没有更多回应（调用数超预算）");
      const text = responses[index];
      index += 1;
      return { text, promptTokens: 10, completionTokens: 20 };
    },
  };
}

function environment(modelId: string) {
  return {
    mode: "structured" as const,
    usageContext: { modelId, promptVersion: "test", resourceClass: "card_foreground" },
    remainingMs: 60_000,
    stepTimeoutMs: 30_000,
    retryIndex: 0,
    signal: new AbortController().signal,
  };
}

const taskContext = {
  workspaceId: "workspace-1",
  userId: null,
  permissionLevel: "full",
  inputSnapshotRef: { kind: "task", id: RUN_ID, hash: SNAPSHOT_HASH },
} as const satisfies AiTaskContext;

function attemptFixture(taskId: string) {
  return {
    taskId,
    taskVersion: 1,
    attemptId: "attempt-1",
    leaseToken: "lease-1",
    idempotencyKey: "idem-1",
    workspaceId: "workspace-1",
    userId: null,
  };
}

function groundingReportFixture(): GroundingCriticReportV2 {
  return {
    version: 2,
    reportId: EVIDENCE_C,
    // 故意与真候选不同的两份身份：盖章必须把它们换掉。
    candidateRevisionId: EVIDENCE_C,
    candidateRevisionHash: "1".repeat(64),
    evidenceSetHash: "2".repeat(64),
    evidenceEligibilityVectorHash: "3".repeat(64),
    inputHash: "4".repeat(64),
    verdict: "pass",
    answerUnits: [{ answerUnitId: "u1", verdict: "entailed", evidenceSnapshotIds: [EVIDENCE_A] }],
    learningSupport: [{ field: "explanation", verdict: "entailed", evidenceSnapshotIds: [EVIDENCE_A] }],
    relationSupport: [],
    rubricSupport: [{ rubricUnitId: "ru1", verdict: "supported", evidenceSnapshotIds: [EVIDENCE_A] }],
    hardIssues: [],
    criticVersion: "test-grounding-v1",
    reportHash: "9".repeat(64),
  };
}

function checkInput(
  candidates: ReadonlyArray<{
    objectiveLocalId: string;
    candidate: LearningCardCandidateRevisionV2;
  }>,
): CardContentCheckV3TaskInput {
  return {
    runId: RUN_ID,
    sourceContent: noteBlocks.map((block) => block.text).join("\n\n"),
    candidates,
    evidenceManifest,
  };
}

/** 计划目标与候选是同一序：检查那一份输入按计划的 localId 组，不另数一遍。 */
function checkInputFor(assembled: ReturnType<typeof assembleCardGenerationV3>): CardContentCheckV3TaskInput {
  if (assembled.plan.result.kind !== "author_candidates") assert.fail("这一批发出来的时候应该有目标");
  return checkInput(assembled.plan.result.objectives.map((objective, index) => ({
    objectiveLocalId: objective.objectiveLocalId,
    candidate: assembled.candidates[index]!,
  })));
}

// ── ① 提示词与草稿级校验 ────────────────────────────────────────────────

test("提示词组装：正文块、可用依据、已有目标、预算上限、用户请求都要进 prompt", () => {
  const prompt = buildCardGenerateV3Prompt(generateInput);
  assert.ok(prompt.includes("间隔重复把复习安排在快忘的时候"), "正文块要进 prompt");
  assert.ok(prompt.includes(BLOCK_ONE), "正文块要按真块 id 标出来，否则依据挂不上句");
  assert.ok(prompt.includes(EVIDENCE_A), "可用依据的 id 要进 prompt");
  assert.ok(prompt.includes("已有的目标：说出重读为什么不够"), "已有目标要进 prompt");
  assert.ok(prompt.includes("最多 3 个"), "预算上限要进 prompt（activationHardMax）");
  assert.ok(prompt.includes("no_cards_recommended"), "零候选是正常结果要说清");
  const withRequest = buildCardGenerateV3Prompt({ ...generateInput, userRequest: "只要边界相关" });
  assert.ok(withRequest.includes("只要边界相关"), "用户请求要进 prompt");
});

test("草稿级校验：重复 localId 与超上限逐个剔除并留因", () => {
  const drafts = [
    candidateDraft("obj-1"),
    candidateDraft("obj-1"),
    candidateDraft("obj-2"),
    candidateDraft("obj-3"),
    candidateDraft("obj-4"),
  ];
  const { kept, dropped } = validateCardGenerateV3Drafts(drafts, { activationHardMax: 3 });
  assert.deepEqual(kept.map((draft) => draft.objectiveLocalId), ["obj-1", "obj-2", "obj-3"]);
  assert.deepEqual(dropped.map((item) => item.objectiveLocalId), ["obj-1", "obj-4"]);
  assert.ok(dropped[0]!.reason.includes("重复"));
  assert.ok(dropped[1]!.reason.includes("上限"));
});

test("一份判据：依据越界不在草稿级判，留给组装后的确定性闸", () => {
  // A 在清单里（所以组装能定位到原子），C 不在——越界那一条要能被组装后的闸逮住。
  const outOfScope = candidateDraft("obj-1", [EVIDENCE_A, EVIDENCE_C]);
  const { kept, dropped } = validateCardGenerateV3Drafts([outOfScope], { activationHardMax: 3 });
  assert.equal(kept.length, 1, "草稿级不判依据越界（判据在 deterministic gates 那一份里）");
  assert.deepEqual(dropped, []);

  const assembled = assembleCardGenerationV3({
    generated: cardGenerateV3OutputSchema.parse(JSON.parse(generateJson([outOfScope]))),
    acceptedCandidates: [outOfScope],
    runId: RUN_ID,
    planRevisionId: PLAN_REVISION_ID,
    planVersion: 1,
    previousPlanRevisionId: null,
    inputSnapshotHash: SNAPSHOT_HASH,
    cardContentEpoch: 1,
    activationHardMax: 3,
    evidenceSetHash: SNAPSHOT_HASH,
    atoms: extractAtomsDeterministic(noteBlocks.map((block) => ({
      blockId: block.blockId, type: "text", content: block.text, ordinal: block.ordinal,
    }))),
    sealedEvidence,
  });
  const gated = runCardGenerateV3CandidateGates({
    assembled,
    sourceContent: "间隔重复把复习安排在快忘的时候，比集中重读更省力。",
    evidenceManifest,
  });
  assert.deepEqual(gated.kept, [], "越界的那张不进批量检查");
  assert.deepEqual(gated.rejected[0]?.codes, ["evidence_not_in_sealed_scope"]);
});

// ── ② 合同即闸 ─────────────────────────────────────────────────────────

test("合同即闸：候选引用未提案的 localId ⇒ output_shape", async () => {
  const draft = candidateDraft("obj-1");
  const broken = JSON.parse(generateJson([draft]));
  broken.candidates[0].objectiveLocalId = "obj-不存在";
  const provider = scriptedProvider([JSON.stringify(broken)]);
  const task = createCardGenerateV3Task({
    provider: provider as CardGenerationV3ProviderPort<CardGenerateV3TaskInput>,
    prepare: async () => generateInput,
    commit: async () => { throw new Error("不许 commit"); },
  });
  const receipt = await task.execute(generateInput, environment(provider.modelId));
  assert.ok(!receipt.ok, "越引用的候选必须在解析这一层就被拒");
  assert.equal(receipt.class, "output_shape");
});

test("合同即闸：no_cards 还带着候选 ⇒ output_shape", async () => {
  const withCandidates = JSON.parse(generateJson([candidateDraft("obj-1")]));
  withCandidates.planIntent = { kind: "no_cards_recommended", reasonCodes: ["no_learnable_objective"] };
  const provider = scriptedProvider([JSON.stringify(withCandidates)]);
  const task = createCardGenerateV3Task({
    provider: provider as CardGenerationV3ProviderPort<CardGenerateV3TaskInput>,
    prepare: async () => generateInput,
    commit: async () => { throw new Error("不许 commit"); },
  });
  const receipt = await task.execute(generateInput, environment(provider.modelId));
  assert.ok(!receipt.ok);
  assert.match(receipt.message, /no_cards_recommended must not carry candidates/);
});

// ── ③ §16.28 的调用数 ──────────────────────────────────────────────────

test("§16.28：普通成功路径 generate 1 发 + check 1 发 = 恰好 2 次语义调用", async () => {
  const draft = candidateDraft("obj-1");
  const checkJson = JSON.stringify({
    perCandidate: [{
      objectiveLocalId: "obj-1",
      verdict: "keep",
      issues: [],
      grounding: groundingReportFixture(),
    }],
    setIssues: [],
  });
  const provider = scriptedProvider([generateJson([draft]), checkJson]);
  const committed: string[] = [];

  const generate = createCardGenerateV3Task({
    provider: provider as CardGenerationV3ProviderPort<CardGenerateV3TaskInput>,
    prepare: async () => generateInput,
    commit: async (_ctx, _attempt, output) => { committed.push(`generate:${output.acceptedCount}`); },
  });
  const generated = await generate.execute(generateInput, environment(provider.modelId));
  assert.ok(generated.ok);
  await generate.commit(taskContext, attemptFixture("card_generate_v3"), generated.output);

  const assembled = assembleCardGenerationV3(assemblyInput([draft], generated.output.parsed));
  const input = checkInputFor(assembled);
  const check = createCardContentCheckV3Task({
    provider: provider as CardGenerationV3ProviderPort<CardContentCheckV3TaskInput>,
    prepare: async () => input,
    commit: async () => { committed.push("check"); },
  });
  const checkReceipt = await check.execute(input, environment(provider.modelId));
  assert.ok(checkReceipt.ok, `检查必须成功：${checkReceipt.ok ? "" : checkReceipt.message}`);
  await check.commit(taskContext, attemptFixture("card_content_check_v3"), checkReceipt.output);

  assert.equal(provider.calls, 2, `普通成功路径恰好 2 次语义调用（实到 ${provider.calls}）`);
  assert.deepEqual(committed, ["generate:1", "check"]);
});

/** 数一下端口被打了几发（"2 次往返"这句必须是被量的，不是被命名的）。 */
function counted<TInput>(
  provider: CardGenerationV3ProviderPort<TInput>,
): CardGenerationV3ProviderPort<TInput> & { calls: number } {
  return {
    modelId: provider.modelId,
    calls: 0,
    async complete(request) {
      this.calls += 1;
      return provider.complete(request);
    },
  };
}

test("确定性那一版：2 次端口往返、0 次真模型，交回的形状过同一份合同", async () => {
  const generateProvider = counted(createDeterministicCardGenerateV3Provider());
  const generated = await createCardGenerateV3Task({
    provider: generateProvider,
    prepare: async () => generateInput,
    commit: async () => {},
  }).execute(generateInput, environment(generateProvider.modelId));
  assert.ok(generated.ok, `确定性生成必须交回过合同的一份输出：${!generated.ok ? generated.message : ""}`);
  assert.ok(generated.output.acceptedCount > 0, "这两句正文要能出卡");

  const assembled = assembleCardGenerationV3(assemblyInput(
    generated.output.parsed.candidates,
    generated.output.parsed,
  ));
  assert.equal(assembled.candidates.length, generated.output.acceptedCount);

  const checkProvider = counted(createDeterministicCardContentCheckV3Provider());
  const checked = await createCardContentCheckV3Task({
    provider: checkProvider,
    prepare: async () => checkInputFor(assembled),
    commit: async () => {},
  }).execute(checkInputFor(assembled), environment(checkProvider.modelId));
  assert.ok(checked.ok, `确定性检查必须成功：${checked.ok ? "" : checked.message}`);
  assert.equal(checked.output.parsed.perCandidate.length, assembled.candidates.length);
  assert.equal(generateProvider.calls, 1);
  assert.equal(checkProvider.calls, 1);
  assert.match(generateProvider.modelId, /^deterministic/, "这一条判据里没有一次真模型调用");
  assert.equal(checkProvider.modelId, generateProvider.modelId);
});

// ── ④ 服务端盖章 ───────────────────────────────────────────────────────

test("确定性那一版：挂不上依据的那一块不出卡", async () => {
  const provider = counted(createDeterministicCardGenerateV3Provider());
  // 正文只有 BLOCK_TWO，依据清单里却只有 BLOCK_ONE 的那条：这一句没法落一张有依据的卡。
  const noEvidenceForBlock: CardGenerateV3TaskInput = {
    ...generateInput,
    noteBlocks: [noteBlocks[1]!],
    evidence: [{ evidenceSnapshotId: EVIDENCE_C, blockId: BLOCK_ONE }],
  };
  const receipt = await createCardGenerateV3Task({
    provider,
    prepare: async () => noEvidenceForBlock,
    commit: async () => {},
  }).execute(noEvidenceForBlock, environment(provider.modelId));
  assert.ok(receipt.ok, `交回的形状仍然要过合同：${receipt.ok ? "" : receipt.message}`);
  assert.equal(receipt.output.parsed.planIntent.kind, "no_cards_recommended");
  assert.deepEqual(receipt.output.parsed.planIntent.reasonCodes, ["insufficient_reliable_evidence"]);
  assert.equal(receipt.output.acceptedCount, 0);
});

test("盖章：模型给的身份与哈希不采信；漏检的候选按没检查过记账", async () => {
  const assembled = assembleCardGenerationV3(assemblyInput([candidateDraft("obj-1")],
    cardGenerateV3OutputSchema.parse(JSON.parse(generateJson([candidateDraft("obj-1")])))));
  const candidate = assembled.candidates[0]!;
  const input = checkInput([{ objectiveLocalId: "obj-1", candidate }]);
  const stamped = await stampCardContentCheckV3Output({
    perCandidate: [{
      objectiveLocalId: "obj-1",
      verdict: "keep",
      issues: [],
      grounding: groundingReportFixture(),
    }],
    setIssues: [],
  }, input);
  const report = stamped.stamped.perCandidate[0]!.grounding;
  assert.equal(report.candidateRevisionId, candidate.candidateRevisionId, "身份以服务端那份为准");
  assert.equal(report.candidateRevisionHash, candidate.candidateRevisionHash);
  assert.equal(report.evidenceSetHash, candidate.evidenceSetHash);
  assert.notEqual(report.reportHash, "9".repeat(64), "模型给的那份报告哈希不作数");

  const missing = await stampCardContentCheckV3Output({ perCandidate: [], setIssues: [] }, input);
  assert.deepEqual(missing.unchecked, ["obj-1"]);
  assert.equal(missing.stamped.perCandidate[0]?.verdict, "insufficient", "没检查不等于检查通过");
  assert.equal(missing.stamped.perCandidate[0]?.issues[0]?.code, "check_missing");
});

// ── ⑤ 整批分配 ─────────────────────────────────────────────────────────

test("整批分配：题型同时落到计划目标与候选题面，模型自选的那一份被覆盖", () => {
  // 草稿的 strategy 一律写 recall；三种形态一批出下来不该还是三张同型。
  const drafts = [
    candidateDraft("obj-1"),
    { ...candidateDraft("obj-2"), objectiveDraft: { ...candidateDraft("obj-2").objectiveDraft, knowledgeForm: "fact" as const } },
    { ...candidateDraft("obj-3"), objectiveDraft: { ...candidateDraft("obj-3").objectiveDraft, knowledgeForm: "sequence" as const } },
  ];
  const assembled = assembleCardGenerationV3(assemblyInput(drafts,
    cardGenerateV3OutputSchema.parse(JSON.parse(generateJson(drafts)))));
  if (assembled.plan.result.kind !== "author_candidates") assert.fail("这一批应该有目标");
  const strategies = assembled.plan.result.objectives.map((objective) => objective.strategy);
  assert.ok(new Set(strategies).size > 1, `整批题型不该全同型：${strategies.join("/")}`);
  assembled.plan.result.objectives.forEach((objective, index) => {
    assert.equal(
      assembled.candidates[index]!.presentation.strategy,
      objective.strategy,
      "计划分配的题型必须是候选实际那一份",
    );
  });
});

test("组装：模型给的 rubricHash 被丢弃重算，候选的 planHash 就是计划那一份", () => {
  const draft = candidateDraft("obj-1");
  const assembled = assembleCardGenerationV3(assemblyInput([draft],
    cardGenerateV3OutputSchema.parse(JSON.parse(generateJson([draft])))));
  const candidate = assembled.candidates[0]!;
  const { rubricHash, ...withoutHash } = draft.objectiveDraft.rubric;
  assert.equal(candidate.objective.rubric.rubricHash, computeRubricHashV2(withoutHash));
  assert.notEqual(rubricHash, candidate.objective.rubric.rubricHash);
  assert.equal(candidate.planHash, assembled.plan.planHash);
  assert.equal(candidate.planRevisionId, assembled.plan.planRevisionId);
});

// ── ⑥ 零候选是正常结果 ─────────────────────────────────────────────────

test("no_cards：模型给的理由码折进冻结词表，折不进时按服务端自己的读数说", () => {
  const noCards = (reasonCodes: string[]) => cardGenerateV3OutputSchema.parse({
    planIntent: { kind: "no_cards_recommended", reasonCodes },
    objectiveProposals: [],
    candidates: [],
  });
  const atoms = extractAtomsDeterministic(noteBlocks.map((block) => ({
    blockId: block.blockId, type: "text", content: block.text, ordinal: block.ordinal,
  })));
  const known = assembleCardGenerationV3(assemblyInput([], noCards(["already_covered_by_active_objectives", "模型自己发明的码"]), atoms));
  assert.deepEqual(
    known.plan.result.kind === "no_cards_recommended" ? known.plan.result.reasonCodes : null,
    ["already_covered_by_active_objectives"],
  );
  const unknown = assembleCardGenerationV3(assemblyInput([], noCards(["模型自己发明的码"]), atoms));
  assert.deepEqual(
    unknown.plan.result.kind === "no_cards_recommended" ? unknown.plan.result.reasonCodes : null,
    ["no_pedagogically_useful_transformation"],
    "正文里有可学原子却零候选：说的是'没有可用的教学转换'，不是'没有内容'",
  );
  const emptySource = assembleCardGenerationV3(assemblyInput([], noCards(["模型自己发明的码"]), []));
  assert.deepEqual(
    emptySource.plan.result.kind === "no_cards_recommended" ? emptySource.plan.result.reasonCodes : null,
    ["no_learnable_objective"],
  );
});

test("全被剔除时计划仍然出得来，并把剔除原因带回给作业层", () => {
  const orphan = candidateDraft("obj-1", ["9f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f9"]);
  const assembled = assembleCardGenerationV3(assemblyInput([orphan],
    cardGenerateV3OutputSchema.parse(JSON.parse(generateJson([orphan])))));
  assert.equal(assembled.plan.result.kind, "no_cards_recommended");
  assert.deepEqual(assembled.dropped.map((item) => item.objectiveLocalId), ["obj-1"]);
  assert.match(assembled.dropped[0]!.reason, /没有可学原子/);
});

test("检查提示词：每一张候选与每条依据都要在场", () => {
  const assembled = assembleCardGenerationV3(assemblyInput([candidateDraft("obj-1")],
    cardGenerateV3OutputSchema.parse(JSON.parse(generateJson([candidateDraft("obj-1")])))));
  const prompt = buildCardContentCheckV3Prompt(checkInputFor(assembled));
  assert.ok(prompt.includes(EVIDENCE_A), "依据 id 要进检查的提示");
  assert.ok(prompt.includes("复习点为什么安排在快忘的时候"), "题面要进检查的提示");
  assert.ok(prompt.includes("因为那时重新编码最省力"), "答案要进检查的提示");
  assert.ok(prompt.includes("每一张候选都要有一条结论"), "漏一张的代价要说给模型");
});

// ── ⑦ 增量改写的身份（与首稿共用同一段组装）────────────────────────────

test("改写：同一张卡长出新修订，旧修订留在 derivedFrom 里", () => {
  const draft = candidateDraft("obj-1");
  const first = buildCandidateRevisionV3({
    draft, plan: assemblyPlanFor(draft), runId: RUN_ID,
    strategy: "why", reasonCodes: ["priority-important"], evidenceSetHash: SNAPSHOT_HASH,
  }).candidate;
  const second = buildCandidateRevisionV3({
    draft, plan: assemblyPlanFor(draft), runId: RUN_ID,
    strategy: first.presentation.strategy, reasonCodes: ["content_check_rewrite"],
    evidenceSetHash: SNAPSHOT_HASH, previous: first,
  }).candidate;
  assert.equal(second.candidateId, first.candidateId, "还是同一张卡");
  assert.notEqual(second.candidateRevisionId, first.candidateRevisionId, "但是另一条修订");
  assert.equal(second.revision, 2);
  assert.deepEqual(second.derivedFromCandidateRevisions, [{
    candidateRevisionId: first.candidateRevisionId,
    candidateId: first.candidateId,
    revision: 1,
    revisionHash: first.candidateRevisionHash,
  }]);
  assert.notEqual(second.candidateRevisionHash, first.candidateRevisionHash,
    "修订哈希必须跟着 revision 与 derivedFrom 一起变");

  // 第二次改写：谱系必须**累积**，不是每次只指回上一版（少了这一半，
  // "把展开写成覆盖"这种变异在 1→2 这一跳上是等价的、抓不住）。
  const third = buildCandidateRevisionV3({
    draft, plan: assemblyPlanFor(draft), runId: RUN_ID,
    strategy: second.presentation.strategy, reasonCodes: ["content_check_rewrite"],
    evidenceSetHash: SNAPSHOT_HASH, previous: second,
  }).candidate;
  assert.equal(third.revision, 3);
  assert.deepEqual(third.derivedFromCandidateRevisions.map((item) => item.revision), [1, 2],
    "旧修订按顺序全留在谱系里");
});

test("改写：题型沿用上一版那一份，模型漏填的依据沿用旧修订，哈希按补完之后重算", () => {
  const draft = candidateDraft("obj-1");
  const plan = assemblyPlanFor(draft);
  const first = buildCandidateRevisionV3({
    draft, plan, runId: RUN_ID, strategy: "cloze",
    reasonCodes: ["priority-important"], evidenceSetHash: SNAPSHOT_HASH,
  }).candidate;
  const sloppy = structuredClone(draft);
  sloppy.objectiveDraft.rubric.units[0]!.evidenceRefIds = [];
  sloppy.presentationDraft.strategy = "recall"; // 模型想换题型——不算数
  const second = buildCandidateRevisionV3({
    draft: sloppy, plan, runId: RUN_ID, strategy: first.presentation.strategy,
    reasonCodes: ["content_check_rewrite"], evidenceSetHash: SNAPSHOT_HASH, previous: first,
  }).candidate;
  assert.equal(second.presentation.strategy, "cloze", "改写只改内容，不换题型");
  assert.deepEqual(second.objective.rubric.units[0]!.evidenceRefIds, [EVIDENCE_A],
    "漏填依据的格子沿用上一版，否则重检必然被 no_evidence_reference 拒");
  const { rubricHash: _supplied, ...withoutHash } = second.objective.rubric;
  assert.equal(second.objective.rubric.rubricHash, computeRubricHashV2(withoutHash),
    "补完依据之后哈希要重算");
});

function assemblyPlanFor(_draft: CardGenerateV3CandidateDraft) {
  const assembled = assembleCardGenerationV3(assemblyInput([candidateDraft("obj-1")],
    cardGenerateV3OutputSchema.parse(JSON.parse(generateJson([candidateDraft("obj-1")])))));
  return assembled.plan;
}

function assemblyInput(
  acceptedCandidates: readonly CardGenerateV3CandidateDraft[],
  generated: ReturnType<typeof cardGenerateV3OutputSchema.parse>,
  atoms = extractAtomsDeterministic(noteBlocks.map((block) => ({
    blockId: block.blockId, type: "text", content: block.text, ordinal: block.ordinal,
  }))),
) {
  return {
    generated,
    acceptedCandidates,
    runId: RUN_ID,
    planRevisionId: PLAN_REVISION_ID,
    planVersion: 1,
    previousPlanRevisionId: null,
    inputSnapshotHash: SNAPSHOT_HASH,
    cardContentEpoch: 1,
    activationHardMax: 3,
    evidenceSetHash: SNAPSHOT_HASH,
    atoms,
    sealedEvidence,
  };
}
