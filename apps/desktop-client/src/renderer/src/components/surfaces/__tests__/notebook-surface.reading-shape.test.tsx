// @vitest-environment jsdom

import { noteDocResult, seedUpdate } from "../../../test-support/note-doc-fixtures.ts";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "../notebook/notebook-surface.tsx";
import { useRoomStore } from "../../../app/room-store.ts";
import { noteBlockRenderedTextV1 } from "@ailearn/shared/note-doc-schema";

/**
 * 阅读页画出来的是不是编辑器里那一份（2026-09-24 对拍量出来的七类）。
 *
 * 病根只有一句：一块的 `content` 是**带结构的 Markdown 原文**（段内换行是 `\n`、
 * 粗体是 `**`、图片是 `![](...)`），而阅读页把它当一行纯文本画进 `<p>`。于是
 * 编辑器里换的行并成一行、`**重点**` 露着星号、段落里的图整张看不见、`---` 变成
 * 三个减号、整块列表压成一行。
 *
 * 这里刻意让实时文档那份是**空的**（`seedUpdate(title, [])`），正文于是走
 * `currentVersion.blocks` 那一支——喂给屏上的块与服务端 `note_blocks` 里存的是
 * 同一个形状（投影由 `note-doc-schema` 出，它的用例在 shared 那边），
 * 所以这一组钉的是"投影出来的形状到了屏上还剩什么"。
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
) {
  Object.defineProperty(window, "ailearn", {
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
        // 空文档：正文于是来自已存版本那一支（见文件头）。
        doc: {
          state: vi.fn(async () => noteDocResult({ update: seedUpdate("阅读形状", []) })),
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
) {
  // `ordinal` 是块在整篇里的序号：页面拿它当 key，也拿它接画廊序号，撞号就会
  // 让后一块顶掉前一块（第一版夹具就是这么把"点第一张图"变成"开在 2/2"的）。
  installApi(list.map((item, ordinal) => ({ ...item, ordinal })), conceptLabel, companionArtifacts, withSuspectClaim, recallRecords, overviewRecords);
  vi.useFakeTimers();
  useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: "read" } });
  const view = render(<NotebookSurface />);
  for (let i = 0; i < 14; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  }
  return {
    ...view,
    /** 正文那一叠块；页面上只有这一处会画它们。 */
    body: () => view.container.querySelector<HTMLElement>(".reading-body")!,
  };
}

const block = (type: string, content: string): Block => ({ ordinal: 0, type, content });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "ailearn");
  useRoomStore.setState({ activeNoteRef: null, surface: null });
});

describe("阅读页画的是编辑器里那一份", () => {
  it("先给一个明确的速看动作，回忆留作轻入口", async () => {
    const view = await show([block("paragraph", "Tool 是 Agent 调用外部能力的入口。")]);
    const primary = view.getByRole("button", { name: "先看懂这篇" });
    expect(primary.className).toContain("notebook-overview-entry__primary");
    expect(view.getByRole("button", { name: "快速想起来" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "和伴星聊聊" })).toBeNull();
    expect(view.queryByRole("button", { name: "也可以问伴星" })).toBeNull();
    expect(view.container.querySelectorAll(".notebook-overview-entry__primary")).toHaveLength(1);
    expect(view.container.querySelectorAll(".notebook-overview-entry__link")).toHaveLength(1);
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
    expect(view.getByRole("button", { name: "看这张速看" }).className).toContain("notebook-overview-entry__primary");
    expect(view.getByRole("button", { name: "快速想起来" }).className).toContain("notebook-overview-entry__link");
    expect(view.queryByText("从记得的地方接着读")).toBeNull();
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
    fireEvent.click(view.getByRole("button", { name: "接着回想" }));
    const recall = view.getByRole("article", { name: "这篇笔记的回想" });
    expect(recall.querySelector(".note-recall-paper__question")?.textContent).toBe("IndexTTS 2.5 为什么要做 2.5 这个版本？");
  });

  it("互动讲解保留原句段落锚点，并能从记录跳回正文", async () => {
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
    const view = await show([block("heading", "例子"), block("paragraph", "这是选中句子。")], undefined, [artifact]);
    fireEvent.click(view.getByRole("button", { name: "学习记录" }));
    fireEvent.click(view.getByRole("button", { name: "打开这份互动讲解" }));
    const source = view.getByRole("button", { name: /回到第 2 段原句/ });
    expect(source.textContent).toContain(selectionText);
    fireEvent.click(source);
    expect(view.body().querySelector('[data-block-ordinal="1"]')?.getAttribute("data-block-focused")).toBe("true");
  });

  it("旧学习轮次不会自动插入首次阅读纸面", async () => {
    const view = await show([block("paragraph", "这是正文里的原句。")], undefined, undefined, true);
    expect(view.body().textContent).toContain("这是正文里的原句。");
    expect(view.queryByLabelText("这一轮学习")).toBeNull();
    expect(view.queryByRole("article", { name: "上次讲解中的待核对说法" })).toBeNull();
    expect(view.queryByText("这是上次的讲解。")).toBeNull();
    expect(view.getByRole("button", { name: "学习记录" })).toBeTruthy();
  });

  it("打开旧记录折页后才读取核心路线，笔记首屏不请求旧路线", async () => {
    const view = await show([block("paragraph", "Tool 是 Agent 调用外部能力的入口。")]);
    const route = vi.fn(async () => ok(null));
    Object.assign(window.ailearn, { noteLearningRound: { route } });
    expect(route).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "学习记录" }));
    const legacy = view.container.querySelector<HTMLDetailsElement>(".notebook-legacy-footprint")!;
    fireEvent.click(legacy.querySelector("summary")!);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(route).toHaveBeenCalledTimes(1);
    expect(view.getByRole("heading", { level: 2, name: "学习记录" })).toBeTruthy();
  });

  it("段内换行画成换行，不再并成一行", async () => {
    const { body } = await show([block("paragraph", "修改笔记。12312\n123123123123")]);
    const paragraph = body().querySelector("p")!;
    // 结构是"字 / 换行 / 字"三节：并成一行就是中间那一节没了（HTML 会把裸 `\n` 折成空格）。
    expect([...paragraph.childNodes].map((node) => node.nodeName)).toEqual(["#text", "BR", "#text"]);
    expect([...paragraph.childNodes].map((node) => node.textContent)).toEqual(["修改笔记。12312", "", "123123123123"]);
  });

  it("批注服务端使用的字符偏移与阅读页每块的 DOM 文本一致", async () => {
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
      expect(rendered[index]?.textContent).toBe(noteBlockRenderedTextV1(item.type, item.content));
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

  it("非网页协议的链接不画成能点的，照原文留成字", async () => {
    const { body } = await show([block("paragraph", "[坑](javascript:alert(1))")]);
    const paragraph = body().querySelector("p")!;
    expect(paragraph.querySelector("a")).toBeNull();
    expect(paragraph.textContent).toBe("[坑](javascript:alert(1))");
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
    const lines = body().querySelectorAll("p.list-block .list-line");
    expect(lines).toHaveLength(3);
    expect([...lines].map((line) => line.textContent)).toEqual(["第一点", "第二点", "第三点"]);
  });

  it("引用多行仍是多行，并带编辑器那道左竖线", async () => {
    const { body } = await show([block("quote", "第一行\n第二行")]);
    const quote = body().querySelector("p.quote")!;
    expect(quote.querySelectorAll("br")).toHaveLength(1);
    expect(quote.className).toContain("quote");
  });

  it("表格单元里也走行内解析，且转义过的竖线不另起一列", async () => {
    const { body } = await show([block("paragraph", "| 列甲 | 列乙 |\n| --- | --- |\n| **粗** | a\\|b |")]);
    const table = body().querySelector("table.md-table")!;
    const cells = [...table.querySelectorAll("tbody td")];
    expect(cells).toHaveLength(2);
    expect(cells[0]?.querySelector("strong")?.textContent).toBe("粗");
    expect(cells[0]?.textContent).not.toContain("**");
    expect(cells[1]?.textContent).toBe("a|b");
    // 分隔行是语法不是内容：跟着画就多出一整行减号。
    expect(table.querySelector("tbody")?.textContent).not.toContain("---");
  });

  it("反斜杠转义还原成它挡着的字符", async () => {
    const { body } = await show([block("paragraph", "干杯\\~-bilibili")]);
    expect(body().querySelector("p")!.textContent).toBe("干杯~-bilibili");
  });

  it("老版本存的 HTML 块塌缩成正文，不露标签", async () => {
    const { body } = await show([block("heading", "<h1>欧姆定律</h1>")]);
    const heading = body().querySelector("h3")!;
    expect(heading.textContent).toBe("欧姆定律");
  });

  it("概念句的高亮切在显示文本上，标记符号不把它挤错位", async () => {
    // 偏移量以前按 `content` 原文算：那句里带着 `**`，切片就会从标记符号中间开始，
    // 高亮盖错字（旧实现框进来的是 `**欧姆定律**是结论`）。渲染与偏移现在同源于
    // `noteInlineDisplayText`。
    const { body } = await show(
      [block("paragraph", "开头的话。**欧姆定律**是结论。结尾的话")],
      "欧姆定律",
    );
    const marked = [...body().querySelectorAll("p .mark")].map((node) => node.textContent ?? "");
    expect(marked.join("")).toBe("欧姆定律是结论。");
    expect(marked.some((text) => text.includes("*"))).toBe(false);
    // 高亮不许拆掉结构：那四个字仍然是粗体，高亮叠在它里面。
    expect(body().querySelector("strong .mark")?.textContent).toBe("欧姆定律");
  });
});
