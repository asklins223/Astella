// @vitest-environment jsdom

/**
 * Star-map three layers and the axis panel (Plan 57).
 *
 * Pinned product decisions, each with a "looks fine but is wrong" opposite:
 *  1. The three layers are one note's path: overview → its card → attempts.
 *  2. The three axes stay separate named slips; no single "mastery" sentence.
 *  3. No percentage anywhere — only the attempt's own score/stars.
 *  4. A note with body but no card still appears; the layer says so honestly.
 *  5. No records means no fabricated row.
 *  6. The "read by note" shelf is always available and reads the same topology.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  UnderstandingEdgeProjectionV3,
  UnderstandingNodeProjectionV3,
} from "@astella/shared/note-deepening-contracts";
import type { NoteDeepeningV3 } from "@astella/shared/note-deepening-v3-contracts";
import { useRoomStore } from "../../../app/home/room-store.ts";
import { GraphSurface } from "../space/graph-surface.tsx";
import { RELATION_ROW_LIMIT } from "../space/graph-surface-types";
import { clearGraphJourneys } from "../space/graph-journey";

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => null),
  });
});

afterEach(() => {
  cleanup();
  clearGraphJourneys();
  vi.restoreAllMocks();
});

let uuid = 0;
function nextId(): string {
  uuid += 1;
  return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
}

const NOTE_ID = "00000000-0000-4000-8000-00000000b001";
const OTHER_NOTE_ID = "00000000-0000-4000-8000-00000000b002";
const CARD_ID = "00000000-0000-4000-8000-00000000d001";
const QUESTION_A = "00000000-0000-4000-8000-00000000e001";
const QUESTION_B = "00000000-0000-4000-8000-00000000e002";
const ATTEMPT_A = "00000000-0000-4000-8000-00000000f001";

function noteNode(id: string, label: string): UnderstandingNodeProjectionV3 {
  return { nodeRef: { kind: "note", noteId: id }, label, currentVersionId: nextId(), hasSource: true };
}

function questionNode(id: string, stem: string, over: Partial<{ bestStars: number | null; bestScore: number | null }> = {}): UnderstandingNodeProjectionV3 {
  return {
    nodeRef: { kind: "card_question", cardId: CARD_ID, questionId: id, noteId: NOTE_ID },
    label: stem,
    questionType: "short_answer",
    ordinal: 0,
    bestStars: over.bestStars ?? null,
    bestScore: over.bestScore ?? null,
    attemptCount: 0,
    lastAttemptAt: null,
  };
}

/** 有正文、没有学习卡——这一篇照样在。 */
const BARE_NOTE_SNAPSHOT = {
  version: 3 as const,
  workspaceId: "00000000-0000-4000-8000-00000000ffff",
  topologyRevision: "rev-bare",
  checkpointToken: "cp-bare",
  nodes: [noteNode(NOTE_ID, "索引与代价"), noteNode(OTHER_NOTE_ID, "事务隔离级别")] as UnderstandingNodeProjectionV3[],
  edges: [] as UnderstandingEdgeProjectionV3[],
  continuationToken: null,
  integrity: { truncated: false },
};

const PRACTICED_SNAPSHOT = {
  ...BARE_NOTE_SNAPSHOT,
  topologyRevision: "rev-practiced",
  nodes: [
    noteNode(NOTE_ID, "索引与代价"),
    noteNode(OTHER_NOTE_ID, "事务隔离级别"),
    questionNode(QUESTION_A, "为什么有索引查询仍然可能慢？", { bestStars: 4, bestScore: 88 }),
    questionNode(QUESTION_B, "结果规模怎样影响代价？", { bestStars: 2, bestScore: 55 }),
  ] as UnderstandingNodeProjectionV3[],
  edges: [
    { edgeId: "q-1", kind: "contains_question", from: { kind: "note", id: NOTE_ID }, to: { kind: "card_question", id: QUESTION_A }, reasonCodes: ["note_learning_card"] },
    { edgeId: "q-2", kind: "contains_question", from: { kind: "note", id: NOTE_ID }, to: { kind: "card_question", id: QUESTION_B }, reasonCodes: ["note_learning_card"] },
  ] as UnderstandingEdgeProjectionV3[],
};

const PRACTICED_DEEPENING: NoteDeepeningV3 = {
  version: 3,
  noteId: NOTE_ID,
  noteTitle: "索引与代价",
  hasBody: true,
  sourceId: null,
  axes: { performance: "used_independently", nextStep: "can_continue", applicability: "basis_holds" },
  card: {
    cardId: CARD_ID,
    status: "active",
    bestStars: 4,
    bestScore: 88,
    attemptCount: 2,
    questions: [
      { questionId: QUESTION_A, ordinal: 0, questionType: "short_answer", stem: "为什么有索引查询仍然可能慢？", bestStars: 4, bestScore: 88 },
      { questionId: QUESTION_B, ordinal: 1, questionType: "single_choice", stem: "结果规模怎样影响代价？", bestStars: 4, bestScore: 88 },
    ],
  },
  attempts: [
    { attemptId: ATTEMPT_A, status: "completed", score: 88, stars: 4, completedAt: "2026-09-20T10:00:00.000Z" },
    { attemptId: nextId(), status: "grading", score: null, stars: null, completedAt: null },
  ],
  attemptsComplete: true,
};

const BARE_DEEPENING: NoteDeepeningV3 = {
  version: 3,
  noteId: NOTE_ID,
  noteTitle: "索引与代价",
  hasBody: true,
  sourceId: null,
  axes: { performance: "no_record_yet", nextStep: "nothing_to_do", applicability: "basis_holds" },
  card: null,
  attempts: [],
  attemptsComplete: true,
};

function stubGateway(options: {
  snapshot: unknown;
  deepening?: NoteDeepeningV3;
  getTopologyFails?: boolean;
}) {
  const gateway = {
    auth: {
      getState: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: { status: "authenticated" as const, workspace: { workspaceId: "workspace-1" } },
      })),
    },
    understanding: {
      getTopology: vi.fn(async () => (
        options.getTopologyFails
          ? { ok: false as const, error: { code: "api_unavailable" as const, safeMessageKey: "error.api_unavailable", retry: "user_action" as const } }
          : { ok: true as const, workspaceEpoch: 1, data: options.snapshot }
      )),
      getNoteDeepening: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: options.deepening ?? BARE_DEEPENING })),
    },
  };
  window.astella = gateway as unknown as typeof window.astella;
  return gateway;
}

async function openNode(label: string) {
  const search = await screen.findByRole("combobox", { name: "搜索理解星图" });
  fireEvent.change(search, { target: { value: label } });
  const listbox = await screen.findByRole("listbox", { name: "搜索结果" });
  fireEvent.click(await within(listbox).findByRole("option", { name: new RegExp(label) }));
  return screen.findByRole("complementary", { name: "星体详情" });
}

describe("星图三层展开 · Plan 57", () => {
  it("选中一篇笔记之后出现三个尺度；换层不换笔记，也只有这一排导航", async () => {
    stubGateway({ snapshot: PRACTICED_SNAPSHOT, deepening: PRACTICED_DEEPENING });
    render(<GraphSurface />);
    const detail = await openNode("索引与代价");

    const layers = within(detail).getByRole("navigation", { name: "这一篇笔记的三个尺度" });
    expect(within(layers).getAllByRole("button")).toHaveLength(3);
    fireEvent.click(within(layers).getByRole("button", { name: "配套练习" }));
    expect(await within(detail).findAllByText("配套练习")).toBeTruthy();
    // 层二不再重复笔记标题（标题只属于层一），锚点由选中项本身承担。
    expect(within(detail).getByRole("navigation", { name: "这一篇笔记的三个尺度" })).toBeTruthy();
  });

  it("层一按题目列出这一篇的卡，并给出练习情况", async () => {
    stubGateway({ snapshot: PRACTICED_SNAPSHOT, deepening: PRACTICED_DEEPENING });
    render(<GraphSurface />);
    const detail = await openNode("索引与代价");

    expect(within(detail).getByText("题目")).toBeTruthy();
    expect(within(detail).getByText("2 道")).toBeTruthy();
    expect(within(detail).getByText("4 星")).toBeTruthy();
    expect(within(detail).getByText("为什么有索引查询仍然可能慢？")).toBeTruthy();
  });

  it("层二列出配套练习的每一道题与它的最好成绩", async () => {
    stubGateway({ snapshot: PRACTICED_SNAPSHOT, deepening: PRACTICED_DEEPENING });
    render(<GraphSurface />);
    const detail = await openNode("索引与代价");
    fireEvent.click(within(detail).getByRole("button", { name: "配套练习" }));

    expect(await within(detail).findByText("88 分")).toBeTruthy();
    expect(within(detail).getByText("结果规模怎样影响代价？")).toBeTruthy();
    expect(within(detail).getAllByText("最好 4 星").length).toBeGreaterThan(0);
  });

  it("层三只说真实作答：已批改的有分数，批改中的说正在批改", async () => {
    stubGateway({ snapshot: PRACTICED_SNAPSHOT, deepening: PRACTICED_DEEPENING });
    render(<GraphSurface />);
    const detail = await openNode("索引与代价");
    fireEvent.click(within(detail).getByRole("button", { name: "练习记录" }));

    expect(await within(detail).findByText("88 分 · 4 星")).toBeTruthy();
    expect(within(detail).getByText("伴星正在批改")).toBeTruthy();
  });

  it("有正文、没有学习卡的笔记照样出现，并如实说还没有题", async () => {
    stubGateway({ snapshot: BARE_NOTE_SNAPSHOT, deepening: BARE_DEEPENING });
    render(<GraphSurface />);
    const detail = await openNode("索引与代价");

    expect(within(detail).getByText("这一篇还没有配套练习——在笔记里生成学习卡之后，题目会出现在这里。")).toBeTruthy();
    fireEvent.click(within(detail).getByRole("button", { name: "配套练习" }));
    expect(await within(detail).findByText("这一篇还没有学习卡。需要练的时候在笔记里生成一张。")).toBeTruthy();
  });

  it("没有练习记录时不编一条示例", async () => {
    stubGateway({ snapshot: BARE_NOTE_SNAPSHOT, deepening: BARE_DEEPENING });
    render(<GraphSurface />);
    const detail = await openNode("索引与代价");
    fireEvent.click(within(detail).getByRole("button", { name: "练习记录" }));

    expect(await within(detail).findByText("这一篇还没有练习记录。这里不替你造一条示例。")).toBeTruthy();
  });
});

describe("状态三轴 · Plan 57", () => {
  it("三轴分成三张带名字的纸签，各说各的话，不合成一句", async () => {
    stubGateway({ snapshot: PRACTICED_SNAPSHOT, deepening: PRACTICED_DEEPENING });
    render(<GraphSurface />);
    const detail = await openNode("索引与代价");

    fireEvent.click(within(detail).getByRole("button", { name: "配套练习" }));
    const group = await within(detail).findByRole("group", { name: "三种状态（分开看，不合成一个）" });
    expect(group).toBeTruthy();
    expect(within(group).getByText("练习情况")).toBeTruthy();
    expect(within(group).getByText("下一步")).toBeTruthy();
    expect(within(group).getByText("内容适用性")).toBeTruthy();
  });

  it("屏上没有一个百分号", async () => {
    stubGateway({ snapshot: PRACTICED_SNAPSHOT, deepening: PRACTICED_DEEPENING });
    render(<GraphSurface />);
    const detail = await openNode("索引与代价");
    fireEvent.click(within(detail).getByRole("button", { name: "配套练习" }));
    // 画布上的缩放读数（100%）不是学习百分比；判据只看这一篇的内容层。
    await waitFor(() => expect(detail.textContent).toContain("配套练习"));
    expect(detail.textContent).not.toMatch(/\d+\s*%/);
    fireEvent.click(within(detail).getByRole("button", { name: "练习记录" }));
    await waitFor(() => expect(detail.textContent).toContain("练习记录"));
    expect(detail.textContent).not.toMatch(/\d+\s*%/);
  });

  it("正文改过只说材料状态，不改写练习表现", async () => {
    const stale: NoteDeepeningV3 = {
      ...PRACTICED_DEEPENING,
      axes: { performance: "used_independently", nextStep: "can_continue", applicability: "basis_updated" },
    };
    stubGateway({ snapshot: PRACTICED_SNAPSHOT, deepening: stale });
    render(<GraphSurface />);
    const detail = await openNode("索引与代价");
    fireEvent.click(within(detail).getByRole("button", { name: "配套练习" }));

    expect(await within(detail).findByText("正文改过，题目可能要对一眼")).toBeTruthy();
    expect(within(detail).getByText("答得不错")).toBeTruthy();
  });
});

describe("按笔记读的等价册页", () => {
  it("随时可切，列的是同一份拓扑，每一行都能回到笔记", async () => {
    stubGateway({ snapshot: PRACTICED_SNAPSHOT, deepening: PRACTICED_DEEPENING });
    render(<GraphSurface />);
    await screen.findByRole("region", { name: "理解星图：你的真实知识宇宙" });

    fireEvent.click(screen.getByRole("button", { name: "按笔记读" }));
    const shelf = await screen.findByRole("region", { name: "按笔记读星图（与星图等价）" });
    expect(within(shelf).getByText("索引与代价")).toBeTruthy();
    expect(within(shelf).getByText(/2 道题/)).toBeTruthy();
    expect(within(shelf).getByText(/最好 4 星/)).toBeTruthy();
  });

  it("没有题目的笔记在册页上如实说还没练", async () => {
    stubGateway({ snapshot: BARE_NOTE_SNAPSHOT, deepening: BARE_DEEPENING });
    render(<GraphSurface />);
    await screen.findByRole("region", { name: "理解星图：你的真实知识宇宙" });

    fireEvent.click(screen.getByRole("button", { name: "按笔记读" }));
    const shelf = await screen.findByRole("region", { name: "按笔记读星图（与星图等价）" });
    expect(within(shelf).getAllByText(/0 道题 · 还没练/).length).toBeGreaterThan(0);
  });

  it("等价册页让开伴星的座位：左边距用的是共享座位预算，不是铺满整屏", () => {
    const css = readFileSync(resolve("src/renderer/src/components/surfaces/understanding-universe.css"), "utf8");
    const block = css.slice(css.indexOf(".universe-booklist {"), css.indexOf("}", css.indexOf(".universe-booklist {")));
    expect(block).toMatch(/left:\s*calc\(var\(--universe-shell-left\) \+ var\(--universe-seat-gutter\)\)/);
  });
});

describe("截断如实说", () => {
  it("记录被截断时说清「只列到这里」，不报一个冒充总数的数字", async () => {
    stubGateway({
      snapshot: PRACTICED_SNAPSHOT,
      deepening: { ...PRACTICED_DEEPENING, attemptsComplete: false },
    });
    render(<GraphSurface />);
    const detail = await openNode("索引与代价");
    fireEvent.click(within(detail).getByRole("button", { name: "练习记录" }));

    expect(await within(detail).findByText(/只列到今天 2 次，更早的还在服务器上/)).toBeTruthy();
  });

  it("拓扑被截断时在屏上说出来", async () => {
    stubGateway({ snapshot: { ...PRACTICED_SNAPSHOT, integrity: { truncated: true } }, deepening: PRACTICED_DEEPENING });
    render(<GraphSurface />);
    expect(await screen.findByText(/这张星图已经装到本次的上限/)).toBeTruthy();
  });
});

describe("引用折叠", () => {
  it("引用一多就按方向各收一刀，并说清还有几篇没列出", async () => {
    const cited = Array.from({ length: RELATION_ROW_LIMIT + 2 }, (_, index) => ({
      node: noteNode(nextId(), `被引用的笔记 ${index + 1}`),
    }));
    stubGateway({
      snapshot: {
        ...BARE_NOTE_SNAPSHOT,
        nodes: [noteNode(NOTE_ID, "索引与代价"), ...cited.map(({ node }) => node)],
        edges: cited.map(({ node }) => ({
          edgeId: `ref-${NOTE_ID}-${node.nodeRef.kind === "note" ? node.nodeRef.noteId : ""}`,
          kind: "references",
          from: { kind: "note", id: NOTE_ID },
          to: { kind: "note", id: node.nodeRef.kind === "note" ? node.nodeRef.noteId : "" },
          reasonCodes: ["link_id"],
        })),
      },
      deepening: BARE_DEEPENING,
    });
    render(<GraphSurface />);
    const detail = await openNode("索引与代价");
    expect(within(detail).getByRole("button", { name: /还有 \d+ 篇没列出/ })).toBeTruthy();
  });
});
