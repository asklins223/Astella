// @vitest-environment jsdom

/**
 * 星图三层展开与状态三轴的**渲染判据**（39d W8-1、W8-3；39 §11.2、§11.4、§11.5、
 * §13.2、§16.12）。
 *
 * 钉的是**产品决定**，每一条都有一个"看起来也能跑"的反面实现：
 *
 *  1. **三层是同一条学习路径的三个尺度**（题面那一行）。反面：三层各起一套导航、
 *     各存一份选中态。判据看的是**换层之后锚着的那一篇没换、导航也只有这一排**。
 *  2. **每层有明确的动作**（§11.2 那一列「主要动作」逐条）。反面：三层都只画
 *     事实不给动作，于是"继续学习／查看关系理由／打开某个学习位置／查看相关记录"
 *     全都无处可点。
 *  3. **三轴分开**（§11.4）。反面：把三行并成一句"整体还不错"。判据数的是**三张
 *     带名字的纸签**与三句各说的话——不是某个 class 名。
 *  4. **不用条数/时长/比例画理解百分比**（§11.4 逐字）。反面：屏上出现一个 `%`。
 *     判据直接在层三的文本里找百分号。
 *  5. **有正文的笔记无需制卡即可出现**（§11.2、§16.12）。反面：零目标时不画这
 *     一篇，或者画一句"先制卡"。
 *  6. **没有学习记录时不伪造**（§11.2 逐字）。反面：拿一条示例记录填上。
 *  7. **等价列表**（§11.5）。反面：只在画布坏掉那天才出现的降级件，于是没人走过
 *     它，"等价"就无从验收。
 *  8. **伴星常驻**（AGENTS.md）。反面：等价册页铺满整屏、把她的座位盖住。
 *     判据看的是册页**左边距用的是共享座位预算**那个变量。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  UnderstandingEdgeProjectionV3,
  UnderstandingNodeProjectionV3,
} from "@ailearn/shared/note-deepening-contracts";
import type { NoteDeepeningV3 } from "@ailearn/shared/note-deepening-v3-contracts";
import { useRoomStore } from "../../../app/room-store.ts";
import { GraphSurface } from "../space/graph-surface.tsx";
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

const OBJECTIVE_ID = "00000000-0000-4000-8000-00000000a001";
const NOTE_ID = "00000000-0000-4000-8000-00000000b001";
const OTHER_NOTE_ID = "00000000-0000-4000-8000-00000000b002";
const EVIDENCE_ID = "00000000-0000-4000-8000-00000000c001";
const CARD_ID = "00000000-0000-4000-8000-00000000d001";

function objectiveNode(over: Partial<{
  state: "unvalidated" | "learning" | "stable" | "needs_repair";
  runId: string | null;
  nextReviewAt: string | null;
}> = {}): UnderstandingNodeProjectionV3 {
  return {
    nodeRef: { kind: "objective", objectiveId: OBJECTIVE_ID },
    label: "为什么有索引查询仍然可能慢",
    publicSummary: "索引缩小扫描范围，但结果规模仍影响代价。",
    activeCardId: null,
    lifecycle: "active",
    freshness: "fresh",
    personal: {
      state: over.state ?? "unvalidated",
      activeRunId: over.runId === undefined ? null : over.runId,
      activeScheduleId: null,
      nextReviewAt: over.nextReviewAt ?? null,
      practiceTrailCount: 0,
      lastCanonicalEventId: null,
      primaryAction: { kind: "none" },
    },
  } as UnderstandingNodeProjectionV3;
}

function noteNode(id: string, label: string): UnderstandingNodeProjectionV3 {
  return { nodeRef: { kind: "note", noteId: id }, label, currentVersionId: nextId(), hasSource: true };
}

/** 零目标、零关系、只有一篇有正文的笔记——§11.2/§16.12 的那一支。 */
const BARE_NOTE_SNAPSHOT = {
  version: 3 as const,
  workspaceId: "00000000-0000-4000-8000-00000000ffff",
  topologyRevision: "rev-bare",
  checkpointToken: "cp-bare",
  nodes: [noteNode(NOTE_ID, "索引与代价"), noteNode(OTHER_NOTE_ID, "事务隔离级别")] as UnderstandingNodeProjectionV3[],
  edges: [] as UnderstandingEdgeProjectionV3[],
  continuationToken: null,
  integrity: { truncated: false, missingOriginObjectiveIds: [] },
};

const RICH_SNAPSHOT = {
  ...BARE_NOTE_SNAPSHOT,
  topologyRevision: "rev-rich",
  nodes: [
    objectiveNode({ state: "learning", runId: nextId() }),
    noteNode(NOTE_ID, "索引与代价"),
    noteNode(OTHER_NOTE_ID, "事务隔离级别"),
    { nodeRef: { kind: "evidence", evidenceSnapshotId: EVIDENCE_ID }, supportSummary: "讲义第 3 段：选择率与代价。", sourceLabel: "数据库讲义", restricted: false } as UnderstandingNodeProjectionV3,
  ],
  edges: [
    { edgeId: "src-1", kind: "sourced_from", from: { kind: "note", id: NOTE_ID }, to: { kind: "objective", id: OBJECTIVE_ID }, reasonCodes: [], decidable: false },
    { edgeId: "sup-1", kind: "supported_by", from: { kind: "objective", id: OBJECTIVE_ID }, to: { kind: "evidence", id: EVIDENCE_ID }, reasonCodes: [], decidable: false },
  ] as UnderstandingEdgeProjectionV3[],
};

const RICH_DEEPENING: NoteDeepeningV3 = {
  version: 3,
  noteId: NOTE_ID,
  noteTitle: "索引与代价",
  hasBody: true,
  sourceId: null,
  axes: { performance: "used_independently", nextStep: "can_continue", applicability: "basis_holds" },
  local: {
    openDrivingQuestion: "判断为什么有索引，查询仍然可能慢",
    coreQuestions: [{ objectiveId: OBJECTIVE_ID, label: "为什么有索引查询仍然可能慢", summary: "索引缩小扫描范围，但结果规模仍影响代价。" }],
    objectives: [{ objectiveId: OBJECTIVE_ID, label: "为什么有索引查询仍然可能慢", summary: "索引缩小扫描范围，但结果规模仍影响代价。", state: "stable", runId: "00000000-0000-4000-8000-00000000e001", cardId: CARD_ID }],
    relations: [{ edgeId: "rel-1", otherObjectiveId: "00000000-0000-4000-8000-00000000f001", otherLabel: "选择率", relation: "prerequisite", status: "suggested", reasonCodes: ["prerequisite"] }],
    gaps: [],
  },
  records: [
    {
      recordId: "00000000-0000-4000-8000-0000000a0001",
      runId: "00000000-0000-4000-8000-0000000b0001",
      objectiveId: OBJECTIVE_ID,
      objectiveLabel: "为什么有索引查询仍然可能慢",
      answerForm: "prose",
      answerText: "索引把要扫的行数降下来了，但还要看它捞出来多少行。",
      feedback: [{ verdict: "partial", reason: "结果规模那一半还没有自己的例子。" }],
      occurredAt: "2026-09-20T10:00:00.000Z",
      materialBasis: [{ evidenceSnapshotId: EVIDENCE_ID, supportSummary: "讲义第 3 段：选择率与代价。" }],
      cardId: CARD_ID,
    },
    {
      // 结构化作答：那一格如实是空的
      recordId: "00000000-0000-4000-8000-0000000a0002",
      runId: "00000000-0000-4000-8000-0000000b0002",
      objectiveId: OBJECTIVE_ID,
      objectiveLabel: "为什么有索引查询仍然可能慢",
      answerForm: "structured",
      answerText: null,
      feedback: [],
      occurredAt: "2026-09-21T10:00:00.000Z",
      materialBasis: [],
      cardId: null,
    },
  ],
  recordsComplete: true,
};

const BARE_DEEPENING: NoteDeepeningV3 = {
  version: 3,
  noteId: NOTE_ID,
  noteTitle: "索引与代价",
  hasBody: true,
  sourceId: null,
  axes: { performance: "no_record_yet", nextStep: "nothing_to_do", applicability: "basis_holds" },
  local: { openDrivingQuestion: null, coreQuestions: [], objectives: [], relations: [], gaps: [] },
  records: [],
  recordsComplete: true,
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
  window.ailearn = gateway as unknown as typeof window.ailearn;
  return gateway;
}

/** 点开某一颗星（走搜索，顺带验一遍 §11.2 层一那个"搜索"动作本身还在）。 */
async function openNode(label: string) {
  const search = await screen.findByRole("combobox", { name: "搜索理解星图" });
  fireEvent.change(search, { target: { value: label } });
  const listbox = await screen.findByRole("listbox", { name: "搜索结果" });
  // 结果项的可及名里还有节点类型与状态，所以按包含匹配。
  fireEvent.click(await within(listbox).findByRole("option", { name: new RegExp(label) }));
  return screen.findByRole("complementary", { name: "星体详情" });
}

describe("星图三层展开 · 39d W8-1 §11.2", () => {
  it("按笔记读时连续换篇，册页保持展开，隐藏画布索引不抢键盘焦点", async () => {
    stubGateway({ snapshot: RICH_SNAPSHOT, deepening: RICH_DEEPENING });
    render(<GraphSurface />);
    await screen.findByRole("combobox", { name: "搜索理解星图" });
    fireEvent.click(screen.getByRole("button", { name: "按笔记读" }));
    const shelf = document.querySelector<HTMLElement>(".universe-booklist")!;
    fireEvent.click(within(shelf).getByRole("button", { name: /索引与代价/ }));
    expect(screen.getByRole("button", { name: "按笔记读" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(shelf).getByRole("button", { name: /事务隔离级别/ }));
    expect(within(screen.getByRole("complementary", { name: "星体详情" })).getByRole("heading", { name: "事务隔离级别" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "按笔记读" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector('[aria-label^="星图节点索引"]')?.getAttribute("tabindex")).toBe("-1");
    fireEvent.click(screen.getByRole("button", { name: "在星图里看" }));
    expect(screen.getByRole("button", { name: "漫游星图" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(screen.getByRole("complementary", { name: "星体详情" })).getByRole("heading", { name: "事务隔离级别" })).toBeTruthy();
  });

  it("从学习足迹打开笔记再回来，保留册页、当前篇与阅读尺度", async () => {
    stubGateway({ snapshot: RICH_SNAPSHOT, deepening: RICH_DEEPENING });
    const invoke = vi.fn(); useRoomStore.setState({ invoke } as never);
    const view = render(<GraphSurface />);
    await screen.findByRole("combobox", { name: "搜索理解星图" });
    fireEvent.click(screen.getByRole("button", { name: "按笔记读" }));
    fireEvent.click(within(document.querySelector<HTMLElement>(".universe-booklist")!).getByRole("button", { name: /索引与代价/ }));
    const panel = screen.getByRole("complementary", { name: "星体详情" });
    fireEvent.click(within(panel).getByRole("button", { name: "学习足迹" }));
    await within(panel).findByText(/索引把要扫的行数降下来了/);
    document.querySelector(".universe-booklist__pages")!.scrollTop = 120;
    panel.querySelector(".universe-detail-body")!.scrollTop = 65;
    fireEvent.click(within(panel).getByRole("button", { name: "打开笔记" }));
    expect(invoke).toHaveBeenCalledWith("open-notebook");
    expect(useRoomStore.getState().noteReturnTo).toBe("graph");
    view.unmount(); render(<GraphSurface />);
    const returned = await screen.findByRole("complementary", { name: "星体详情" });
    await within(returned).findByText(/索引把要扫的行数降下来了/);
    expect(within(returned).getByRole("button", { name: "学习足迹" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "按笔记读" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => {
      expect(document.querySelector(".universe-booklist__pages")!.scrollTop).toBe(120);
      expect(returned.querySelector(".universe-detail-body")!.scrollTop).toBe(65);
    });
  });

  it("紧凑视口里在星图看这一篇会合上遮住星空的旁页", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation(query => ({
      matches: query.includes("max-width"), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } as unknown as MediaQueryList));
    stubGateway({ snapshot: RICH_SNAPSHOT, deepening: RICH_DEEPENING });
    render(<GraphSurface />);
    await screen.findByRole("combobox", { name: "搜索理解星图" });
    fireEvent.click(screen.getByRole("button", { name: "按笔记读" }));
    fireEvent.click(within(document.querySelector<HTMLElement>(".universe-booklist")!).getByRole("button", { name: /索引与代价/ }));
    const panel = screen.getByRole("complementary", { name: "星体详情" });
    fireEvent.click(within(panel).getByRole("button", { name: "在星图里看" }));
    expect(screen.getByRole("button", { name: "漫游星图" }).getAttribute("aria-pressed")).toBe("true");
    expect(panel.getAttribute("aria-hidden")).toBe("true");
    expect(panel.hasAttribute("inert")).toBe(true);
  });

  it("选中一篇笔记之后出现三个尺度；换层不换笔记，也只有这一排导航", async () => {
    stubGateway({ snapshot: RICH_SNAPSHOT, deepening: RICH_DEEPENING });
    render(<GraphSurface />);

    const drawer = await openNode("索引与代价");
    const tabs = within(drawer).getByRole("navigation", { name: "这一篇笔记的三个尺度" });
    const names = within(tabs).getAllByRole("button").map((button) => button.textContent);
    expect(names).toEqual(["笔记总览", "问题与关联", "学习足迹"]);
    expect(within(drawer).getAllByRole("heading", { name: "索引与代价" })).toHaveLength(1);
    expect(within(drawer).queryByText("节点类型")).toBeNull();

    // 换层：锚着的那一篇不变，而且**导航没有多出第二排**。
    fireEvent.click(within(tabs).getByRole("button", { name: "问题与关联" }));
    await waitFor(() => {
      expect(within(drawer).getAllByText("为什么有索引查询仍然可能慢").length).toBeGreaterThan(0);
    });
    // 层二里不再复述总览那一段的标题（否则"换层"读起来像换了一页）。
    expect(within(drawer).queryByText("索引与代价")).toBeNull();
    expect(within(drawer).getAllByRole("navigation", { name: "这一篇笔记的三个尺度" })).toHaveLength(1);

    fireEvent.click(within(tabs).getByRole("button", { name: "学习足迹" }));
    await waitFor(() => {
      expect(within(drawer).getByText(/索引把要扫的行数降下来了/)).toBeTruthy();
    });
    expect(within(drawer).getAllByRole("navigation", { name: "这一篇笔记的三个尺度" })).toHaveLength(1);
  });

  it("换一篇笔记会回到第一层，不带着上一层的内容跟过去", async () => {
    stubGateway({ snapshot: RICH_SNAPSHOT, deepening: RICH_DEEPENING });
    render(<GraphSurface />);

    const drawer = await openNode("索引与代价");
    fireEvent.click(within(drawer).getByRole("button", { name: "学习足迹" }));
    await waitFor(() => expect(within(drawer).getByText(/索引把要扫的行数降下来了/)).toBeTruthy());

    fireEvent.click(within(drawer).getByRole("button", { name: "关闭星体详情" }));
    const other = await openNode("事务隔离级别");
    const tabs = within(other).getByRole("navigation", { name: "这一篇笔记的三个尺度" });
    expect(within(tabs).getByRole("button", { name: "笔记总览" }).getAttribute("aria-current")).toBe("true");
    expect(within(other).getAllByText("事务隔离级别").length).toBeGreaterThan(0);
  });

  it("层一用一颗动作回同一篇笔记继续学习，不绕到卡片目标详情", async () => {
    const invoke = vi.fn();
    useRoomStore.setState({ invoke } as never);
    stubGateway({ snapshot: RICH_SNAPSHOT, deepening: RICH_DEEPENING });
    render(<GraphSurface />);

    const drawer = await openNode("索引与代价");
    fireEvent.click(within(drawer).getByRole("button", { name: /回笔记继续学习/ }));
    expect(invoke).toHaveBeenCalledWith("open-notebook");
    expect(useRoomStore.getState().activeNoteRef?.noteId).toBe(NOTE_ID);
    expect(within(drawer).queryByRole("button", { name: /打开这一篇笔记/ })).toBeNull();
  });

  it("层二给「打开某个学习位置」「查看关系理由」「打开对应卡片」（§11.2 第二行的主要动作）", async () => {
    const invoke = vi.fn();
    useRoomStore.setState({ invoke } as never);
    stubGateway({ snapshot: RICH_SNAPSHOT, deepening: RICH_DEEPENING });
    render(<GraphSurface />);

    const drawer = await openNode("索引与代价");
    fireEvent.click(within(drawer).getByRole("button", { name: "问题与关联" }));

    // 「查看关系理由」：理由与关系在同一行，且标着它是待确认建议（§11.3）。
    await waitFor(() => {
      expect(within(drawer).getByText("选择率")).toBeTruthy();
      expect(within(drawer).getAllByText(/理解这条之前需要/).length).toBeGreaterThan(0);
      expect(within(drawer).getByText("待确认建议")).toBeTruthy();
    });

    // 「打开某个学习位置」沿着同篇笔记继续，卡片单独有一颗入口。
    fireEvent.click(within(drawer).getByRole("button", { name: /为什么有索引查询仍然可能慢/ }));
    expect(useRoomStore.getState().activeNoteRef?.noteId).toBe(NOTE_ID);
    expect(invoke).toHaveBeenCalledWith("open-notebook");

    // 「打开相应卡片」
    fireEvent.click(within(drawer).getAllByRole("button", { name: "打开对应卡片" })[0]);
    expect(useRoomStore.getState().activeObjectiveId).toBe(OBJECTIVE_ID);
    expect(invoke).toHaveBeenCalledWith("open-objective", expect.anything());
  });

  it("层三给「进入笔记旅程」与「打开相应卡片」，五格事实逐格出现（§11.2 第三行）", async () => {
    const invoke = vi.fn();
    useRoomStore.setState({ invoke } as never);
    stubGateway({ snapshot: RICH_SNAPSHOT, deepening: RICH_DEEPENING });
    render(<GraphSurface />);

    const drawer = await openNode("索引与代价");
    fireEvent.click(within(drawer).getByRole("button", { name: "学习足迹" }));
    await waitFor(() => expect(within(drawer).getByText(/索引把要扫的行数降下来了/)).toBeTruthy());

    // 原回答
    expect(within(drawer).getByText(/索引把要扫的行数降下来了/)).toBeTruthy();
    // 反馈（给人看的那一句）
    expect(within(drawer).getByText(/结果规模那一半还没有自己的例子/)).toBeTruthy();
    // 日期
    expect(within(drawer).getAllByText(/2026/).length).toBeGreaterThan(0);
    // 材料依据
    expect(within(drawer).getByText("讲义第 3 段：选择率与代价。")).toBeTruthy();
    // 可选卡片 + 进入笔记旅程
    fireEvent.click(within(drawer).getAllByRole("button", { name: "进入笔记旅程" })[0]);
    expect(invoke).toHaveBeenCalledWith("open-notebook");
  });

  it("结构化作答那一格如实是空的，不替她造一句「用户完成了这一步」", async () => {
    stubGateway({ snapshot: RICH_SNAPSHOT, deepening: RICH_DEEPENING });
    render(<GraphSurface />);

    const drawer = await openNode("索引与代价");
    fireEvent.click(within(drawer).getByRole("button", { name: "学习足迹" }));
    await waitFor(() => {
      expect(within(drawer).getByText(/这一步是结构化作答，没有一句可念的回答/)).toBeTruthy();
    });
    expect(within(drawer).queryByText(/用户完成/)).toBeNull();
  });
});

describe("状态三轴 · 39d W8-3 §11.4", () => {
  it("三轴分成三张带名字的纸签，各说各的话，不合成一句", async () => {
    stubGateway({ snapshot: RICH_SNAPSHOT, deepening: RICH_DEEPENING });
    render(<GraphSurface />);

    const drawer = await openNode("索引与代价");
    fireEvent.click(within(drawer).getByRole("button", { name: "问题与关联" }));

    const axes = await within(drawer).findByRole("group", { name: "三种状态（分开看，不合成一个）" });
    expect(within(axes).getByText("学习表现")).toBeTruthy();
    expect(within(axes).getByText("下一步")).toBeTruthy();
    expect(within(axes).getByText("内容适用性")).toBeTruthy();
    expect(within(axes).getByText("有一次是独立说出来的")).toBeTruthy();
    expect(within(axes).getByText("可以接着往下走")).toBeTruthy();
    expect(within(axes).getByText("依据还适用")).toBeTruthy();
    // 三张纸签，不是两张也不是四张。
    expect(within(axes).getAllByRole("term")).toHaveLength(3);
    expect(within(axes).getAllByRole("definition")).toHaveLength(3);
  });

  it("§11.4 逐字：不用条数、时长或比例画理解百分比——屏上没有一个百分号", async () => {
    stubGateway({ snapshot: RICH_SNAPSHOT, deepening: RICH_DEEPENING });
    render(<GraphSurface />);

    const drawer = await openNode("索引与代价");
    for (const tab of ["笔记总览", "问题与关联", "学习足迹"]) {
      fireEvent.click(within(drawer).getByRole("button", { name: tab }));
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => expect(within(drawer).queryAllByText(/%/).length).toBe(0));
    }
    expect(within(drawer).queryByText(/理解度|掌握度|进度\s*\d/)).toBeNull();
  });

  it("零记录时三轴说「还没有学习记录」，而不是「已掌握」或任何折算", async () => {
    stubGateway({ snapshot: BARE_NOTE_SNAPSHOT, deepening: BARE_DEEPENING });
    render(<GraphSurface />);

    const drawer = await openNode("索引与代价");
    fireEvent.click(within(drawer).getByRole("button", { name: "学习足迹" }));
    const axes = await within(drawer).findByRole("group", { name: "三种状态（分开看，不合成一个）" });
    expect(within(axes).getByText("还没有学习记录")).toBeTruthy();
    expect(within(drawer).queryByText(/已掌握|已学完|掌握/)).toBeNull();
  });
});

describe("没有记录时不伪造 · §11.2 逐字", () => {
  it("有正文、零目标、零记录：这一篇照样在，图层是空的而不是编的", async () => {
    stubGateway({ snapshot: BARE_NOTE_SNAPSHOT, deepening: BARE_DEEPENING });
    render(<GraphSurface />);

    const drawer = await openNode("索引与代价");
    fireEvent.click(within(drawer).getByRole("button", { name: "问题与关联" }));
    await waitFor(() => {
      expect(within(drawer).getByText("还没有形成任何目标，这里不替你编一条。")).toBeTruthy();
      expect(within(drawer).getByText(/没有可核对的关系。这里不替你推断/)).toBeTruthy();
    });

    fireEvent.click(within(drawer).getByRole("button", { name: "学习足迹" }));
    await waitFor(() => {
      expect(within(drawer).getByText("这一篇还没有学习记录。这里不替你造一条示例。")).toBeTruthy();
    });
  });

  it("有正文、零目标的笔记总览说「不需要先制卡」，不是「先形成学习卡」", async () => {
    stubGateway({ snapshot: BARE_NOTE_SNAPSHOT, deepening: BARE_DEEPENING });
    render(<GraphSurface />);

    const drawer = await openNode("索引与代价");
    await waitFor(() => {
      expect(within(drawer).getByText(/不需要先制卡/)).toBeTruthy();
    });
    expect(within(drawer).queryByText(/先形成学习卡|先去制卡|必须制卡/)).toBeNull();
  });
});

describe("等价列表与伴星座位 · 39d W8-3 §11.5、AGENTS.md", () => {
  it("「按笔记读」随时可切，列的是同一份读数，每一行都能继续学习", async () => {
    const invoke = vi.fn();
    useRoomStore.setState({ invoke } as never);
    stubGateway({ snapshot: RICH_SNAPSHOT, deepening: RICH_DEEPENING });
    render(<GraphSurface />);

    await screen.findByRole("region", { name: "理解星图：你的真实知识宇宙" });
    fireEvent.click(screen.getByRole("button", { name: "按笔记读" }));

    const list = await screen.findByRole("region", { name: "按笔记读星图（与星图等价）" });
    // 画布上有的笔记，册页上逐字都有（§11.2「有正文的笔记无需制卡即可出现」）。
    expect(within(list).getByText("索引与代价")).toBeTruthy();
    expect(within(list).getByText("事务隔离级别")).toBeTruthy();
    expect(within(list).getByText(/有来源 · 0 个目标/)).toBeTruthy();

    // 等价：同一个动作也有一颗，而且真的去同一处。
    fireEvent.click(within(list).getAllByRole("button", { name: /回笔记继续学习/ })[0]);
    expect(useRoomStore.getState().activeNoteRef?.noteId).toBe(NOTE_ID);
    expect(invoke).toHaveBeenCalledWith("open-notebook");
  });

  it("等价册页让开伴星的座位：左边距用的是共享座位预算，不是铺满整屏", () => {
      // 2026-09-30：本文件移进 `__tests__/`，**这里要上一层**——
  // `import.meta.dirname` 是「这个测试文件自己在哪儿」，它跟着文件一起下沉了，
  // 而被读的源码／样式表仍留在上一层。打包器不会替你改 `resolve(…, …)`。
const css = readFileSync(resolve(import.meta.dirname, "..", "understanding-universe.css"), "utf8");
    const at = css.indexOf(".universe-booklist {");
    expect(at).toBeGreaterThan(0);
    const block = css.slice(at, css.indexOf("}", at));
    expect(block).toMatch(/left:\s*calc\(var\(--universe-shell-left\)\s*\+\s*var\(--universe-seat-gutter\)\)/);
    // 铺满整屏（left: 0）会把她的座位盖住，AGENTS.md 明写不许。
    expect(block).not.toMatch(/left:\s*0\b/);
  });

});

describe("光痕与截断 · §11.4 逐字、§11.5", () => {
  // 「星体的光痕只有两档」这条原先是 `readFileSync(graph-surface.tsx)` 断言
  // `evidenceCoverage: evidenceDegreeForNode > 0 ? 1 : null`。它把本文件锁死在
  // 「graph-surface.tsx 必须留在同级目录」上，挡住拆分；而且它断言的是**源码里出现过
  // 那串字符**，不是行为。2026-09-29 搬到 `src/main/graph-surface-shape-guard.test.ts`
  // ——静态形状判据属于守卫，而且守卫在目录树里按文件名定位，组件搬家不会波及它。

  it("记录被截断时说清「只列到这里」，不报一个冒充总数的数字", async () => {
    stubGateway({
      snapshot: RICH_SNAPSHOT,
      deepening: { ...RICH_DEEPENING, recordsComplete: false },
    });
    render(<GraphSurface />);

    const drawer = await openNode("索引与代价");
    fireEvent.click(within(drawer).getByRole("button", { name: "学习足迹" }));
    await waitFor(() => {
      expect(within(drawer).getByText(/只列到这里 2 条，更早的还在服务器上/)).toBeTruthy();
    });
    // §11.5：截断时不得报"一共 N 条"。
    expect(within(drawer).queryByText(/一共\s*\d+\s*条/)).toBeNull();
  });
});
