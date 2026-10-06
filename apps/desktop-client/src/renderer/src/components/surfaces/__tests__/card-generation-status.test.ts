import { describe, expect, it } from "vitest";
import {
  cardGenerationEntryLabel,
  cardGenerationProgressView,
  cardGenerationRecoveryReasonLabel,
  cardGenerationStatusLabel,
  cardGenerationSyncReportText,
  isCardGenerationInFlight,
  isCardGenerationReviewOpen,
  isCardGenerationReviewStage,
  isLiveGenerationForNote,
  isNoteGenerationLive,
  practiceQuotaLabel,
} from "../review/card-generation-status.ts";
import { candidateDecisionLabel } from "../review/candidate-review-model";
import type { CardGenerationCandidateV1 } from "@astella/shared/card-generation-desktop-contracts";
import type { CardGenerationActiveSummaryV1 } from "@astella/shared/card-generation-desktop-contracts";
import { isCardGenerationReviewOpen as sharedIsCardGenerationReviewOpen } from "@astella/shared/card-generation-desktop-contracts";

it("复查停住的候选不承诺人工保留，练习配额不把题型不符误说成没有题目", () => {
  expect(candidateDecisionLabel({ qualityState: "authored" } as CardGenerationCandidateV1)).toBe("复查未通过");
  expect(practiceQuotaLabel({ requiredCount: 2, metCount: 0 })).toBe("计划要求的 2 份练习中，0 份已满足要求、2 份未满足");
});

const summary = (overrides: Partial<CardGenerationActiveSummaryV1>): CardGenerationActiveSummaryV1 => ({
  version: 1,
  runId: "aaaaaaa1-1111-4111-8111-111111111111",
  noteId: "bbbbbbb1-1111-4111-8111-111111111111",
  noteVersionId: "ccccccc1-1111-4111-8111-111111111111",
  status: "checking",
  sourceCapped: null,
  currentPlanVersion: 1,
  reviewDraftRevision: 1,
  updatedAt: "2026-09-17T00:00:00.000Z",
  recovery: null,
  route: { kind: "note.cardGeneration", cardGenerationRunId: "aaaaaaa1-1111-4111-8111-111111111111" },
  ...overrides,
});

describe("card-generation-status", () => {
  it("未知状态不臆造含义", () => {
    expect(cardGenerationStatusLabel("mystery_token")).toBe("还在处理");
    expect(cardGenerationRecoveryReasonLabel("mystery_token")).toBe("需要后台再看一次才能继续");
  });

  it("服务端活跃名单里的状态都可作为笔记页的入口", () => {
    for (const status of ["queued", "source_sealing", "planning", "authoring", "checking", "review_ready", "needs_attention", "activating"]) {
      expect(isNoteGenerationLive(status)).toBe(true);
    }
    // 终态不是"进行中"——激活/关闭/取消后应允许再次生成。
    for (const status of ["activated", "closed_without_activation", "cancelled", "failed", "stale", "no_cards_recommended"]) {
      expect(isNoteGenerationLive(status)).toBe(false);
    }
  });

  it("入口文案按状态指向工作台，从不说『生成学习卡』", () => {
    const labels = [
      cardGenerationEntryLabel("checking"),
      cardGenerationEntryLabel("review_ready"),
      cardGenerationEntryLabel("needs_attention"),
      cardGenerationEntryLabel("activating"),
    ];
    for (const label of labels) {
      expect(label).not.toContain("生成学习卡");
    }
    expect(cardGenerationEntryLabel("review_ready")).toBe("审核学习卡");
  });

  it("in-flight 与 review-stage 的覆盖关系符合业务语义", () => {
    // 纯工作期：只在转，不在审核页。
    for (const status of ["queued", "source_sealing", "planning", "authoring", "checking"]) {
      expect(isCardGenerationInFlight(status)).toBe(true);
      expect(isCardGenerationReviewStage(status)).toBe(false);
    }
    // activating 双态：页面还在审核版式，同时服务端正在保存到卡组（转圈）。
    expect(isCardGenerationInFlight("activating")).toBe(true);
    expect(isCardGenerationReviewStage("activating")).toBe(true);
    // 审核页静态状态。
    for (const status of ["review_ready", "no_cards_recommended", "needs_attention", "activated", "closed_without_activation"]) {
      expect(isCardGenerationReviewStage(status)).toBe(true);
      expect(isCardGenerationInFlight(status)).toBe(false);
    }
  });

  it("isLiveGenerationForNote 只认本笔记的活跃任务", () => {
    const own = summary({});
    const other = summary({ noteId: "ddddddd1-1111-4111-8111-111111111111" });
    const terminal = summary({ status: "cancelled" });
    expect(isLiveGenerationForNote(own, own.noteId)).toBe(true);
    expect(isLiveGenerationForNote(other, own.noteId)).toBe(false);
    expect(isLiveGenerationForNote(terminal, terminal.noteId)).toBe(false);
    expect(isLiveGenerationForNote(null, own.noteId)).toBe(false);
  });

  /**
   * needs_attention 不是审核队列的终点：deck gate 失败时 worker 会保留通过门禁的
   * 候选，用户必须还能决定它们。审核页、API review / activate / close 共用同一个
   * 谓词，所以这里既锁值，也锁「客户端用的就是共享的那一份」。
   */
  it("审核开放态包含 needs_attention，且与共享定义一致", () => {
    expect(isCardGenerationReviewOpen("review_ready")).toBe(true);
    expect(isCardGenerationReviewOpen("needs_attention")).toBe(true);
    for (const status of ["queued", "planning", "checking", "activating", "activated", "cancelled", "failed", "stale", "no_cards_recommended", "closed_without_activation"]) {
      expect(isCardGenerationReviewOpen(status)).toBe(false);
    }
    for (const status of ["review_ready", "needs_attention", "planning", "cancelled", "mystery"]) {
      expect(isCardGenerationReviewOpen(status)).toBe(sharedIsCardGenerationReviewOpen(status));
    }
  });

  it("仅描述真实的在途工作，停止后不推测进度", () => {
    expect(cardGenerationProgressView("queued", null)).toEqual({ detail: "这次已排队，轮到后会从这篇笔记开始。" });
    expect(cardGenerationProgressView("source_sealing", null)?.detail).toContain("已保存的笔记");
    for (const status of ["review_ready", "activated", "activating", "needs_attention", "failed", "stale", "cancelled", "no_cards_recommended", "closed_without_activation", "mystery"]) {
      expect(cardGenerationProgressView(status, null), status).toBeNull();
    }
  });

  it("用已写出的候选与通过核对的候选描述当前工作", () => {
    expect(cardGenerationProgressView("authoring", { plannedCards: 8, authored: 4, gatePassed: 0, gateFailed: 0 }))
      .toEqual({ detail: "已写出 4 / 8 张候选" });
    expect(cardGenerationProgressView("authoring", { plannedCards: 0, authored: 4, gatePassed: 0, gateFailed: 0 }))
      .toEqual({ detail: "已写出 4 张候选" });
    expect(cardGenerationProgressView("checking", { plannedCards: 8, authored: 8, gatePassed: 2, gateFailed: 1 }))
      .toEqual({ detail: "已通过核对 2 / 8 张候选" });
    expect(cardGenerationProgressView("checking", null)?.detail).toContain("核对问题和依据");
  });

  it("同步回执说清楚这次重读读到了什么", () => {
    expect(cardGenerationSyncReportText(null, false)).toContain("没读到最新进度");
    expect(cardGenerationSyncReportText("planning", false)).toContain("仍是「正在挑选值得记住的内容」");
    expect(cardGenerationSyncReportText("checking", true)).toContain("这次生成到了「正在核对问题与笔记」");
    // 状态没变时不能说成"已更新"——那正是用户抱怨"点了没用"的来源。
    expect(cardGenerationSyncReportText("planning", false)).not.toContain("这次生成到了");
  });

  it("规划时也使用已经提交的候选计数", () => {
    expect(cardGenerationProgressView("planning", null)?.detail).toBe("正在挑出适合做成问题的内容。");
    const views = [1, 4, 8].map(authored => cardGenerationProgressView("planning", {
      plannedCards: 8, authored, gatePassed: 0, gateFailed: 0,
    }));
    expect(views).toEqual([
      { detail: "已写出 1 / 8 张候选" }, { detail: "已写出 4 / 8 张候选" }, { detail: "已写出 8 / 8 张候选" },
    ]);
  });
});

/**
 * 39d W4-4：截断说明的那一句话只有这一份（界面别处不再写第二句）。
 * 判据是"它说的是服务端给的数"，不是"它长得像一句话"。
 */
it("截断说明用的是服务端那两个数，且不是笼统的'有点长'", async () => {
  const { sourceCappedNotice } = await import("../review/card-generation-status");
  const notice = sourceCappedNotice({ limit: 60_000, originalLength: 123_456 });
  expect(notice).toContain("60000");
  expect(notice).toContain("123456");
  expect(notice).toContain("其余部分这次没有参与生成");
});

/**
 * 39d W7-2：「保存并开启复习」之后屏幕上那一句。
 * 会错的两件事各自钉住：报哪个日期（多目标时要报**最早**那一条），以及**不许**替服务端
 * 那一格编出用户读不懂的说法——`created:false` 这一发今天没有生产者（排期的目标是这条
 * 命令刚 mint 出来的），所以屏幕上永远不该出现"其中 N 张沿用已有的安排"。第二条期望就是
 * 钉这一句：哪天要把它加回来，得先给那一格一个生产者与一条会红的用例（见 39d D2 §5.4）。
 * 日期用同一个 formatter 组期望值——把句子写成字面量，测的就不是句子而是拼写。
 */
it("复习那句只报最早的那一天，不替今天没有生产者的那一格编说法", async () => {
  const { reviewSchedulingNotice } = await import("../review/card-generation-status");
  const { formatDate } = await import("../notebook/surface-data");
  expect(reviewSchedulingNotice([
    { objectiveId: "o1", nextReviewAt: "2026-10-05T12:00:00.000Z", created: true },
    { objectiveId: "o2", nextReviewAt: "2026-09-27T12:00:00.000Z", created: true },
  ])).toBe(`第一次复习排在 ${formatDate("2026-09-27T12:00:00.000Z")}`);
  expect(reviewSchedulingNotice([
    { objectiveId: "o1", nextReviewAt: "2026-09-27T12:00:00.000Z", created: true },
    { objectiveId: "o2", nextReviewAt: "2026-10-05T12:00:00.000Z", created: false },
  ])).toBe(`第一次复习排在 ${formatDate("2026-09-27T12:00:00.000Z")}`);
  // 读不出日期时不编一个："还没排出来"是真的不知道，"9月27日"是猜。
  expect(reviewSchedulingNotice([
    { objectiveId: "o1", nextReviewAt: "2026-13-45T99:00:00.000Z", created: true },
  ])).toBe("第一次复习的日期还没排出来");
});

/**
 * 「暂不安排」那一档（W7-3 刀一）。这一格的生产者是真的：服务端唯一调度边界先看活行，
 * 挡下来的那几条在回执里带 `held: true` 且**没有日期**。
 *
 * 判据钉的是两件事：那几条不能混进"第一次复习排在 X"（它们什么都没排），并且数得出来。
 * 少了后半句，用户点了"保存并开启复习"看到一句只讲排上的那几张，就会以为全部生效了。
 */
it("被「暂不安排」挡住的那几条不进日期，但要单独数给本人看", async () => {
  const { reviewSchedulingNotice } = await import("../review/card-generation-status");
  const { formatDate } = await import("../notebook/surface-data");
  expect(reviewSchedulingNotice([
    { objectiveId: "o1", nextReviewAt: "2026-09-27T12:00:00.000Z", created: true, held: false },
    { objectiveId: "o2", created: false, held: true },
    { objectiveId: "o3", created: false, held: true },
  ])).toBe(`第一次复习排在 ${formatDate("2026-09-27T12:00:00.000Z")}；还有 2 个目标在你标的「暂不安排」里`);
  // 一张都没排上时不能说"排在 X"，也不能只说"还没排出来"——那句会把本人的排除读成系统失败。
  expect(reviewSchedulingNotice([
    { objectiveId: "o1", created: false, held: true },
  ])).toBe("这次没有排出新的复习；还有 1 个目标在你标的「暂不安排」里");
});
