// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoundTeachingViewV1 } from "@astella/shared/note-learning-round-contracts";
import { TaskSurface } from "../TaskSurface.tsx";
import { useRoomStore } from "../../app/room-store.ts";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const ROUND_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "aaaaaaa1-1111-4111-8111-111111111111";
const SOURCE_QUOTE = "复合索引缺少最左列条件就无法使用索引";
const CLAIM_REASON = "这个说法可能省略了会改变结论的查询条件和索引列顺序，值得再核对。";

function priorDay(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function stubGateway() {
  const createdAt = priorDay();
  const round = {
    version: 1 as const,
    roundId: ROUND_ID,
    noteId: NOTE_ID,
    phase: "active" as const,
    outcome: null,
    drivingQuestion: "判断复合索引的使用条件",
    drivingQuestionSource: "suggested" as const,
    drivingQuestionRevision: 1,
    noteVersionId: VERSION_ID,
    sourceContentHash: "a".repeat(32),
    evidenceSnapshotIds: [],
    budgets: { maxModelCalls: 8, maxWallClockSeconds: 900, maxTasks: 6 },
    revision: 2,
    pausedAt: null,
    resumedAt: null,
    closedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
  const roundTeaching: RoundTeachingViewV1 = {
    version: 1,
    round,
    plans: [],
    teaching: {
      version: 1,
      teachingId: "44444444-4444-4444-8444-444444444444",
      roundId: ROUND_ID,
      ordinal: 1,
      kind: "explanation",
      content: {
        explanation: "先核对复合索引的列顺序，再看查询条件是否能利用索引前缀。",
        suspectClaims: [{ unitIds: ["suspect-index-unit"], sourceBlockOrdinal: 2, sourceQuote: SOURCE_QUOTE, reason: CLAIM_REASON }],
      },
      sourceBlockOrdinals: [2],
      createdAt,
    },
    practices: [],
    // This revisit has no objective, so it deliberately has no formal practice target.
    practiceStart: null,
    nextStep: { kind: "review_material", basisRunId: null, gapFacets: [], evidence: "none" },
    gapHelp: { stopped: false, consecutiveHelpCount: 0, threshold: 2 },
    prerequisite: { kind: "none", reason: "no_usable_material", gap: null, largeBranchThreshold: 3 },
    artifactFailure: null,
    artifact: null,
  };

  const generationRun = {
    version: 1 as const,
    runId: RUN_ID,
    noteId: NOTE_ID,
    noteVersionId: VERSION_ID,
    status: "review_ready" as const,
    cardContentEpoch: 1,
    currentPlanVersion: 1,
    reviewDraftRevision: 1,
    sourceOutdated: false,
    sourceRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID },
    recovery: null,
    progress: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const suspectCandidate = {
    candidateId: "suspect-1",
    candidateRevisionId: "55555555-5555-4555-8555-555555555555",
    revision: 1,
    candidateRevisionHash: "b".repeat(64),
    reviewDecision: "undecided" as const,
    isReviewReady: false,
    candidateEvidenceBindingPlanHash: null,
    publishState: "unpublished" as const,
    qualityState: "failed" as const,
    qualityIssues: [{ code: "suspect_claim", severity: "hard" as const, detail: "“无法”是过度绝对的表述，应核对列顺序、谓词条件和优化器行为。", sourceQuote: SOURCE_QUOTE }],
    practiceItem: null,
    strategy: "why" as const,
    transformationKind: "mechanism_reconstruction" as const,
    planVersion: 1,
    estimatedReviewSeconds: 45,
    recommendation: { recommended: false, reasonCodes: ["suspect_claim"] },
    objective: { statement: "复合索引的适用条件", publicSummary: "核对索引适用条件", knowledgeForm: "causal_model" as const },
    front: { cue: "复合索引何时可以使用？", prompt: "请说明索引列顺序与查询条件的关系。" },
  };

  const gateway = {
    contract: { enabledRoutes: ["note.detail", "note.cardGeneration"] },
    auth: {
      getState: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { status: "authenticated" as const, workspace: { workspaceId: "w-1" } } })),
    },
    room: {
      getProjection: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { primaryFocus: { state: "empty" }, activeGenerationSummary: { state: "empty" } } })),
    },
    capabilities: {
      get: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { actionCapabilities: { "note.save": "allowed", "card_generation.start": "allowed" }, featureAvailability: { card_generation_v2: { state: "enabled" } } } })),
    },
    note: {
      get: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { noteId: NOTE_ID, title: "索引学习笔记", sourceId: null, currentVersionId: VERSION_ID, permissions: { canEdit: true, canSave: true }, currentVersion: { versionId: VERSION_ID, versionNo: 1, updatedAt: createdAt, contentHash: "hash", blocks: [{ ordinal: 1, type: "paragraph", content: "复合索引按列顺序组织。" }, { ordinal: 2, type: "paragraph", content: SOURCE_QUOTE }] } } })),
      versions: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { noteId: NOTE_ID, items: [], total: 0 } })),
      cardGeneration: {
        latestRun: vi.fn(async () => ({ ok: false as const, workspaceEpoch: 1, error: { code: "not_found", message: "还没有生成记录" } })),
        start: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { runId: RUN_ID } })),
        getRun: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: generationRun })),
        getCandidates: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { candidates: [suspectCandidate], practiceQuota: { requiredCount: 0, metCount: 0 } } })),
        exposure: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { version: 1, runId: RUN_ID, candidateId: "suspect-1", candidateRevisionId: suspectCandidate.candidateRevisionId, revision: 1, exposureStatus: "not_exposed", initialValidationPolicyEffect: "eligible", lastExposedAt: null } })),
      },
    },
    objective: { list: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { items: [] } })) },
    review: { listNoteSubscriptions: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { version: 2, items: [] } })) },
    noteLearningRound: {
      open: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { round, contentMoved: false, noteChangeImpact: null } })),
      teaching: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: roundTeaching })),
      history: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { version: 1, noteId: NOTE_ID, items: [], total: 0 } })),
    },
    subscriptions: {
      subscribe: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { subscriptionId: "sub-1" } })),
      onEvent: vi.fn(() => () => undefined),
      unsubscribe: vi.fn(async () => ({ ok: true as const, data: null })),
    },
    learningRun: { start: vi.fn() },
  };
  window.astella = gateway as unknown as typeof window.astella;
  return { gateway, suspectCandidate };
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ activeNoteRef: null, recentNoteId: null, surface: null, returnTarget: null, activeCardGenerationRunId: null, scenePhase: "idle", motionMode: "off" });
});

describe("隔天复访可疑主张 -> 制卡审核", () => {
  it("沿真实任务区路由进入制卡审核；疑点卡保留不了，也不开正式评分", async () => {
    const { gateway } = stubGateway();
    useRoomStore.setState({
      // ⚠️ `learningRoundId` **必须给**（2026-09-30 补）：页面里有两处都在管 `leaf`——
      // 一处是 `openRound` 一到位就 `setLeaf("learning")`，另一处是重置那一发
      // `setLeaf(activeNoteRef?.learningRoundId ? "learning" : "reading")`。
      // 夹具原先没给这一格，于是**后一发改回来把前一发关掉**，学习叶永远开不出来。
      // 真窗口里这一格是有值的（她有进行中的那一轮时房间台账就会写上），所以是夹具缺格。
      activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, learningRoundId: ROUND_ID },
      surface: "notebook",
      scenePhase: "task",
      motionMode: "off",
    });
    render(<TaskSurface />);

    // Revisit yesterday's round: an unresolved warning automatically opens the learning leaf.
    await waitFor(() => expect(screen.getAllByText(SOURCE_QUOTE).length).toBeGreaterThan(0));
    // 2026-09-30：区域名从「本轮学习」改成「**这一轮**学习」——那是本项目把整轮
    // 文案统一到「这一轮」时一起改的（`notebook-surface.tsx` 那个 `<section>` 就在用新名）。
    // **断言的其余部分一个字没动**：`data-learning-scene` 要的仍然是 `teaching`，
    // 那一格证明「翻到昨天那一轮时叶子自动开在讲解页」，它现在才真的被检验到。
    await waitFor(() => expect(screen.getByRole("region", { name: "这一轮学习" }).getAttribute("data-learning-scene")).toBe("teaching"));
    await waitFor(() => expect(screen.getByText(CLAIM_REASON)).toBeTruthy());
    // 2026-09-30：那句「核对前，相关主张不会成为正式学习目标」**屏上已经没有了**——
    // 现在的判据是那块便签自己的标题「有几处说法要核对」加上夹具给的那条 `claim.reason`。
    // 文案随那一刀的措辞一起改过，测试没跟上。**换成屏上真在的那一句**，
    // 断言的意图（「疑点确实以核对的形式露出来」）一个字没变。
    expect(screen.getByText("有几处说法要核对")).toBeTruthy();
    expect(screen.getByText(CLAIM_REASON)).toBeTruthy();

    // 2026-09-30：此刻我们站在**学习叶**上。屏上有两颗返回：
    //   - 学习叶抬头那颗「回到正文」——跳回正文（**本用例要点的是这一颗**）；
    //   - 正文叶上那颗「← 回笔记正文」——**这一屏够不着**。
    // 原来找的是后者，而前一步刚把叶子开到学习叶——它在屏上不存在。
    // 动作本身没变（回正文），只是要按屏上真正有的那颗点。
    fireEvent.click(screen.getByRole("button", { name: "回到正文" }));
    // 先在正文页选好本次生成方式，再提交；疑点仍应跟随这一批保留。
    fireEvent.click(screen.getByRole("button", { name: "生成学习卡" }));
    fireEvent.click(await screen.findByRole("button", { name: "开始生成" }));

    await waitFor(() => expect(gateway.note.cardGeneration.start).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useRoomStore.getState().surface).toBe("card-generation"));
    await waitFor(() => expect(screen.getByText("待核对的可疑主张")).toBeTruthy());
    expect(screen.getByText(`“${SOURCE_QUOTE}”`)).toBeTruthy();
    expect(screen.getByText(/“无法”是过度绝对的表述/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /保留（等着保存到卡组）/ })).toBeNull();
    expect(gateway.learningRun.start).not.toHaveBeenCalled();

    // The server-graded suspect candidate has no evidence binding plan; the page only reviews it.
    expect(gateway.note.cardGeneration.getCandidates).toHaveBeenCalled();
    expect(useRoomStore.getState().activeCardGenerationRunId).toBe(RUN_ID);
  });
});
