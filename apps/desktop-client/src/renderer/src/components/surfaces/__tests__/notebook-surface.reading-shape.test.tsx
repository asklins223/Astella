// @vitest-environment jsdom

import { noteDocResult, seedBlocksUpdate } from "../../../test-support/note-doc-fixtures.ts";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "../notebook/shell/notebook-surface.tsx";
import { useRoomStore } from "../../../app/home/room-store.ts";
import { noteBlockRenderedTextV1 } from "@astella/shared/note-doc-schema";
import { noteAnnotationV1Schema } from "@astella/shared/note-annotation-contracts";
import { noteRecallRecordV1Schema } from "@astella/shared/note-recall-contracts";
import { beginNoteExplanation, completeNoteExplanation, interruptNoteExplanation, progressNoteExplanation, resetNoteExplanations, useNoteCompanionExplanations } from "../../companion/content/note-companion-explanation";
import { textRangeAtOffsets } from "../notebook/reading/notebook-reading-block.tsx";
import { noteReadingText } from "../notebook/reading/note-reading-text.ts";

/**
 * 阅读页画出来的是不是编辑器里那一份（2026-09-24 对拍量出来的七类）。
 *
 * 病根只有一句：一块的 `content` 是**带结构的 Markdown 原文**（段内换行是 `\n`、
 * 粗体是 `**`、图片是 `![](...)`），而阅读页把它当一行纯文本画进 `<p>`。于是
 * 编辑器里换的行并成一行、`**重点**` 露着星号、段落里的图整张看不见、`---` 变成
 * 三个减号、整块列表压成一行。
 *
 * 实时文档与不可变版本给同一份结构化正文。空的实时文档代表真的删空，
 * 不能借回退旧版本来造阅读夹具。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

type Block = { ordinal: number; type: string; content: string };

function installApi(
  blocks: readonly Block[],
  conceptLabel = "测试目标",
  companionArtifacts?: readonly unknown[],
  withSuspectClaim = false,
  recallRecords?: readonly unknown[],
  overviewRecords?: readonly unknown[],
  annotationRecords?: readonly unknown[],
) {
  Object.defineProperty(window, "astella", {
    configurable: true,
    value: {
      contract: { enabledRoutes: ["note.detail"] },
      auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "w-1" } })) },
      room: {
        getProjection: vi.fn(async () => ok({
          primaryFocus: {
            state: "data",
            data: {
              objective: {
                content: { conceptLabel, publicSummary: "", sourceLabel: null },
                personal: { lastCanonicalAt: null },
                sources: { primaryNote: { noteId: NOTE_ID, noteVersionId: VERSION_ID } },
              },
            },
          },
        })),
      },
      note: {
        get: vi.fn(async () => ok({
          noteId: NOTE_ID,
          title: "阅读形状",
          sourceId: null,
          currentVersionId: VERSION_ID,
          shareScope: "shared",
          permissions: { canEdit: true, canSave: true, canShare: false },
          currentVersion: {
            versionId: VERSION_ID,
            versionNo: 1,
            updatedAt: "2026-09-24T00:00:00.000Z",
            contentHash: "hash-abcdef12",
            blocks,
          },
        })),
        doc: {
          state: vi.fn(async () => noteDocResult({ update: seedBlocksUpdate("阅读形状", blocks) })),
          syncUpdate: vi.fn(),
          presence: vi.fn(async () => ok({ shared: false })),
        },
      },
      capabilities: {
        get: vi.fn(async () => ok({
          actionCapabilities: { "note.save": "allowed", "note.create": "allowed" },
          featureAvailability: { card_generation_v2: { state: "disabled" }, companion_dialogue_v1: { state: "disabled" } },
        })),
      },
      source: { get: vi.fn(async () => ({ ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } })) },
      ...(companionArtifacts ? {
        noteLearningArtifact: { list: vi.fn(async () => ok({ version: 1 as const, items: companionArtifacts, nextCursor: null })) },
        artifact: { ensure: vi.fn(async () => ok({ ensured: true })) },
      } : {}),
      ...(recallRecords ? {
        noteRecall: { list: vi.fn(async () => ok({ version: 1 as const, items: recallRecords, nextCursor: null })) },
      } : {}),
      ...(overviewRecords ? {
        noteOverview: {
          list: vi.fn(async () => ok({ version: 1 as const, items: overviewRecords, nextCursor: null })),
          latestTask: vi.fn(async () => ok({ version: 1 as const, task: null })),
        },
      } : {}),
      ...(annotationRecords ? {
        noteAnnotation: {
          list: vi.fn(async () => ok({ version: 1 as const, items: annotationRecords, nextCursor: null })),
          latestTask: vi.fn(async () => ok({ version: 1 as const, task: null })),
        },
      } : {}),
      ...(withSuspectClaim ? {
        noteLearningRound: {
          open: vi.fn(async () => ok({
            version: 1 as const,
            round: {
              version: 1 as const,
              roundId: "77777777-7777-4777-8777-777777777777",
              noteId: NOTE_ID,
              phase: "active" as const,
              outcome: null,
              drivingQuestion: "这篇笔记想说明什么？",
              drivingQuestionSource: "user_authored" as const,
              drivingQuestionRevision: 1,
              noteVersionId: VERSION_ID,
              sourceContentHash: "hash-abcdef12",
              evidenceSnapshotIds: [],
              budgets: { maxModelCalls: 1, maxWallClockSeconds: 30, maxTasks: 1 },
              revision: 1,
              pausedAt: null,
              resumedAt: null,
              closedAt: null,
              createdAt: "2026-09-24T00:00:00.000Z",
              updatedAt: "2026-09-24T00:00:00.000Z",
            },
            contentMoved: false,
            noteChangeImpact: null,
          })),
          teaching: vi.fn(async () => ok({
            round: { roundId: "77777777-7777-4777-8777-777777777777", drivingQuestion: "这篇笔记想说明什么？" },
            teaching: {
              version: 1 as const,
              teachingId: "88888888-8888-4888-8888-888888888888",
              roundId: "77777777-7777-4777-8777-777777777777",
              ordinal: 1,
              kind: "explanation" as const,
              content: {
                explanation: "这是上次的讲解。",
                suspectClaims: [{
                  unitIds: ["claim-1"],
                  sourceBlockOrdinal: 1,
                  sourceQuote: "笔记中的原句",
                  reason: "这句话需要再核对一个条件。",
                }],
              },
              sourceBlockOrdinals: [1],
              createdAt: "2026-09-24T00:00:00.000Z",
            },
            practices: [],
          })),
        },
      } : {}),
      subscriptions: { subscribe: vi.fn(), unsubscribe: vi.fn(), onEvent: vi.fn(() => () => undefined) },
      shell: { openExternal: vi.fn(async () => ok({ opened: true })) },
    },
  });
}

async function show(
  list: readonly Block[],
  conceptLabel?: string,
  companionArtifacts?: readonly unknown[],
  withSuspectClaim = false,
  recallRecords?: readonly unknown[],
  overviewRecords?: readonly unknown[],
  annotationRecords?: readonly unknown[],
) {
  // `ordinal` 是块在整篇里的序号：页面拿它当 key，也拿它接画廊序号，撞号就会
  // 让后一块顶掉前一块（第一版夹具就是这么把"点第一张图"变成"开在 2/2"的）。
  installApi(list.map((item, ordinal) => ({ ...item, ordinal })), conceptLabel, companionArtifacts, withSuspectClaim, recallRecords, overviewRecords, annotationRecords);
  vi.useFakeTimers();
  useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: "preview" } });
  const view = render(<NotebookSurface />);
  for (let i = 0; i < 14; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  }
  return {
    ...view,
    /** 正文那一叠块；页面上只有这一处会画它们。 */
    body: () => view.container.querySelector<HTMLElement>(".note-transcript")!,
  };
}

const block = (type: string, content: string): Block => ({ ordinal: 0, type, content });

afterEach(() => {
  cleanup();
  resetNoteExplanations();
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "astella");
  useRoomStore.setState({ activeNoteRef: null, surface: null, returnTarget: null });
});

describe("阅读页画的是编辑器里那一份", () => {
  it("keeps the explicit journal return when opening a note from today's history", async () => {
    const returnTo = { label: "返回今日学习", run: vi.fn() };
    useRoomStore.setState({ returnTarget: returnTo });
    const view = await show([block("paragraph", "从今日学习回看这篇笔记。")]);
    expect(useRoomStore.getState().returnTarget).toBe(returnTo);
    view.unmount();
    expect(useRoomStore.getState().returnTarget).toBe(returnTo);
    act(() => useRoomStore.getState().returnTarget?.run());
    expect(returnTo.run).toHaveBeenCalledOnce();
  });
  it.each(["current", "older"] as const)("历史里的 %s 批注在回想往返后仍打开具体原句，并返回原记录页", async versionState => {
    const date = "2026-10-01T00:00:00.000Z", excerpt = "上一轮的利息计入下一轮本金。";
    const annotation = noteAnnotationV1Schema.parse({ annotationId: "33333333-4333-4333-8333-333333333333", noteId: NOTE_ID,
      anchor: { noteVersionId: versionState === "current" ? VERSION_ID : "99999999-4999-4999-8999-999999999999", startBlockOrdinal: 0, endBlockOrdinal: 0, startOffset: 0, endOffset: excerpt.length, excerpt, prefix: "", suffix: "" },
      explanation: "本金会包含已经获得的利息。", sourceMessageId: null, generationJobId: null, revision: 1, versionState, createdAt: date, updatedAt: date });
    const recall = noteRecallRecordV1Schema.parse({ recallId: "44444444-4444-4444-8444-444444444444", noteId: NOTE_ID, noteVersionId: VERSION_ID, noteVersionNumber: 1,
      sectionOrdinal: 1, sectionTitle: null, question: "为什么本金会增加？", answerTruncated: false, selfReport: null, reflection: null, state: "waiting", versionState: "current",
      sourceMessageId: null, conversationId: null, hintSourceMessageId: null, hintConversationId: null, createdAt: date, hintViewedAt: null, revealedAt: null, reportedAt: null });
    const view = await show([block("paragraph", excerpt)], undefined, undefined, false, [recall], undefined, [annotation]);
    fireEvent.click(view.getByRole("tab", { name: "学习记录" }));
    const history = view.getByRole("region", { name: "学习记录" });
    fireEvent.click(within(history).getByRole("button", { name: "打开这次回想" }));
    expect(view.getByRole("article", { name: "这篇笔记的回想" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "回学习记录" }));
    fireEvent.click(within(history).getByRole("button", { name: versionState === "older" ? "查看旧版批注" : "回到这句批注" }));
    expect(view.queryByRole("article", { name: "这篇笔记的回想" })).toBeNull();
    const side = view.getByRole("region", { name: "原句批注" });
    expect(within(side).getByText(excerpt)).toBeTruthy(); expect(within(side).getByText(annotation.explanation)).toBeTruthy();
    if (versionState === "older") {
      expect(within(side).getByText("旧版的原句与批注，未定位到当前正文")).toBeTruthy();
      expect(within(side).queryByRole("button", { name: "做个互动演示" })).toBeNull();
    }
    fireEvent.click(within(side).getByRole("button", { name: "回学习记录" }));
    expect(view.getByRole("region", { name: "学习记录" })).toBeTruthy();
  });

  it("正文、学习入口和记录保持顺序，不因已有记录改名或换位", async () => {
    const view = await show([block("paragraph", "Tool 是 Agent 调用外部能力的入口。")]);
    const navigation = view.getByRole("tablist", { name: "笔记学习" });
    expect(Array.from(navigation.querySelectorAll("button")).map(button => button.getAttribute("aria-label") ?? button.textContent?.trim())).toEqual(["正文", "速看", "回想", "往外学", "学习卡", "学习记录"]);
    expect(view.body().textContent).toContain("Tool 是 Agent 调用外部能力的入口。");
    expect(view.queryByRole("button", { name: "和伴星聊聊" })).toBeNull();
    expect(view.queryByRole("button", { name: "也可以问伴星" })).toBeNull();
    expect(navigation.querySelectorAll(".button.primary")).toHaveLength(0);
    expect(view.queryByText("换个方式")).toBeNull();
  });

  it("仅生成速看卡不能推断用户看过，仍先引导打开它", async () => {
    const overview = {
      overviewId: "33333333-4333-4333-8333-333333333333",
      noteId: NOTE_ID,
      noteVersionId: VERSION_ID,
      noteVersionNumber: 1,
      body: "Tool 可以调用外部能力。",
      references: [{ blockOrdinal: 0, quote: "Tool 是 Agent 调用外部能力的入口。" }],
      coverage: { totalBlocks: 1, textBlocksRead: 1, imageBlocksNotRead: 0 },
      generationJobId: "44444444-4444-4444-8444-444444444444",
      sourceMessageId: null,
      conversationId: null,
      versionState: "current",
      createdAt: "2026-09-29T10:00:00.000Z",
    };
    const view = await show([block("paragraph", "Tool 是 Agent 调用外部能力的入口。")], undefined, undefined, false, undefined, [overview]);
    expect(view.queryByRole("article", { name: "这篇笔记的速看" })).toBeNull();
    fireEvent.click(view.getByRole("tab", { name: "速看" }));
    expect(within(view.getByRole("article", { name: "这篇笔记的速看" })).getByText("Tool 可以调用外部能力。")).toBeTruthy();
    expect(view.getByRole("tab", { name: "回想" })).toBeTruthy();
    expect(view.queryByText("从记得的地方接着读")).toBeNull();
  });

  it("有重点的引用没核对上时，剔了几条要在纸面上说出来", async () => {
    // 引用核不回原文的重点会被逐条剔除，而不是让整份速看失败（0419 同一轮）。
    // 剔了几条必须说出来——否则"少给了几条"在界面上是无声的。
    const overview = {
      overviewId: "55555555-4555-4555-8555-555555555555",
      noteId: NOTE_ID,
      noteVersionId: VERSION_ID,
      noteVersionNumber: 1,
      body: "Tool 可以调用外部能力。",
      points: [{ explanation: "Tool 是 Agent 调用外部能力的入口。", blockOrdinal: 0, quote: "Tool 是 Agent 调用外部能力的入口。" }],
      references: [{ blockOrdinal: 0, quote: "Tool 是 Agent 调用外部能力的入口。" }],
      coverage: { totalBlocks: 1, textBlocksRead: 1, imageBlocksNotRead: 0, pointsDropped: 2 },
      generationJobId: "66666666-4666-4666-8666-666666666666",
      sourceMessageId: null,
      conversationId: null,
      versionState: "current",
      createdAt: "2026-09-29T10:00:00.000Z",
    };
    const view = await show([block("paragraph", "Tool 是 Agent 调用外部能力的入口。")], undefined, undefined, false, undefined, [overview]);
    fireEvent.click(view.getByRole("tab", { name: "速看" }));
    expect(within(view.getByRole("article", { name: "这篇笔记的速看" })).getByText("有 2 条重点的原文引用没有核对上，没有收录。")).toBeTruthy();
  });

  it("速看开关挂在纸面框上，页内容的翻页动画抢不走它的位置", async () => {
    const view = await show([block("paragraph", "Tool 是 Agent 调用外部能力的入口。")]);
    fireEvent.click(view.getByRole("tab", { name: "速看" }));
    const switcher = view.getByRole("navigation", { name: "速看内容" });
    // 页内容（`.notebook-desk__page`）的入场动画带 `transform`，会把那一页变成绝对定位的
    // 包含块。开关若还在页里，就先落在页上、动画一停再跳回纸面左上——2026-10-08 真窗口
    // 逐帧量到这一跳是 62×127px。所以它必须挂在纸面框上，与滚动页平级。
    expect(switcher.closest(".notebook-desk__page")).toBeNull();
    expect(switcher.closest(".notebook-desk__scroll")).toBeNull();
    expect(switcher.closest(".notebook-volume__leaf")).not.toBeNull();
    expect(switcher.closest(".notebook-desk")).not.toBeNull();
    fireEvent.click(within(switcher).getByRole("button", { name: "脑图" }));
    expect(within(switcher).getByRole("button", { name: "脑图" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(switcher).getByRole("button", { name: "要点" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("打开笔记时不自动展开旧回想；用户点接续后再显示干净的问题", async () => {
    const unfinishedRecall = {
      recallId: "77777777-7777-4777-8777-777777777777",
      noteId: NOTE_ID,
      noteVersionId: VERSION_ID,
      noteVersionNumber: 3,
      sectionOrdinal: 1,
      sectionTitle: "为什么要做 2.5？",
      question: "好，那我不给答案，先问一个：**IndexTTS 2.5 为什么要做 2.5 这个版本？**",
      sourceMessageId: null,
      conversationId: null,
      hintSourceMessageId: null,
      hintConversationId: null,
      answerTruncated: false,
      selfReport: null,
      reflection: null,
      state: "waiting" as const,
      versionState: "current" as const,
      createdAt: "2026-09-29T00:00:00.000Z",
      hintViewedAt: null,
      revealedAt: null,
      reportedAt: null,
    };
    const view = await show([block("paragraph", "Tool 是 Agent 调用外部能力的入口。")], undefined, undefined, false, [unfinishedRecall]);

    expect(view.queryByRole("article", { name: "这篇笔记的回想" })).toBeNull();
    fireEvent.click(view.getByRole("tab", { name: "回想" }));
    // 点「回想」要先**查**这一篇有没有没做完的回想（那是 `lookup`，一次异步往返），
    // 查到才把那张纸打开。所以这里必须先把这次往返冲掉，不能紧接着同步断言。
    // 这条断言守的东西没变：查到了就得打开、打开的就是那一篇、题面干净。
    await act(async () => {});
    const recall = view.getByRole("article", { name: "这篇笔记的回想" });
    expect(recall.querySelector(".note-recall-paper__question")?.textContent).toBe("IndexTTS 2.5 为什么要做 2.5 这个版本？");
    expect(view.getByRole("heading", { level: 1, name: "回想一下" })).toBeTruthy();
    expect(view.container.querySelector(".notebook-volume__article-head")).toBeNull();
  });

  it("互动讲解保留原句段落锚点，从演示返回正文后批注角标仍能打开原句", async () => {
    const selectionText = "选中句子";
    const artifact = {
      artifactId: "44444444-4444-4444-8444-444444444444",
      noteId: NOTE_ID,
      noteVersionId: VERSION_ID,
      noteVersionNumber: 1,
      sourceMessageId: "55555555-5555-4555-8555-555555555555",
      conversationId: "66666666-6666-4666-8666-666666666666",
      sourceKind: "annotation" as const,
      selectionText,
      selectionAnchor: {
        noteVersionId: VERSION_ID,
        startBlockOrdinal: 1,
        startOffset: 2,
        endBlockOrdinal: 1,
        endOffset: 2 + selectionText.length,
        excerpt: selectionText,
        prefix: "这是",
        suffix: "。",
      },
      sourceContentHash: "a".repeat(64),
      generatorRef: "test",
      title: "这句的互动讲解",
      subject: "看懂选中的句子",
      caution: "按原文解释",
      outline: [
        { index: 0, title: "看原句", narration: "从这句话开始。", sectionLabel: "例子", quote: selectionText },
        { index: 1, title: "换个说法", narration: "把它拆开理解。", sectionLabel: "例子", quote: selectionText },
      ],
      versionState: "current" as const,
      createdAt: "2026-09-29T00:00:00.000Z",
    };
    const annotation = noteAnnotationV1Schema.parse({
      annotationId: "33333333-4333-4333-8333-333333333333", noteId: NOTE_ID,
      anchor: artifact.selectionAnchor, explanation: "这条解释仍在原句旁边。",
      sourceMessageId: null, generationJobId: null, revision: 1, versionState: "current",
      createdAt: artifact.createdAt, updatedAt: artifact.createdAt,
    });
    const view = await show([block("heading", "例子"), block("paragraph", "这是选中句子。")],
      undefined, [artifact], false, undefined, undefined, [annotation]);
    expect(view.body().querySelectorAll(".note-annotation-badge")).toHaveLength(1);
    fireEvent.click(view.getByRole("tab", { name: "学习记录" }));
    fireEvent.click(view.getByRole("button", { name: "打开这份互动讲解" }));
    const source = view.getByText("对照原句").closest("details")!;
    expect(source.open).toBe(false);
    fireEvent.click(within(source).getByText("对照原句"));
    expect(source.textContent).toContain(selectionText);
    fireEvent.click(within(source).getByRole("button", { name: "回到这句" }));
    expect(view.body().querySelector('[data-block-ordinal="1"]')?.getAttribute("data-block-focused")).toBe("true");
    const badge = view.body().querySelector<HTMLButtonElement>(".note-annotation-badge");
    expect(badge).not.toBeNull();
    fireEvent.click(badge!);
    expect(within(view.getByRole("region", { name: "原句批注" })).getByText(annotation.explanation)).toBeTruthy();
  });

  it.each(["计算 $A = P(1 + r)^n$，再核对。", "$$\nA = P(1 + r)^n\n$$"])(
    "含公式的段落仍按原文字流核对批注：%s", async content => {
      const excerpt = noteBlockRenderedTextV1("paragraph", content);
      const date = "2026-10-03T00:00:00.000Z";
      const annotation = noteAnnotationV1Schema.parse({
        annotationId: "33333333-4333-4333-8333-333333333333", noteId: NOTE_ID,
        anchor: { noteVersionId: VERSION_ID, startBlockOrdinal: 0, endBlockOrdinal: 0,
          startOffset: 0, endOffset: excerpt.length, excerpt, prefix: "", suffix: "" },
        explanation: "本金、利率和轮数一起决定结果。", sourceMessageId: null,
        generationJobId: null, revision: 1, versionState: "current", createdAt: date, updatedAt: date,
      });
      const view = await show([block("paragraph", content)], undefined, undefined, false,
        undefined, undefined, [annotation]);
      expect(view.body().querySelector(".katex")).not.toBeNull();
      const badge = view.body().querySelector<HTMLButtonElement>(".note-annotation-badge");
      expect(badge).not.toBeNull();
      expect(view.queryByText(/需核对/)).toBeNull();
      fireEvent.click(badge!);
      expect(within(view.getByRole("region", { name: "原句批注" })).getByText(annotation.explanation)).toBeTruthy();
    },
  );

  it("旧学习轮次不会自动插入首次阅读纸面", async () => {
    const view = await show([block("paragraph", "这是正文里的原句。")], undefined, undefined, true);
    expect(view.body().textContent).toContain("这是正文里的原句。");
    expect(view.queryByLabelText("这一轮学习")).toBeNull();
    expect(view.queryByRole("article", { name: "上次讲解中的待核对说法" })).toBeNull();
    expect(view.queryByText("这是上次的讲解。")).toBeNull();
    expect(view.getByRole("tab", { name: "学习记录" })).toBeTruthy();
  });

  
  it("段内换行画成换行，不再并成一行", async () => {
    const { body } = await show([block("paragraph", "修改笔记。12312\n123123123123")]);
    const paragraph = body().querySelector("p")!;
    // 结构是"字 / 换行 / 字"三节：并成一行就是中间那一节没了（HTML 会把裸 `\n` 折成空格）。
    expect([...paragraph.childNodes].map((node) => node.nodeName)).toEqual(["#text", "BR", "#text"]);
    expect([...paragraph.childNodes].map((node) => node.textContent)).toEqual(["修改笔记。12312", "", "123123123123"]);
  });

  // Renders six block kinds through the full editor→reader pipeline: ~13s alone,
  // and it was the first to cross 60s when the whole suite ran in parallel,
  // which then poisoned the rest of this file (body() was null afterwards).
  it("批注服务端使用的字符偏移与阅读页每块的 DOM 文本一致", { timeout: 180_000 }, async () => {
    const blocks = [
      block("paragraph", "前 **粗体**\\~\n下一行"),
      block("heading", "<h2>小标题</h2>"),
      block("code", "第一行\n第二行"),
      block("list", "甲\n乙"),
      block("quote", "引用甲\n引用乙"),
      block("paragraph", "| 名称 | 说明 |\n| --- | --- |\n| 伴星 | 用来互动 |"),
    ];
    const { body } = await show(blocks);
    const rendered = [...body().querySelectorAll<HTMLElement>(".reading-block")];
    expect(rendered).toHaveLength(blocks.length);
    blocks.forEach((item, index) => {
      // 取的是批注与「选中这句」实际数的那串字（`noteReadingText` 会跳过带
      // `data-note-decoration` 的记号与代码纸沿），不是裸 textContent。
      expect(noteReadingText(rendered[index]!)).toBe(noteBlockRenderedTextV1(item.type, item.content));
    });
  });

  it("行内四种标记画成结构，屏上不露标记符号", async () => {
    const { body } = await show([
      block("paragraph", "前 **重点** 与 *斜* 与 ~~作废~~ 与 `代码`"),
      block("paragraph", "详见 [说明页](https://example.com/a)"),
    ]);
    const paragraph = body().querySelector("p")!;
    expect([...paragraph.querySelectorAll("strong, em, del, code")].map((node) => node.tagName))
      .toEqual(["STRONG", "EM", "DEL", "CODE"]);
    expect([...paragraph.querySelectorAll("strong, em, del, code")].map((node) => node.textContent))
      .toEqual(["重点", "斜", "作废", "代码"]);
    expect(paragraph.textContent).not.toContain("**");
    expect(paragraph.textContent).not.toContain("~~");
    const link = body().querySelector("a")!;
    expect(link.textContent).toBe("说明页");
    expect(link.getAttribute("href")).toBe("https://example.com/a");
  });

  it("执行协议被移除，链接文字仍可阅读", async () => {
    const { body } = await show([block("paragraph", "[坑](javascript:alert(1))")]);
    const paragraph = body().querySelector("p")!;
    expect(paragraph.querySelector("a")).toBeNull();
    expect(paragraph.textContent).toBe("坑");
  });

  it("段落里的图片画出来，并且进的是整篇那一副画廊", async () => {
    const { body } = await show([
      block("paragraph", "上图：![示意图](https://example.com/a.png)，如下"),
      block("paragraph", "![](https://example.com/b.png)"),
    ]);
    const images = [...body().querySelectorAll("img")];
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute("alt")).toBe("示意图");
    // 点开第一张：进的是整篇画廊（带位次与左右切换），不是只放大这一张的单体灯箱。
    fireEvent.click(images[0]!);
    const lightbox = document.body.querySelector(".image-lightbox");
    expect(lightbox).not.toBeNull();
    expect(lightbox?.querySelector(".image-lightbox-counter")?.textContent).toBe("1 / 2");
    expect(lightbox?.querySelector(".image-lightbox-next")).not.toBeNull();
  });

  it("分隔线画成一条线，不是三个减号", async () => {
    const { body } = await show([block("paragraph", "---")]);
    expect(body().querySelector("hr.reading-rule")).not.toBeNull();
    expect(body().textContent).not.toContain("---");
  });

  it("列表一项一行、各带记号", async () => {
    const { body } = await show([block("list", "第一点\n第二点\n第三点")]);
    const lines = body().querySelectorAll("ul > li");
    expect(lines).toHaveLength(3);
    expect([...lines].map((line) => line.textContent)).toEqual(["第一点", "第二点", "第三点"]);
  });

  it("引用多行仍是多行，并带编辑器那道左竖线", async () => {
    const { body } = await show([block("quote", "第一行\n第二行")]);
    const quote = body().querySelector("blockquote")!;
    expect(quote.querySelectorAll("br")).toHaveLength(1);
    expect(quote.textContent).toBe("第一行第二行");
  });

  it("表格单元里也走行内解析，且转义过的竖线不另起一列", async () => {
    const { body } = await show([block("paragraph", "| 列甲 | 列乙 |\n| :---: | ---: |\n| **粗** | a\\|b |")]);
    const table = body().querySelector("table.md-table")!;
    const cells = [...table.querySelectorAll("tbody td")];
    expect(cells).toHaveLength(2);
    expect(cells[0]?.querySelector("strong")?.textContent).toBe("粗");
    expect(cells[0]?.textContent).not.toContain("**");
    expect(cells[1]?.textContent).toBe("a|b");
    expect((cells[0] as HTMLElement).style.textAlign).toBe("center");
    expect((cells[1] as HTMLElement).style.textAlign).toBe("right");
    expect([...table.querySelectorAll("thead th")].map(cell => (cell as HTMLElement).style.textAlign)).toEqual(["center", "right"]);
    // 分隔行是语法不是内容：跟着画就多出一整行减号。
    expect(table.querySelector("tbody")?.textContent).not.toContain("---");
  });

  it("反斜杠转义还原成它挡着的字符", async () => {
    const { body } = await show([block("paragraph", "干杯\\~-bilibili")]);
    expect(body().querySelector("p")!.textContent).toBe("干杯~-bilibili");
  });

  it("老版本存的 HTML 标题保留语义级别，不露标签", async () => {
    const { body } = await show([block("heading", "<h1>欧姆定律</h1>")]);
    const heading = body().querySelector("h1")!;
    expect(heading.textContent).toBe("欧姆定律");
  });
});

describe("阅读页不重复笔记标题", () => {
  /** 夹具里的标题永远是「阅读形状」；AI 生成的笔记会把它写成正文第一个 H1。 */
  it("正文首个 heading 与标题同名时只在页眉显示一次，其余块号与偏移不动", async () => {
    const view = await show([
      block("heading", "# 阅读形状"),
      block("paragraph", "第一段正文。"),
      block("heading", "## 小节"),
      block("paragraph", "小节正文。"),
    ]);
    const body = view.body();
    // 被隐藏的那一块没有渲染，其余块保留原 ordinal（批注/依据按 ordinal 落位）。
    expect(body.querySelector('[data-block-ordinal="0"]')).toBeNull();
    expect(body.querySelectorAll(".reading-block")).toHaveLength(3);
    expect(body.querySelector('[data-block-ordinal="1"]')?.textContent).toContain("第一段正文。");
    // 页眉仍是标题出现的唯一位置；正文里的真正小节标题照常显示。
    expect(view.getByRole("heading", { level: 2, name: "阅读形状" })).toBeTruthy();
    expect([...body.querySelectorAll("h1, h2")].map(node => node.textContent)).toEqual(["小节"]);
    expect(view.queryByText("这一版正文还没有段落。")).toBeNull();
  });

  it("首个 heading 与标题不同名时照常显示（只隐藏重复的那一个）", async () => {
    const view = await show([block("heading", "# 前言"), block("paragraph", "正文。")]);
    expect(view.body().querySelector('[data-block-ordinal="0"]')?.textContent).toContain("前言");
  });

  it("标题两侧留白不同也算同一个标题", async () => {
    const view = await show([block("heading", "#   阅读形状  "), block("paragraph", "正文。")]);
    expect(view.body().querySelector('[data-block-ordinal="0"]')).toBeNull();
    expect(view.body().querySelector('[data-block-ordinal="1"]')).not.toBeNull();
  });

  it("只有重复标题的版本仍然如实说「还没有正文段落」", async () => {
    const view = await show([block("heading", "# 阅读形状")]);
    expect(view.queryByText("这一版正文还没有段落。")).toBeTruthy();
  });

  it("落在被隐藏标题上的批注仍按当前版本核对，不误报「需核对」", async () => {
    // 标题文字仍在页眉上，所以指向这一块的锚点不算失联；块本身不画在正文里。
    const excerpt = noteBlockRenderedTextV1("heading", "# 阅读形状");
    const date = "2026-10-01T00:00:00.000Z";
    const annotation = noteAnnotationV1Schema.parse({
      annotationId: "33333333-4333-4333-8333-333333333333", noteId: NOTE_ID,
      anchor: { noteVersionId: VERSION_ID, startBlockOrdinal: 0, endBlockOrdinal: 0,
        startOffset: 0, endOffset: excerpt.length, excerpt, prefix: "", suffix: "" },
      explanation: "标题本身也值得留一句。", sourceMessageId: null,
      generationJobId: null, revision: 1, versionState: "current", createdAt: date, updatedAt: date,
    });
    const view = await show([block("heading", "# 阅读形状"), block("paragraph", "正文。")],
      undefined, undefined, false, undefined, undefined, [annotation]);
    expect(view.queryByText(/需核对/)).toBeNull();
  });

  it("目录不再单列一项与页眉重复的标题，后面的小节仍可定位", async () => {
    const view = await show([
      block("heading", "# 阅读形状"),
      block("paragraph", "正文。"),
      block("heading", "## 小节"),
    ]);
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "目录" })); });
    const directory = view.getByRole("complementary", { name: "笔记目录" });
    expect(within(directory).queryByRole("button", { name: "阅读形状" })).toBeNull();
    expect(within(directory).getByRole("button", { name: "小节" })).toBeTruthy();
  });
});

describe("笔记页视图的 tab 语义", () => {
  it("容器是 tablist，选中的视图才有 aria-selected，切换后跟着换", async () => {
    const view = await show([block("paragraph", "正文。")]);
    const tablist = view.getByRole("tablist", { name: "笔记学习" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map(tab => tab.getAttribute("aria-label") ?? tab.textContent?.trim()))
      .toEqual(["正文", "速看", "回想", "往外学", "学习卡", "学习记录"]);
    expect(within(tablist).getByRole("tab", { name: "正文" }).getAttribute("aria-selected")).toBe("true");
    expect(within(tablist).getByRole("tab", { name: "速看" }).getAttribute("aria-selected")).toBe("false");

    // 切到速看会发起一次异步读取；先把这次往返冲掉再看选中态。
    await act(async () => { fireEvent.click(within(tablist).getByRole("tab", { name: "速看" })); });
    expect(within(tablist).getByRole("tab", { name: "速看" }).getAttribute("aria-selected")).toBe("true");
    expect(within(tablist).getByRole("tab", { name: "正文" }).getAttribute("aria-selected")).toBe("false");
  });
});

describe("伴星解释与原句批注并行", () => {
  const excerpt = "上一轮的利息计入下一轮本金。";
  const target = { noteId: NOTE_ID, anchor: { noteVersionId: VERSION_ID, startBlockOrdinal: 0, endBlockOrdinal: 0,
    startOffset: 0, endOffset: excerpt.length, excerpt, prefix: "", suffix: "" } };

  it("伴星完成不抢占手写批注的输入和焦点，两份批注独立保存并都能打开", async () => {
    const view = await show([block("paragraph", excerpt)], undefined, undefined, false, undefined, undefined, []);
    let attempt!: ReturnType<typeof beginNoteExplanation>;
    act(() => { attempt = beginNoteExplanation(target); progressNoteExplanation(attempt.id); });
    fireEvent.click(view.getByRole("button", { name: /伴星正在写解释.*查看/ }));
    fireEvent.click(view.getByRole("button", { name: "另写自己的批注" }));
    const draft = view.getByRole("textbox", { name: "记下你的理解" }) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "我的理解：下一轮用更大的本金算。" } });
    expect(document.activeElement).toBe(draft);
    const write = vi.fn(async (input: { command: { anchor: typeof target.anchor; explanation: string; sourceMessageId?: string } }) => ok(noteAnnotationV1Schema.parse({
      annotationId: input.command.sourceMessageId ? "33333333-4333-4333-8333-333333333333" : "44444444-4444-4444-8444-444444444444",
      noteId: NOTE_ID, anchor: input.command.anchor, explanation: input.command.explanation, sourceMessageId: input.command.sourceMessageId ?? null,
      generationJobId: null, revision: 1, versionState: "current", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z",
    })));
    Object.assign(window.astella!.noteAnnotation, { write });
    await act(async () => { completeNoteExplanation(attempt.id, { annotationId: attempt.id, noteId: target.noteId, anchor: target.anchor, explanation: "利息成为下一轮本金的一部分。", sourceMessageId: null, generationJobId: "55555555-5555-4555-8555-555555555555", revision: 1, versionState: "current", createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" }); });
    expect(draft.value).toBe("我的理解：下一轮用更大的本金算。");
    expect(document.activeElement).toBe(draft);
    expect(view.getByRole("region", { name: "写自己的批注" })).toBeTruthy();
    expect(view.queryByText("伴星正在解释")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "保存批注" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0].command.sourceMessageId).toBeUndefined();
    fireEvent.click(view.getByRole("button", { name: "收起批注" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const own = view.getByRole("button", { name: /批注.*自己的批注/ });
    const companion = view.getByRole("button", { name: /批注.*伴星解释/ });
    fireEvent.click(companion);
    expect(within(view.getByRole("region", { name: "原句批注" })).getByText("利息成为下一轮本金的一部分。")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "收起批注" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    fireEvent.click(own);
    expect(within(view.getByRole("region", { name: "原句批注" })).getByText("我的理解：下一轮用更大的本金算。")).toBeTruthy();
  });

  it("重新选择正在解释的原句，解释入口打开已有进度，状态文字不污染选区锚点", async () => {
    const view = await show([block("paragraph", excerpt)], undefined, undefined, false, undefined, undefined, []);
    act(() => { const item = beginNoteExplanation(target); progressNoteExplanation(item.id); });
    const content = view.body().querySelector<HTMLElement>("[data-note-block-content]")!;
    const range = textRangeAtOffsets(content, 0, excerpt.length)!;
    act(() => { window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); });
    fireEvent.mouseUp(view.body());
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(view.getByRole("button", { name: "查看解释进度" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "查看解释进度" }));
    const side = view.getByRole("region", { name: "伴星原句解释" });
    expect(within(side).getByText(excerpt)).toBeTruthy();
    expect(within(side).getByText("伴星正在写解释")).toBeTruthy();
    expect(useNoteCompanionExplanations.getState().items).toHaveLength(1);
    expect(content.textContent).toBe(excerpt);
  });

  it("停止后的状态与未完成内容留在原句附页，关闭附页不自动写成批注", async () => {
    const view = await show([block("paragraph", excerpt)], undefined, undefined, false, undefined, undefined, []);
    act(() => { const item = beginNoteExplanation(target); progressNoteExplanation(item.id); interruptNoteExplanation(item.id, "stopped"); });
    fireEvent.click(view.getByRole("button", { name: /解释已停止.*查看/ }));
    const side = view.getByRole("region", { name: "伴星原句解释" });
    expect(within(side).getByText("没有留下批注，可以随时重新解释。")).toBeTruthy();
    expect(view.queryByRole("button", { name: `打开批注：${excerpt}` })).toBeNull();
    fireEvent.click(within(side).getByRole("button", { name: "收起这次状态" }));
    expect(view.queryByRole("region", { name: "伴星原句解释" })).toBeNull();
    expect(view.body().textContent).toBe(excerpt);
  });

  it("在附页重新解释后，附页立即跟随新任务，不残留旧任务的停止状态", async () => {
    const view = await show([block("paragraph", excerpt)], undefined, undefined, false, undefined, undefined, []);
    let previousId = "";
    act(() => { const item = beginNoteExplanation(target); previousId = item.id; progressNoteExplanation(item.id); interruptNoteExplanation(item.id, "stopped"); });
    fireEvent.click(view.getByRole("button", { name: /解释已停止.*查看/ }));
    fireEvent.click(view.getByRole("button", { name: "重新解释" }));
    const next = useNoteCompanionExplanations.getState().items[0]!;
    expect(next.id).not.toBe(previousId);
    const side = view.getByRole("region", { name: "伴星原句解释" });
    expect(within(side).getByText("伴星正在准备解释")).toBeTruthy();
    expect(within(side).queryByText("旧的半句")).toBeNull();
    act(() => { progressNoteExplanation(next.id); });
    expect(within(side).getByText("伴星正在写解释")).toBeTruthy();
    expect(within(side).getByRole("button", { name: "停止解释" })).toBeTruthy();
  });
});
