// @vitest-environment jsdom

import { noteDocResult, seedUpdate } from "../../test-support/note-doc-fixtures";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { objectiveListItemV3Schema, type ObjectiveListItemV3 } from "@ailearn/shared/learning-objective-surface-contracts";
import { NotebookSurface } from "./notebook-surface";
import { ROUND_COPY, ROUND_PRESETS_V1 } from "./notebook-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 笔记页的那一颗主要动作（39d W4-2 第三刀）。
 *
 * 这一页过去只有"生成学习卡"一个动作，目标只是 meta 里的一行字（「学习卡：xxx」），
 * 于是"这一篇到底该做什么"要用户自己去列表里找。现在它按 `noteId` 读自己的目标，
 * 把服务端裁决好的那一个主行动画在正文上方。
 *
 * 这一组用例钉的是三件**没有别的层能替它证明**的事：
 *  1. 按钮上的动词与按下去的去处来自**同一个对象**（服务端那个 `primaryAction`）——
 *     这一页不另写词、也不自己拼一份 start；
 *  2. 这块是**增补**：读不到、读失败都不许把笔记本身顶掉（它过去整页只有笔记）；
 *  3. 取的是**这一篇**的目标，不是"最近更新的那一个"（同一次改动的服务端那一半
 *     已经有集测钉过，这里是桌面侧的最后一环）。
 *
 * 夹具走 `objectiveListItemV3Schema.parse`：合同与假数据漂移要红在这里，而不是红成
 * "页面上什么都没画"。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";
const OBJECTIVE_ID = "33333333-4333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

const START = {
  version: 2,
  originV2: { kind: "today", objectiveId: OBJECTIVE_ID },
  goal: "stabilize",
  requestedTimeBudgetSeconds: 180,
  responsePreference: "adaptive",
} as const;

/** 列表项夹具：默认"这一篇还没有学习记录"，各用例只覆盖自己要的那一格。 */
function listItem(overrides: Record<string, unknown> = {}): ObjectiveListItemV3 {
  return objectiveListItemV3Schema.parse({
    objectiveId: OBJECTIVE_ID,
    surfaceRevision: 1,
    conceptLabel: "惯性与质量",
    publicSummary: "质量是惯性大小的唯一量度。",
    knowledgeForm: "fact",
    cardStrategy: null,
    lifecycle: "active",
    freshness: "fresh",
    primaryNoteTitle: "物理笔记",
    createdAt: "2026-09-20T09:00:00.000Z",
    personalState: { state: "unvalidated", activeRunId: null },
    progress: {
      practiceTrailCount: 0,
      lastCanonicalAt: null,
      reviewDueAt: null,
      initialValidation: null,
      validationNotBefore: null,
    },
    primaryAction: { kind: "create_run", objectiveId: OBJECTIVE_ID, label: "开始学习", start: START },
    ...overrides,
  });
}

type Api = {
  objective: { list: ReturnType<typeof vi.fn> };
  learningRun: { start: ReturnType<typeof vi.fn> };
  note: { save: ReturnType<typeof vi.fn> };
  noteLearningRound: {
    open: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    revise: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
};

/**
 * 一条轮次回读（39d W4-3 第三刀）。`sourceContentHash` 用**真实主形状**（32 位 md5），
 * 不是随手写的 64 个 a——假回执照假形状写，测出来的就是假形状。
 */
function roundRow(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    roundId: "77777777-7777-4777-8777-777777777777",
    noteId: NOTE_ID,
    phase: "active",
    outcome: null,
    drivingQuestion: "判断为什么有索引，查询仍然可能慢",
    drivingQuestionSource: "suggested",
    drivingQuestionRevision: 1,
    noteVersionId: VERSION_ID,
    sourceContentHash: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    evidenceSnapshotIds: [],
    budgets: { maxModelCalls: 8, maxWallClockSeconds: 900, maxTasks: 6 },
    revision: 1,
    pausedAt: null,
    resumedAt: null,
    closedAt: null,
    createdAt: "2026-09-26T04:00:00.000Z",
    updatedAt: "2026-09-26T04:00:00.000Z",
    ...overrides,
  };
}

function installApi(
  list: () => Promise<unknown>,
  options: { syncController?: { fail: boolean }; manualSaveFails?: boolean; openRound?: Record<string, unknown> | null } = {},
): Api {
  const syncController = options.syncController ?? { fail: false };
  const api: Api = {
    objective: { list: vi.fn(list) },
    learningRun: {
      start: vi.fn(async () => ok({ runId: RUN_ID, snapshotId: "55555555-4555-4555-8555-555555555555" })),
    },
    noteLearningRound: {
      open: vi.fn(async () => ok(options.openRound ?? null)),
      create: vi.fn(async () => ok(roundRow())),
      revise: vi.fn(async () => ok(roundRow({ drivingQuestion: "先分清两种情况，再判断慢在哪一步", drivingQuestionRevision: 2, revision: 2 }))),
      close: vi.fn(async () => ok(roundRow({ phase: "closed", outcome: "partial", revision: 2, closedAt: "2026-09-26T05:00:00.000Z" }))),
    },
    note: {
      // 手动定版那一发（「先保存再开始」走它；自动保存**不**走它——自动那条只交
      // yjs 增量，见 `save()` 里 reason 那两个分支）。
      save: vi.fn(async () => (options.manualSaveFails
        ? { ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } }
        : ok({ savedAt: "2026-09-25T00:00:00.000Z" }))),
    },
  };
  Object.defineProperty(window, "ailearn", {
    configurable: true,
    value: {
      ...api,
      // 这四法挂在桥对象上，**不能**塞进下面那个 `note:` 键里——上一轮就是被它整个盖掉过
      // （`window.ailearn.note.save` 变 undefined，症状与"字没交出去"完全同形）。
      noteLearningRound: api.noteLearningRound,
      contract: { enabledRoutes: ["note.detail"] },
      auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "ws-1" } })) },
      room: {
        getProjection: vi.fn(async () => ok({ primaryFocus: { state: "empty" } })),
      },
      note: {
        // `api.note` 必须先摊开：这一整个 `note` 键会盖掉上面 `...api` 里那份，
        // 于是 `window.ailearn.note.save` 变成 undefined。真窗口里这一发是「手动定版」
        // 的唯一通道，盖掉它的下场是 `save("manual")` 抛 `not a function`、被 catch 咽成
        // 「保存失败」，读起来跟"字没交出去"一模一样——那两条挂起的用例卡的正是这里。
        ...api.note,
        get: vi.fn(async () => ok({
          noteId: NOTE_ID,
          title: "物理笔记",
          sourceId: null,
          currentVersionId: VERSION_ID,
          shareScope: "shared",
          permissions: { canEdit: true, canSave: true, canShare: false },
          currentVersion: {
            versionId: VERSION_ID,
            versionNo: 1,
            updatedAt: "2026-09-24T00:00:00.000Z",
            contentHash: "hash-abcdef12",
            blocks: [{ ordinal: 1, type: "paragraph", content: "质量是惯性大小的唯一量度。" }],
          },
        })),
        doc: {
          state: vi.fn(async () => noteDocResult({ update: seedUpdate("物理笔记", []) })),
          // 增量真正交出去的地方（自动保存与"先保存再开始"都走它）。给不出网关形状，
        // flush 就永远不收敛、`saving` 会一直挂着——那是夹具假象，不是产品行为。
        // 结果按**调用次**给：第一次是切回阅读态那次自动保存（要它失败，字才留得住），
        // 第二次才是手动那一发的 flush。
        syncUpdate: vi.fn(async () => (syncController.fail
          ? { ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } }
          : { ok: true as const, workspaceEpoch: 1, data: { via: "uploaded" as const, revision: 1, savedAt: new Date().toISOString() } })),
        // 保存失败时真实传输把本机草稿留住（draft-recovery 那组用例钉的就是它）。
        // 缺了这三个，失败路径会走进夹具造出来的假分支。
        draftGet: vi.fn(async () => ok({ draft: null })),
        draftSave: vi.fn(async () => ok({ saved: true })),
        draftClear: vi.fn(async () => ok({ cleared: true })),
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
      subscriptions: { subscribe: vi.fn(), unsubscribe: vi.fn(), onEvent: vi.fn(() => () => undefined) },
      shell: { openExternal: vi.fn(async () => ok({ opened: true })) },
    },
  });
  return api;
}

async function show(
  items: ObjectiveListItemV3[] | "fail",
  options: {
    mode?: "read" | "edit";
    makeDirty?: boolean;
    syncController?: { fail: boolean };
    manualSaveFails?: boolean;
    /** undefined = 这一篇没有未完成的那一轮；给了就是屏上该显示它。 */
    openRound?: Record<string, unknown> | null;
  } = {},
) {
  const syncController = options.syncController ?? { fail: false };
  const api = installApi(
    items === "fail"
      ? async () => { throw new Error("gateway offline"); }
      : async () => ok({
          version: 3,
          items,
          total: items.length,
          nextCursor: null,
          snapshotAt: new Date().toISOString(),
        }),
    { ...options, syncController },
  );
  const invoke = vi.fn();
  useRoomStore.setState({
    invoke,
    activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: options.mode ?? "read" },
  });
  vi.useFakeTimers();
  const view = render(<NotebookSurface />);
  for (let i = 0; i < 14; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  }
  if (options.makeDirty) {
    // 走真实的"草稿 → 防抖 → 保存"链路造脏（标题是那条链上的受控输入），
    // 不直接改内部状态——否则测的就不是产品会发生的那个"有未提交编辑"。
    const title = document.getElementById("notebook-surface-title") as HTMLInputElement | null;
    if (!title) throw new Error("标题输入框不在屏上：编辑态夹具没生效");
    await act(async () => { fireEvent.input(title, { target: { value: "改过的标题" } }); });
    // 再走真实的"切回阅读态"：`switchMode("read")` 会顺手发起一次自动保存，
    // 而主要动作那一行只在阅读态才画——"有未提交编辑"因此只可能在这里被用户看到。
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "预览此版本" }));
      await vi.advanceTimersByTimeAsync(50);
    });
  }
  return {
    ...view,
    api,
    syncController,
    invoke,
    objectiveBlock: () => view.container.querySelector<HTMLElement>(
      ".notebook-objective:not(.notebook-round)",
    ),
    roundBlock: () => view.container.querySelector<HTMLElement>(".notebook-round"),
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "ailearn");
  useRoomStore.setState({ activeNoteRef: null, invoke: undefined, surface: null, activeRunId: null, activeObjectiveId: null });
});

describe("笔记页的主要动作", () => {
  it("按钮上就是服务端那个动词，下面跟着它那一句理由", async () => {
    const { objectiveBlock } = await show([listItem()]);
    const block = objectiveBlock()!;
    expect(block.querySelector("button")!.textContent).toBe("开始学习");
    expect(block.querySelector("p")!.textContent).toBe("开始学习，完成后会写回这一题的真实状态。");
  });

  it("按下去发的是 action 自带的那份 start，开出来的那一轮随即接上旅程界面", async () => {
    const { api, invoke, objectiveBlock } = await show([listItem()]);
    fireEvent.click(objectiveBlock()!.querySelector("button")!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.learningRun.start).toHaveBeenCalledTimes(1);
    const input = api.learningRun.start.mock.calls[0][0] as { request: unknown };
    // 逐字节比：这一页若自己拼一份 start，最可能拼错的就是 origin 那一格
    // （无卡目标要 `today`，拼成 `card` 会在服务端 `target_evidence_missing` 上撞墙）。
    expect(input.request).toEqual(START);
    expect(invoke).toHaveBeenCalledWith("validate");
    expect(useRoomStore.getState().activeRunId).toBe(RUN_ID);
  });

  it("上一轮没答完：动词换成「继续作答」，按下去不许再开一轮", async () => {
    const { api, invoke, objectiveBlock } = await show([listItem({
      personalState: { state: "learning", activeRunId: RUN_ID },
      primaryAction: { kind: "resume_run", runId: RUN_ID, objectiveId: OBJECTIVE_ID },
    })]);
    const button = objectiveBlock()!.querySelector("button")!;
    expect(button.textContent).toBe("继续作答");
    expect(objectiveBlock()!.querySelector("p")!.textContent).toBe("上次保存的进度还在，不会从头再来。");
    fireEvent.click(button);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(invoke).toHaveBeenCalledWith("validate");
    expect(useRoomStore.getState().activeRunId).toBe(RUN_ID);
    expect(api.learningRun.start).not.toHaveBeenCalled();
  });

  it("这一篇还没有目标：主行动那一行不画，但轻量定向表单在（39d W4-3），笔记照旧在纸上", async () => {
    const { container, objectiveBlock, roundBlock } = await show([]);
    expect(objectiveBlock()).toBeNull();
    // 改判之后的新合同：没有目标这一档正是 §3.3 那张表单要出现的唯一时机。
    // 少这一句断言，"表单没画出来"也会让上面那条红看起来像一切正常。
    expect(roundBlock()).not.toBeNull();
    expect(roundBlock()!.querySelector("input#notebook-round-question")).not.toBeNull();
    expect(container.querySelector(".reading-body")?.textContent).toContain("质量是惯性大小的唯一量度。");
  });

  it("那一次读取失败不许把整篇笔记换成错误页", async () => {
    const { container, objectiveBlock, roundBlock } = await show("fail");
    expect(objectiveBlock()).toBeNull();
    // 目标读失败时表单仍在——它读的是另一条路由，两块互不顶替（也不互相连坐）。
    expect(roundBlock()).not.toBeNull();
    expect(container.querySelector(".reading-body")?.textContent).toContain("质量是惯性大小的唯一量度。");
  });

  it("读的是「这一篇」的目标，不是最近更新的那一个", async () => {
    const { api } = await show([listItem()]);
    const input = api.objective.list.mock.calls[0][0] as Record<string, unknown>;
    expect(input.noteId).toBe(NOTE_ID);
    expect(input.lifecycle).toBe("active");
    expect(input.limit).toBe(1);
  });

  it("只画服务端排在前面的那一个，同一篇上的第二个目标不并成第二颗按钮", async () => {
    const second = listItem({
      objectiveId: "66666666-4666-4666-8666-666666666666",
      primaryAction: { kind: "resume_run", runId: RUN_ID, objectiveId: "66666666-4666-4666-8666-666666666666" },
    });
    // 夹具故意回两条：`limit: 1` 只是请求，服务端真回几条不由客户端保证——
    // 这一页必须只取第一条，否则"一个主要动作"这句话就是空的。
    const { objectiveBlock } = await show([listItem(), second]);
    const buttons = [...objectiveBlock()!.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["开始学习"]);
  });

  it("正文已有新版本 ⇒ 主动作附一枚「来源已有更新」，最新时不画", async () => {
    const stale = await show([listItem({ freshness: "source_outdated" })]);
    const lines = [...stale.objectiveBlock()!.querySelectorAll("p")].map((p) => p.textContent);
    expect(lines).toEqual(["来源已有更新", "开始学习，完成后会写回这一题的真实状态。"]);

    const fresh = await show([listItem({ freshness: "fresh" })]);
    expect([...fresh.objectiveBlock()!.querySelectorAll("p")].map((p) => p.textContent))
      .toEqual(["开始学习，完成后会写回这一题的真实状态。"]);
  });

  it("开轮次在飞的时候按钮禁用，一次点击不开出两条", async () => {
    let release: (value: unknown) => void = () => undefined;
    const api = installApi(async () => ok({
      version: 3, items: [listItem()], total: 1, nextCursor: null, snapshotAt: new Date().toISOString(),
    }));
    api.learningRun.start.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    useRoomStore.setState({ invoke: vi.fn(), activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: "read" } });
    vi.useFakeTimers();
    const view = render(<NotebookSurface />);
    for (let i = 0; i < 14; i += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    }
    const button = view.container.querySelector<HTMLButtonElement>(".notebook-objective button")!;
    fireEvent.click(button);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.learningRun.start).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(api.learningRun.start).toHaveBeenCalledTimes(1);
    release(ok({ runId: RUN_ID, snapshotId: "55555555-4555-4555-8555-555555555555" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(button.disabled).toBe(false);
  });

  it("开轮次失败：那一行不消失，但把为什么写在按钮下面", async () => {
    const api = installApi(async () => ok({
      version: 3, items: [listItem()], total: 1, nextCursor: null, snapshotAt: new Date().toISOString(),
    }));
    api.learningRun.start.mockRejectedValue(new Error("offline"));
    useRoomStore.setState({ invoke: vi.fn(), activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: "read" } });
    vi.useFakeTimers();
    const view = render(<NotebookSurface />);
    for (let i = 0; i < 14; i += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    }
    const block = view.container.querySelector(".notebook-objective")!;
    fireEvent.click(block.querySelector("button")!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const alert = block.querySelector('[role="alert"]');
    // 取的是 `gatewayErrorMessage` 那一份唯一口径，不是这一页自己写的句子。
    expect(alert?.textContent).toBe("服务暂时没有返回可确认的结果。");
    // 也不能因为一次失败就把整行撤掉：她刚点过，行没了会被读成"没点上"。
    expect(block.querySelector("button")?.textContent).toBe("开始学习");
    expect(view.container.querySelector(".reading-body")?.textContent).toContain("质量是惯性大小的唯一量度。");
  });
});

/**
 * PRD §3.4（39d W4-4 第一半）：**有未提交编辑时，两条路都要在明处**。
 *
 * 以前这一页只有那一颗按服务端动词画的按钮：点了就按**上次已保存**的版本开轮次，
 * 眼前那几处字被默默忽略——用户以为自己刚写的东西算数。这一组钉四件事：
 *  1. 脏了就把两条路摆出来（服务端动词那颗让位，不再是"只有开始/退出"）；
 *  2. 「按上次已保存内容开始」原样开轮次，不替用户保存；
 *  3. 「先保存再开始」**先真的交出去**再开轮次；
 *  4. 保存失败就不开始——不建"看起来已开始"的空轮次。
 */
describe("笔记页的主要动作 · 有未提交编辑", () => {
  /**
   * 真实形状：编辑态改过字 → 切回阅读态时那次自动保存**没成功** → 字还在本机。
   * 每次调用都给**新的** `syncController`：这个开关用例会翻（失败→成功），
   * 共用一份就等于让上一条用例决定下一条的起点。
   */
  function dirtyFixture() {
    return { mode: "edit" as const, makeDirty: true, syncController: { fail: true } };
  }

  it("没交出去的字还在时：两条路都摆出来，那颗按服务端动词画的按钮让位", async () => {
    const { objectiveBlock } = await show([listItem()], dirtyFixture());
    const block = objectiveBlock()!;
    expect(block.querySelector(".notebook-objective__choices")).toBeTruthy();
    expect(screen.getByRole("button", { name: "先保存再开始" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "按上次已保存内容开始" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "开始学习" })).toBeNull();
    expect(block.textContent).toContain("这几处改动还没交出去");
  });

  it("「按上次已保存内容开始」：原样开轮次，不替用户再存一次", async () => {
    const { api } = await show([listItem()], dirtyFixture());
    const savesBeforeClick = api.note.save.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "按上次已保存内容开始" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.learningRun.start).toHaveBeenCalledTimes(1);
    expect(api.note.save.mock.calls.length).toBe(savesBeforeClick);
  });

  /**
   * 这两条过去挂着（`it.skip`），当时记的原因是"夹具里那条文档传输的失败/成功时序复现不出来"。
   * **那个归因是错的**：真因在夹具自己——`installApi` 里第二个 `note:` 键把 `...api` 摊进去的
   * 那份盖掉了，`window.ailearn.note.save` 于是是 undefined；点「先保存再开始」抛
   * `TypeError: api.note.save is not a function`，被 `save()` 的 catch 咽成一次"保存失败"，
   * 屏上留下的读数与"字没交出去"完全同形（`saveCalls=0`、`startCalls=0`、按钮既没禁用也没有
   * 保存在飞）。断言一直没改过：修的是夹具那一处覆盖（见 `installApi` 里的 `...api.note`）。
   */
  it("「先保存再开始」：先把字交出去，再开轮次", async () => {
    // 第一次（切回阅读态那次）失败，第二次（手动那一发）成功。
    const { api, syncController } = await show([listItem()], dirtyFixture());
    const savesBeforeClick = api.note.save.mock.calls.length;
    // 手动那一发要能交出去：把开关翻回来（这正是"再试一次"）。
    syncController.fail = false;
    fireEvent.click(screen.getByRole("button", { name: "先保存再开始" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(api.note.save.mock.calls.length).toBe(savesBeforeClick + 1);
    expect(api.learningRun.start).toHaveBeenCalledTimes(1);
  });

  it("保存失败就不开始：不建看起来已开始的空轮次", async () => {
    const { api, objectiveBlock, syncController } = await show([listItem()], {
      ...dirtyFixture(),
      manualSaveFails: true,
    });
    syncController.fail = false;
    const savesBeforeClick = api.note.save.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "先保存再开始" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(api.note.save.mock.calls.length).toBe(savesBeforeClick + 1);
    expect(api.learningRun.start).not.toHaveBeenCalled();
    // 失败要说得出口：这一页那条保存提示得亮（不是静默什么都不发生），
    // 而两条路仍在屏上——她可以再试一次，也可以按上次已保存的那一版开始。
    // 钉的是**这一发失败真该出现的那句话**：`note.save` 回来的是一条带
    // `code: "api_unavailable"` 的网关错误，所以屏上走 `gatewayErrorMessage` 那一条分支
    // （「学习服务暂时不可用；可以安全重试…」），不是非网关异常兜底的那句
    // 「服务暂时没有返回可确认的结果。」——这一行原先写的正是后者，是当时根本走不到
    // 失败分支时盲写的期望（见上面那段真因）。
    const alert = [...document.querySelectorAll('[role="alert"]')].find((node) =>
      (node.textContent ?? "").startsWith("保存没成功"));
    expect(alert?.textContent).toBe("保存没成功：学习服务暂时不可用；可以安全重试，不会重复创建学习旅程。重试保存");
    // 「可以安全重试」不是这句里的形容词：那颗按钮在这一刻必须真能点。
    expect(alert?.querySelector("button")?.disabled).toBe(false);
    expect(objectiveBlock()!.querySelector(".notebook-objective__choices")).toBeTruthy();
  });
});

/**
 * 笔记页的轻量定向表单（39d W4-3 第三刀；PRD §3.3、判据 §16.16）。
 *
 * 钉的是这四件别人替不了的：
 *  1. 空句子开不出一轮（按钮禁用，且 `create` 一次都不该被调）；
 *  2. 两个预设放的是**带这篇标题**的起步句，不是通用口号；
 *  3. 来源那一档说得出"这句话是谁定的"：原样用 = suggested，改过 = user_rewritten，
 *     没点预设自己写 = user_authored（§3.3 把"可改写"写成产品要求，这一档就是它的落点）；
 *  4. 已经有未完成那一轮时，屏上显示的是**服务端那一条**的问题，改写与收尾都带着
 *     它的 `revision`（不是本机猜的版本号）。
 */
describe("笔记页的轻量定向表单（39d W4-3 第三刀）", () => {
  it("空句子开不出一轮：按钮禁用，一次请求都不发", async () => {
    const { api, roundBlock } = await show([]);
    const start = [...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.start);
    expect(start).toBeTruthy();
    expect(start!.disabled).toBe(true);
    fireEvent.click(start!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.noteLearningRound.create).not.toHaveBeenCalled();
  });

  it("预设放的是带这篇标题的起步句，点预设不改它就记成 suggested", async () => {
    const { api, roundBlock } = await show([]);
    const chips = [...roundBlock()!.querySelectorAll("button")];
    const unfamiliar = chips.find((b) => b.textContent === ROUND_PRESETS_V1[0].label)!;
    fireEvent.click(unfamiliar);
    const input = roundBlock()!.querySelector("input#notebook-round-question") as HTMLInputElement;
    expect(input.value).toBe(ROUND_PRESETS_V1[0].starter("物理笔记"));
    expect(input.value).toContain("物理笔记");

    const start = chips.find((b) => b.textContent === ROUND_COPY.start)!;
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.noteLearningRound.create).toHaveBeenCalledTimes(1);
    expect(api.noteLearningRound.create.mock.calls[0][0]).toMatchObject({
      noteId: NOTE_ID,
      drivingQuestion: ROUND_PRESETS_V1[0].starter("物理笔记"),
      drivingQuestionSource: "suggested",
    });
  });

  it("在起步句上改一个字就换档成 user_rewritten；没点过预设则是 user_authored", async () => {
    const { api, roundBlock } = await show([]);
    const chips = [...roundBlock()!.querySelectorAll("button")];
    fireEvent.click(chips.find((b) => b.textContent === ROUND_PRESETS_V1[1].label)!);
    const input = roundBlock()!.querySelector("input#notebook-round-question") as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: input.value + "，以及它为什么值得记" } }); });
    fireEvent.click(chips.find((b) => b.textContent === ROUND_COPY.start)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.noteLearningRound.create.mock.calls[0][0].drivingQuestionSource).toBe("user_rewritten");

    cleanup();
    const second = await show([]);
    const secondInput = second.roundBlock()!.querySelector("input#notebook-round-question") as HTMLInputElement;
    await act(async () => { fireEvent.change(secondInput, { target: { value: "我自己想知道的那件事" } }); });
    fireEvent.click([...second.roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.start)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(second.api.noteLearningRound.create.mock.calls[0][0].drivingQuestionSource).toBe("user_authored");
  });

  it("有一轮在进行中：显示服务端那一条的问题，改写与收尾都带着它的 revision", async () => {
    const open = roundRow({ drivingQuestion: "判断为什么有索引，查询仍然可能慢", revision: 4 });
    const { api, roundBlock } = await show([], { openRound: open });
    expect(roundBlock()!.textContent).toContain(ROUND_COPY.openLine(open.drivingQuestion as string));
    expect(roundBlock()!.textContent).toContain(ROUND_COPY.revisedLine(1));

    const close = [...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.end)!;
    fireEvent.click(close);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.noteLearningRound.close.mock.calls[0][0]).toMatchObject({
      roundId: open.roundId,
      expectedRevision: 4,
      outcome: "partial",
    });
  });

  it("读那一轮失败不许把笔记本身顶掉（它是增补，不是页面的前提）", async () => {
    const { container, roundBlock } = await show([], { openRound: undefined });
    // 上面那条已经证明"没有轮次时表单在"；这一条要的是"读失败时表单也在、纸上还是笔记"。
    expect(roundBlock()).not.toBeNull();
    expect(container.querySelector(".reading-body")?.textContent).toContain("质量是惯性大小的唯一量度。");
  });
});
