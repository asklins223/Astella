/**
 * 回忆等待态在屏上摆什么（39d W5-4；PRD §7.1、§16.24）。
 *
 * **最要紧的一条是第一条**：等待态的标题**不许**回退到 `publicSummary`。
 * 把 `?? publicSummary` 加回实现，下面那条断言会红——而删掉任何一条别的断言
 * 它都不会红，所以必须单独钉住。
 */
import { expect, it } from "vitest";
import { learningObjectiveSurfaceV3Schema, type LearningObjectiveSurfaceV3 } from "@ailearn/shared/learning-objective-surface-contracts";
import { recallWaitingCueV1, recallWaitingLineV1, recallRevealReceiptLineV1 } from "../notebook/recall-waiting-presenter.ts";

const surface = (over: Partial<Record<string, unknown>> = {}): LearningObjectiveSurfaceV3 =>
  learningObjectiveSurfaceV3Schema.parse({
    version: 3,
    objectiveId: "33333333-3333-4333-8333-333333333333",
    surfaceRevision: 1,
    lifecycleEpoch: 1,
    content: {
      conceptLabel: "间隔重复为什么有效",
      // **这一格是泄露的源头**：它是从笔记正文生成的摘要。
      publicSummary: "因为在快要忘记的时候回忆，记忆会变得更牢——这是这一节的完整结论。",
      knowledgeForm: "causal_model",
      cardStrategy: null,
      lifecycle: "active",
      freshness: "fresh",
      presentation: { cardId: null, cardRevision: null, publicationRevision: null },
      sourceLabel: null,
    },
    sources: { origins: [], primaryNote: { noteId: "55555555-5555-4555-8555-555555555555", noteVersionId: "66666666-6666-4666-8666-666666666666", title: "学习科学笔记" }, missingOrigin: false },
    noteChangeImpact: null,
    personal: {
      initialValidation: null,
      activeRun: null,
      review: null,
      practiceTrailCount: 3,
      lastCanonicalAt: null,
      reviewHold: null,
    },
    lifecycle: { status: "active", successorObjectiveId: null },
    personalState: { state: "learning", activeRunId: null },
    primaryAction: {
      kind: "create_review_run",
      objectiveId: "33333333-3333-4333-8333-333333333333",
      label: "开始到期复习",
      start: {
        version: 2,
        originV2: { kind: "review", scheduleId: "77777777-7777-4777-8777-777777777777", objectiveId: "33333333-3333-4333-8333-333333333333", scheduleGeneration: 1 },
        goal: "stabilize",
        requestedTimeBudgetSeconds: 180,
        responsePreference: "adaptive",
      },
    },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  });

it("§7.1：等待态**只**给标题、线索与进度，绝不回退到 publicSummary", () => {
  const cue = recallWaitingCueV1({ kind: "independent_recall", surface: surface() });
  // §7.1：不自动展示原文、正确结构或上次答案。`publicSummary` 是正文生成的摘要。
  expect(cue.title).toBe("间隔重复为什么有效");
  expect(JSON.stringify(cue)).not.toContain("记忆会变得更牢");
  expect(cue.clues.join(" ")).not.toContain("记忆会变得更牢");
  // 变异自证：把 `?? publicSummary` 加回来（conceptLabel 为 null 时）⇒ 本条红。
});

it("§7.1：没有标题时给 null（屏上照实说没给），不许拿摘要顶上", () => {
  const withoutLabel = surface({ content: { ...surface().content, conceptLabel: null } });
  const cue = recallWaitingCueV1({ kind: "independent_recall", surface: withoutLabel });
  expect(cue.title).toBeNull();
  // 变异自证：回退到 publicSummary ⇒ 本条红（title 变成那一整句摘要）。
});

it("§7.1 末句：两种等待**不共用**会提前揭示答案的内容", () => {
  const recall = recallWaitingCueV1({ kind: "independent_recall", surface: surface() });
  const first = recallWaitingCueV1({ kind: "first_learning", surface: surface() });
  // 初学等待时可以直接阅读相关材料；独立回忆等待只能给安全线索。
  expect(recall.mayReadSource).toBe(false);
  expect(first.mayReadSource).toBe(true);
  // 变异自证：把 `kind === "first_learning"` 去掉（恒 true / 恒 false）⇒ 本条红。
});

it("§7.1：线索只是**结构事实**，不是内容复述", () => {
  const cue = recallWaitingCueV1({ kind: "independent_recall", surface: surface() });
  // 指向"去哪儿想"：来自哪一篇、什么知识形态、练过几次。
  expect(cue.clues.some((line) => line.includes("学习科学笔记"))).toBe(true);
  expect(cue.clues.some((line) => line.includes("练过 3 次"))).toBe(true);
  // 知识形态九档全覆盖：不认识的键**静默**少给一条线索，而少给没人会发现。
  //
  // **判据要用「只有形态那一条线索」的面来跑**（第一版用了带笔记标题与练习次数的
  // 完整面，于是删掉提示表里的一档照样绿——那三条别的线索把缺口盖住了。
  // 变异自证：删掉 `boundary` 那一行 ⇒ 本条红）。
  const bareSurface = (form: string): LearningObjectiveSurfaceV3 =>
    surface({
      sources: { origins: [], primaryNote: null, missingOrigin: true },
      personal: {
        initialValidation: null, activeRun: null, review: null,
        practiceTrailCount: 0, lastCanonicalAt: null, reviewHold: null,
      },
      content: { ...surface().content, knowledgeForm: form },
    });
  for (const form of ["fact", "definition", "relationship", "comparison", "sequence",
    "procedure", "causal_model", "boundary", "application_rule"]) {
    const perForm = recallWaitingCueV1({ kind: "independent_recall", surface: bareSurface(form) });
    expect(perForm.clues.length, `${form} 那一档没给出形态线索`).toBe(1);
  }
});

it("§13.4：卡面读不到时说清**是什么读不到**，不留一个空数组让人猜", () => {
  const cue = recallWaitingCueV1({
    kind: "independent_recall", surface: null, unreadableReason: "这一张的题面暂时读不到。",
  });
  expect(cue.clues.length).toBe(1);
  expect(cue.clues[0]).toContain("读不到");
  // 变异自证：读不到时给空数组 ⇒ 本条红。
});

it("§16.24：点过「先看笔记」之后屏上**必须**有一句如实的话", () => {
  // §7.1「系统随后如实按本次暴露条件处理」——屏上不说，那颗按钮就等于没有后果。
  expect(recallRevealReceiptLineV1("independent_recall")).toMatch(/不会算成独立提取/);
  expect(recallRevealReceiptLineV1("first_learning")).toMatch(/看过材料/);
  // 两档不许是同一句：它们对用户是两件事。
  expect(recallRevealReceiptLineV1("independent_recall"))
    .not.toBe(recallRevealReceiptLineV1("first_learning"));
  // 变异自证：两档返回同一句 ⇒ 本条红。
});

it("§7.1：等待时那句话区分两档，且都不许承诺「马上好」", () => {
  expect(recallWaitingLineV1("independent_recall")).toMatch(/先从记忆里找一找/);
  expect(recallWaitingLineV1("first_learning")).toMatch(/材料就在旁边/);
  // §13.4：等待不是失败，也不该被说成"马上就好"（那会诱使用户空等）。
  expect(recallWaitingLineV1("independent_recall")).not.toMatch(/马上|即将|很快/);
});
