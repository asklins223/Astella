import assert from "node:assert/strict";
import test from "node:test";
import {
  cardGenerationRunServerViewV2Schema,
  cardGenerationRunSnapshotV1Schema,
  cardGenerationActiveSummaryListV1Schema,
  cardGenerationRecoveryProjectionV1Schema,
  cardGenerationExposureEligibilityV1Schema,
  cardGenerationCandidateV1Schema,
  desktopCreateCardGenerationRunRequestV2Schema,
  desktopCardGenerationActivationSelectionV1Schema,
  cardActivationReceiptDesktopV1Schema,
  projectCardActivationReceiptV1,
  projectCardGenerationRunSnapshotV1,
  isCardGenerationReviewOpen,
} from "../contracts/card-generation-desktop-contracts.ts";
import { cardActivationReceiptV2Schema } from "../contracts/card-generation-v2-contracts.ts";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";

test("desktop Card Generation accepts only whole-note start", () => {
  const request = {
    version: 2 as const,
    noteVersionId: VERSION_ID,
    sourceScope: { kind: "whole_note" as const },
    learningGoal: "understand" as const,
    detailThreshold: "balanced" as const,
    quantity: { kind: "adaptive" as const },
    preferredStrategies: [],
    clientRequestId: "desktop-command-1",
  };
  assert.equal(desktopCreateCardGenerationRunRequestV2Schema.safeParse(request).success, true);
  assert.equal(desktopCreateCardGenerationRunRequestV2Schema.safeParse({ ...request, sourceScope: { kind: "section", sectionKey: "x" } }).success, false);
});

test("main-only run view projects without hashes", () => {
  const server = cardGenerationRunServerViewV2Schema.parse({
    runId: RUN_ID,
    noteId: NOTE_ID,
    noteVersionId: VERSION_ID,
    status: "planning",
    cardContentEpoch: 1,
    sourceSnapshotHash: "a".repeat(64),
    semanticSpecHash: "b".repeat(64),
    inputSnapshotHash: "c".repeat(64),
    generationFingerprint: "d".repeat(64),
    currentPlanVersion: 0,
    reviewDraftRevision: 1,
    sourceOutdated: false,
    sourceCapped: null,
    progress: { plannedCards: 0, authored: 0, gatePassed: 0, gateFailed: 0 },
    recovery: null,
    error: null,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:01.000Z",
  });
  const publicView = cardGenerationRunSnapshotV1Schema.parse({
    version: 1,
    runId: RUN_ID,
    noteId: NOTE_ID,
    noteVersionId: VERSION_ID,
    status: "planning",
    cardContentEpoch: 1,
    currentPlanVersion: 0,
    reviewDraftRevision: 1,
    sourceOutdated: false,
    progress: server.progress,
    recovery: null,
    sourceRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID },
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  });
  assert.equal("sourceSnapshotHash" in publicView, false);
  // 主进程→渲染层的投影是 #2「进度只到第 2 步就跳完成」的断点所在：投影必须
  // 把逐候选计数原样带过去，否则进度条除了档位以外无数可用。
  const projected = projectCardGenerationRunSnapshotV1(server);
  assert.deepEqual(projected.progress, server.progress);
});

test("Owner recovery summary is strict and carries only a safe navigation target", () => {
  const summary = cardGenerationActiveSummaryListV1Schema.parse({
    version: 1,
    items: [{
      version: 1,
      runId: RUN_ID,
      noteId: NOTE_ID,
      noteVersionId: VERSION_ID,
      status: "review_ready",
      currentPlanVersion: 1,
      reviewDraftRevision: 2,
      updatedAt: "2026-08-23T00:00:01.000Z",
      recovery: null,
      sourceCapped: null,
      route: { kind: "note.cardGeneration", cardGenerationRunId: RUN_ID },
    }],
  });
  assert.equal(summary.items[0]?.route.cardGenerationRunId, RUN_ID);
  assert.throws(() => cardGenerationActiveSummaryListV1Schema.parse({
    ...summary,
    items: [{ ...summary.items[0], sourceSnapshotHash: "a".repeat(64) }],
  }));
});

test("recovery projection is strict, source-bound, and never grants cancel_run", () => {
  const recovery = cardGenerationRecoveryProjectionV1Schema.parse({
    version: 1,
    publicReasonCode: "quality_gate_failed",
    retryability: "resync_required",
    allowedActions: [
      { kind: "refresh_status", runId: RUN_ID },
      { kind: "return_note", route: "note.detail", sourceRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } },
    ],
  });
  assert.deepEqual(recovery.allowedActions.map((action) => action.kind), ["refresh_status", "return_note"]);
  assert.equal("cancel_run" in recovery.allowedActions, false);
  assert.throws(() => cardGenerationRecoveryProjectionV1Schema.parse({
    ...recovery,
    retryability: "new_run_allowed",
  }));
  assert.throws(() => cardGenerationRecoveryProjectionV1Schema.parse({
    ...recovery,
    allowedActions: [{ kind: "start_new_generation", route: "note.cardGeneration" }],
  }));
});

test("exposure eligibility is strict and exposes only public policy state", () => {
  const projection = cardGenerationExposureEligibilityV1Schema.parse({
    version: 1,
    runId: RUN_ID,
    candidateId: "44444444-4444-4444-8444-444444444444",
    candidateRevisionId: "55555555-5555-4555-8555-555555555555",
    revision: 1,
    exposureStatus: "exposed",
    initialValidationPolicyEffect: "wait_for_initial_validation",
    lastExposedAt: "2026-08-23T00:00:02.000Z",
  });
  assert.equal(projection.exposureStatus, "exposed");
  assert.throws(() => cardGenerationExposureEligibilityV1Schema.parse({
    ...projection,
    canonicalAnswer: "must-not-cross-boundary",
  }));
});

test("failed candidates may omit an activation binding plan without becoming a server error", () => {  const candidate = cardGenerationCandidateV1Schema.parse({
    version: 1,
    candidateId: "44444444-4444-4444-8444-444444444444",
    candidateRevisionId: "55555555-5555-4555-8555-555555555555",
    revision: 2,
    runId: RUN_ID,
    planRevisionId: "66666666-6666-4666-8666-666666666666",
    planVersion: 1,
    planObjectiveLocalId: "objective-1",
    recommendation: { recommended: true, reasonCodes: ["quality_gate_failed"] },
    objective: { statement: "公开目标", publicSummary: "公开摘要", knowledgeForm: "fact" },
    front: { cue: "提示", prompt: "公开问题" },
    strategy: "recall",
    transformationKind: "retrieval_definition",
    estimatedReviewSeconds: 30,
    evidenceSetHash: "a".repeat(64),
    candidateEvidenceBindingPlanHash: null,
    candidateRevisionHash: "b".repeat(64),
    // 这个 schema 全篇没有一处 `.default()`（0 处），所以 `qualityIssues` 是必填的；
    // 本用例要验的是「可以不带 activation binding plan」，不是「可以不带质量问题」，
    // 所以这里按形状补一个空数组，而不是把 schema 改成可选。
    qualityIssues: [],
    qualityState: "failed",
    reviewDecision: "undecided",
    publishState: "unpublished",
    isReviewReady: false,
  });
  assert.equal(candidate.candidateEvidenceBindingPlanHash, null);
  assert.equal(candidate.isReviewReady, false);
});

/**
 * needs_attention 的 run 常常仍持有通过门禁、未发布的候选：worker 在 deck gate
 * 失败时明确保留它们，并要求「用户仍应能保留并启用通过门禁的候选」。API 的
 * review / activate / close 与桌面审核页共用这一个谓词 —— 它一旦退回只认
 * review_ready，审核页就会拿着候选却一个按钮都不给，任务卡死。
 */
test("review stays open for needs_attention runs as well as review_ready", () => {
  assert.equal(isCardGenerationReviewOpen("review_ready"), true);
  assert.equal(isCardGenerationReviewOpen("needs_attention"), true);
  for (const status of [
    "queued",
    "source_sealing",
    "planning",
    "authoring",
    "checking",
    "activating",
    "activated",
    "closed_without_activation",
    "no_cards_recommended",
    "cancelled",
    "failed",
    "stale",
    "not_a_status",
  ]) {
    assert.equal(isCardGenerationReviewOpen(status), false, `${status} must not open the review`);
  }
});

const ACTIVATION_SELECTION = {
  version: 1 as const,
  runId: RUN_ID,
  selectedCandidates: [{
    candidateRevisionId: "77777777-7777-7777-8777-777777777777",
    candidateId: "88888888-8888-8888-8888-888888888888",
    revision: 1,
    revisionHash: "a".repeat(64),
    candidateEvidenceBindingPlanHash: "c".repeat(64),
    intent: { kind: "create_new" as const },
  }],
  existingLifecycleActions: [],
  expectedReviewDraftRevision: 1,
};

/**
 * 「保存到卡组」与「保存并开启复习」共用这一条命令，只差那一档（39d W7-2 两颗按钮）。
 * 这一格在边界层必须**过得去**——它过不去，那颗按钮按下去就是本机一条红，而屏幕上
 * 那句「第一次复习排在 X」永远不会出现。同一发里钉住"缺省还是缺省"与"坏值进不来"：
 * 只测接受，等于没测这一格的类型。
 */
test("activation selection carries the review-scheduling knob and stays strict", () => {
  const scheduled = desktopCardGenerationActivationSelectionV1Schema.parse({
    ...ACTIVATION_SELECTION,
    startReviewScheduling: true,
  });
  assert.equal(scheduled.startReviewScheduling, true);
  assert.equal(
    desktopCardGenerationActivationSelectionV1Schema.parse(ACTIVATION_SELECTION).startReviewScheduling,
    undefined,
  );
  // 缺省那一发交回去的请求里**不该有这一格**：补一个 `false` 就是把"没说"写成"说了不要"。
  assert.equal("startReviewScheduling" in ACTIVATION_SELECTION, false);
  assert.equal(
    desktopCardGenerationActivationSelectionV1Schema.safeParse({
      ...ACTIVATION_SELECTION,
      startReviewScheduling: "yes",
    }).success,
    false,
  );
  assert.equal(
    desktopCardGenerationActivationSelectionV1Schema.safeParse({
      ...ACTIVATION_SELECTION,
      subscribeReview: true,
    }).success,
    false,
  );
});

/**
 * 回执那一格穿过边界时的两种形状：排过期的带着「哪天、是不是沿用」，只保存到卡组那一发
 * **连键都不出现**。`scheduleId` 不外传——界面上没有任何动作按安排 id 寻址。
 */
test("activation receipt projects the scheduling outcome, and omits the key when none was asked", () => {
  const serverReceipt = (scheduling?: unknown) => cardActivationReceiptV2Schema.parse({
    version: 2,
    receiptId: "99999999-9999-9999-8999-999999999999",
    workspaceId: NOTE_ID,
    userId: VERSION_ID,
    runId: RUN_ID,
    idempotencyKey: "activate-key-1",
    requestHash: "d".repeat(64),
    mappings: [{
      candidateRevisionId: "77777777-7777-7777-8777-777777777777",
      candidateEvidenceBindingPlanId: "44444444-4444-4444-8444-444444444444",
      candidateEvidenceBindingPlanHash: "c".repeat(64),
      cardId: "88888888-8888-8888-8888-888888888888",
      objectiveId: NOTE_ID,
      objectiveRevisionId: VERSION_ID,
      publicationRevision: 1,
      resultingEvidenceBindingSetHash: "e".repeat(64),
    }],
    lifecycleResults: [],
    ...(scheduling ? { scheduling } : {}),
    responseHash: "f".repeat(64),
    committedAt: "2026-09-26T04:00:00.000Z",
  });

  const scheduled = projectCardActivationReceiptV1(serverReceipt([{
    objectiveId: NOTE_ID,
    scheduleId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nextReviewAt: "2026-09-27T12:00:00.000Z",
    created: false,
  }]));
  assert.deepEqual(scheduled.scheduling, [
    { objectiveId: NOTE_ID, nextReviewAt: "2026-09-27T12:00:00.000Z", created: false },
  ]);
  assert.equal("scheduleId" in (scheduled.scheduling?.[0] ?? {}), false);

  const savedOnly = projectCardActivationReceiptV1(serverReceipt());
  assert.equal("scheduling" in savedOnly, false, "只保存到卡组那一发不该带一个空数组冒充排过");
  assert.deepEqual(cardActivationReceiptDesktopV1Schema.parse(savedOnly).mappings.length, 1);
});
