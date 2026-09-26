// @vitest-environment jsdom

import { noteDocResult, seedUpdate } from "../../test-support/note-doc-fixtures";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { objectiveListItemV3Schema, type ObjectiveListItemV3 } from "@ailearn/shared/learning-objective-surface-contracts";
import type { NoteBlockProjectionV1 } from "@ailearn/shared/note-projection-contracts";
import { NotebookSurface } from "./notebook-surface";
import { ROUND_COPY, ROUND_PRESETS_V1, STRUCTURE_QUESTION_LABEL_MAX_V1, STRUCTURE_QUESTION_LIMIT_V1, roundPracticeStateLabelV1, structureQuestionCandidatesV1 } from "./notebook-surface";
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
    history: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    revise: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    teaching: ReturnType<typeof vi.fn>;
    explain: ReturnType<typeof vi.fn>;
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

const ROUND_ID = "77777777-7777-4777-8777-777777777777";

/**
 * 一条教学产物的回读（39d W4-6 刀二）。形状照线上合同写：解释与例子在 `content` 里，
 * 依据是块序号——它不是一段裸文本，也不是"根据笔记"一句话。
 */
function teachingRow(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    teachingId: "88888888-8888-4888-8888-888888888888",
    roundId: ROUND_ID,
    ordinal: 1,
    kind: "explanation",
    content: {
      explanation: "「间隔重复」这一节说的是：在快要忘记的时候再见到它。",
      example: "例如把新词放在第 1、3、7 天各见一次。",
    },
    sourceBlockOrdinals: [1, 2],
    createdAt: "2026-09-26T04:10:00.000Z",
    ...overrides,
  };
}

function installApi(
  list: () => Promise<unknown>,
  options: {
    syncController?: { fail: boolean };
    manualSaveFails?: boolean;
    openRound?: Record<string, unknown> | null;
    /** 这一篇的正文块。默认只有一段（即"没有小节"那一档，见结构另选那组用例）。 */
    blocks?: NoteBlockProjectionV1[];
    /** 轮次回读的第 N 次给什么（缺省 = 每次都给 `openRound` 那一份）。 */
    openSequence?: Record<string, unknown>[];
    /** 这一篇的轮次记录回读（缺省 = 空表，即"还没有过轮次"）。 */
    roundHistory?: Record<string, unknown>;
    /** 那一发读失败（走网关那一条形状）。 */
    roundHistoryFails?: boolean;
    /** 带游标那几发的回读，按调用次给（"更早的那一页、再更早的那一页"）。 */
    olderPages?: Record<string, unknown>[];
    /** 这一轮的解释（W4-6 刀二）；缺省 = 还没讲过。 */
    roundTeaching?: Record<string, unknown> | null;
    /** 解释那一读按调用次给（生成成功之后回读要拿到新的一条）。 */
    teachingSequence?: (Record<string, unknown> | null)[];
    /** 生成那一发失败（走网关那一条形状）。 */
    explainFails?: boolean;
    /** 这一轮练过的那几道（W4-6 刀三）；缺省 = 还没练过。 */
    practices?: Record<string, unknown>[];
    /** 「练一道」那一发的起点；缺省 = 没有（无目标轮次）。 */
    practiceStart?: Record<string, unknown> | null;
    /** 缺口帮助停止那一格（W4-6 刀四）；缺省 = 没停。 */
    gapHelp?: Record<string, unknown>;
  } = {},
): Api {
  const syncController = options.syncController ?? { fail: false };
  let openReads = 0;
  let olderPageReads = 0;
  let teachingReads = 0;
  const api: Api = {
    objective: { list: vi.fn(list) },
    learningRun: {
      start: vi.fn(async () => ok({ runId: RUN_ID, snapshotId: "55555555-4555-4555-8555-555555555555" })),
    },
    noteLearningRound: {
      // 读失败走网关那一条（`{ok:false}`），不是抛异常：与真桥同一形状。
      history: vi.fn(async (input?: { before?: string }) => (options.roundHistoryFails
        ? { ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } }
        // 带了游标就按调用次给"更早的那一页"：只有一页可给的话，"下一页是接上还是覆盖"
        // 这件事根本没被走过。
        : ok(input?.before && options.olderPages?.length
          ? options.olderPages[Math.min(olderPageReads++, options.olderPages.length - 1)]
          : options.roundHistory ?? { version: 1, noteId: NOTE_ID, items: [], hasMore: false, shownCount: 0, nextCursor: null }))),

      // 轮次的回读**按调用次**给：迟到那一发的场景必须是"第一次读到旧版、
    // 失败之后重读读到新版"，一份固定回读测不出"换回了现在那一版"。
    open: vi.fn(async () => {
      const rows = options.openSequence ?? [options.openRound ?? null];
      const read = Math.min(openReads, rows.length - 1);
      openReads += 1;
      return ok(rows[read] ?? null);
    }),
      // 解释那一读：按调用次给（首读"还没讲过"，生成之后回读拿到那一条）。
      // 生成那一发自己走网关形状：失败时屏上不许装作已经讲过。
      teaching: vi.fn(async () => {
        const rows = options.teachingSequence ?? [options.roundTeaching ?? null];
        const read = Math.min(teachingReads, rows.length - 1);
        teachingReads += 1;
        return ok({
          version: 1,
          round: options.openRound ?? roundRow(),
          teaching: rows[read] ?? null,
          practices: options.practices ?? [],
          practiceStart: options.practiceStart ?? null,
          gapHelp: options.gapHelp ?? { stopped: false, consecutiveHelpCount: 0, threshold: 2 },
        });
      }),
      explain: vi.fn(async () => (options.explainFails
        ? { ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } }
        : ok({ version: 1, round: options.openRound ?? roundRow(), teaching: teachingRow() }))),
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
        // 回读**按请求里那一篇**给：换篇的那条用例要看见另一篇，
        // 一份写死 id 的夹具会让"上一篇的翻页记录跟着过来"这件事根本发生不了。
        get: vi.fn(async (input?: { noteId?: string }) => ok({
          noteId: input?.noteId ?? NOTE_ID,
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
            blocks: options.blocks ?? [{ ordinal: 1, type: "paragraph", content: "质量是惯性大小的唯一量度。" }],
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
    blocks?: NoteBlockProjectionV1[];
    openSequence?: Record<string, unknown>[];
    roundHistory?: Record<string, unknown>;
    roundHistoryFails?: boolean;
    olderPages?: Record<string, unknown>[];
    roundTeaching?: Record<string, unknown> | null;
    teachingSequence?: (Record<string, unknown> | null)[];
    explainFails?: boolean;
    practices?: Record<string, unknown>[];
    practiceStart?: Record<string, unknown> | null;
    gapHelp?: Record<string, unknown>;
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

  /**
   * 2026-09-26 真窗口跑这张表单时抓到的第一个缺陷（`probe-note-round-form.mts`）：
   * 旧写法把"在途"与"空闲"接反了——已经有一轮在进行中、什么都没在跑的时候屏上写着
   * 「正在改写…」，而改写真的在跑时写着「正在开始…」。两档各钉一条，且必须同一条用例里
   * 钉（只看空闲那一半，"把两个标签对调"这种改法照样绿）。
   */
  it("那颗提交按钮：空闲时写动词，只有一次请求真的在途时才写「正在…」", async () => {
    const open = roundRow({ drivingQuestion: "判断为什么有索引，查询仍然可能慢", revision: 4 });
    const { api, roundBlock } = await show([], { openRound: open });
    fireEvent.click(screen.getByRole("button", { name: ROUND_COPY.revise }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const submit = roundBlock()!.querySelector<HTMLButtonElement>("button.primary");
    expect(submit?.textContent).toBe(ROUND_COPY.save);
    expect(submit?.disabled).toBe(false);

    // 把那一发吊住，才能在"请求在途"这段时间里读屏——不是读一个我以为存在的瞬间。
    let release: (value: unknown) => void = () => {};
    api.noteLearningRound.revise.mockImplementationOnce(
      () => new Promise((resolvePromise) => { release = resolvePromise; }),
    );
    fireEvent.click(submit!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(roundBlock()!.querySelector("button.primary")?.textContent).toBe(ROUND_COPY.saving);

    release(ok(roundRow({ drivingQuestion: "换成了一句新的", revision: 5 })));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(roundBlock()!.querySelector('[role="alert"]')).toBeNull();
  });

  it("读那一轮失败不许把笔记本身顶掉（它是增补，不是页面的前提）", async () => {
    const { container, roundBlock } = await show([], { openRound: undefined });
    // 上面那条已经证明"没有轮次时表单在"；这一条要的是"读失败时表单也在、纸上还是笔记"。
    expect(roundBlock()).not.toBeNull();
    expect(container.querySelector(".reading-body")?.textContent).toContain("质量是惯性大小的唯一量度。");
  });

  /** §16.16 第二半的夹具：这一篇有哪几块正文。 */
  const heading = (ordinal: number, content: string): NoteBlockProjectionV1 =>
    ({ ordinal, type: "heading", content });
  const paragraph = (ordinal: number, content: string): NoteBlockProjectionV1 =>
    ({ ordinal, type: "paragraph", content });

  it("判据：只认小节、取屏上那份字、复述题名与重复都不出、按块序取前三", () => {
    const found = structureQuestionCandidatesV1([
      paragraph(0, "开头一段没有小节的正文。"),
      heading(1, "**质量与惯性**"),
      heading(2, "两种理解"),
      heading(3, "两种理解"),
      heading(4, "物理笔记"),
      heading(5, "物理笔记（用于验证定义类知识能否产出选择题）"),
      heading(6, "第三个小节"),
      heading(7, "第四个小节"),
    ], "物理笔记");
    // `**` 是 markdown 的标记、不是屏上的字：拿原文出题会把标记带进这一句（`conceptMark` 头上记过同形返工）。
    expect(found.map((c) => c.label)).toEqual(["质量与惯性", "两种理解", "第三个小节"]);
    expect(found.length).toBe(STRUCTURE_QUESTION_LIMIT_V1);
    expect(found[0].question).toBe("先弄懂「质量与惯性」这一节在讲什么，以及它和整篇的关系");
    // 没有小节 ⇒ 一颗都不出（不拿段落第一句冒充标题，那是排版猜测）
    expect(structureQuestionCandidatesV1([paragraph(0, "只有一段。")], "物理笔记")).toEqual([]);
    // 空题名（刚建出来还没起名的那一篇）也要能出题：那道"以题名开头"的排除对空串
    // 会把**每一节**都判成复述题名，一颗都不剩。
    expect(structureQuestionCandidatesV1([heading(0, "两种理解")], "").map((c) => c.label)).toEqual(["两种理解"]);
    // 小节的存储形状**两种都有**（dev 库实测：6 条里 3 条带 `# `）：标记不许进标签，
    // 也不许进那句问话——教学面的依据标签共用同一份归一化。
    const marked = structureQuestionCandidatesV1([heading(0, "## 间隔重复")], "物理笔记");
    expect(marked.map((c) => c.label)).toEqual(["间隔重复"]);
    expect(marked[0].question).toBe("先弄懂「间隔重复」这一节在讲什么，以及它和整篇的关系");
  });

  it("标签可以截断，放进问话的那一句必须用完整小节名（真窗口实测：带省略号的半截话读不通）", () => {
    const long = "间隔重复与提取练习这两种做法在长期记忆上的差别到底在哪里";
    const [only] = structureQuestionCandidatesV1([heading(0, long)], "物理笔记");
    expect(only.label).toBe(`${long.slice(0, STRUCTURE_QUESTION_LABEL_MAX_V1)}…`);
    expect(only.question).toBe(`先弄懂「${long}」这一节在讲什么，以及它和整篇的关系`);
    expect(only.question).not.toContain("…");
  });

  it("有小节时那一组多摆几颗：点一颗放进来的就是带这节名字的问话，原样用记成 suggested", async () => {
    const { api, roundBlock } = await show([], {
      blocks: [paragraph(0, "开头一段。"), heading(1, "两种理解"), heading(2, "质量与惯性")],
    });
    expect(roundBlock()!.textContent).toContain(ROUND_COPY.fromStructure);
    const firstChip = [...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === "两种理解");
    expect(firstChip).toBeTruthy();
    fireEvent.click(firstChip!);
    const input = roundBlock()!.querySelector("input#notebook-round-question") as HTMLInputElement;
    expect(input.value).toBe("先弄懂「两种理解」这一节在讲什么，以及它和整篇的关系");
    fireEvent.click([...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.start)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.noteLearningRound.create.mock.calls[0][0]).toMatchObject({
      drivingQuestion: "先弄懂「两种理解」这一节在讲什么，以及它和整篇的关系",
      drivingQuestionSource: "suggested",
    });
    // 在放进来的那句上改一个字 ⇒ 换档（"这句话是谁定的"跟着真实动作走，不是跟着入口走）
    const again = await show([], {
      blocks: [heading(1, "两种理解")],
    });
    // 两次 render 在同一份 document 里共存 ⇒ 第二次的点击要**限定在那一块里找**，
    // 不能用 `screen.getByRole`（那会命中上一次渲染的同名那颗）。
    const chip = [...again.roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === "两种理解");
    expect(chip).toBeTruthy();
    fireEvent.click(chip!);
    const second = again.roundBlock()!.querySelector("input#notebook-round-question") as HTMLInputElement;
    await act(async () => { fireEvent.change(second, { target: { value: `${second.value}，从哪一步开始` } }); });
    fireEvent.click([...again.roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.start)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(again.api.noteLearningRound.create.mock.calls[0][0].drivingQuestionSource).toBe("user_rewritten");
  });

  /** 迟到的那一发（§16.39 那一族在笔记页的落点）：服务端拒掉之后不许让她对着一句作废的话。 */
  const CONFLICT = { ok: false as const, error: { code: "conflict", safeMessageKey: "error.conflict", retry: "user_action" } };
  const CONFLICT_TEXT = "这条学习状态已经发生变化，请先同步后再继续。";

  it("改写这一发迟到了：那一行换回服务端现在的那一版，失败那句照留", async () => {
    const before = roundRow({ drivingQuestion: "本机读到的那一版", revision: 1 });
    const now = roundRow({ drivingQuestion: "另一端改过的那一版", drivingQuestionRevision: 2, revision: 5 });
    const { api, roundBlock } = await show([], { openRound: before, openSequence: [before, now] });
    api.noteLearningRound.revise.mockResolvedValue(CONFLICT);
    fireEvent.click([...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.revise)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const input = roundBlock()!.querySelector("input#notebook-round-question") as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: "本机这一发是迟到的" } }); });
    fireEvent.click([...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.save)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    const shown = roundBlock()!.textContent ?? "";
    expect(shown).toContain(ROUND_COPY.openLine("另一端改过的那一版"));
    // 作废的那一句不再挂在屏上（输入框里她那份字还在状态里，但那一行说的是现在的事实）。
    expect(shown).not.toContain("本机这一发是迟到的");
    expect(roundBlock()!.querySelector('[role="alert"]')?.textContent).toBe(CONFLICT_TEXT);
    expect(api.noteLearningRound.revise).toHaveBeenCalledTimes(1);
  });

  it("对照：这一发赶上了——屏上就是新的那一条，也没有告警", async () => {
    const before = roundRow({ drivingQuestion: "本机读到的那一版", revision: 1 });
    const after = roundRow({ drivingQuestion: "本机这一发赶上了", drivingQuestionRevision: 2, revision: 2 });
    const { api, roundBlock } = await show([], { openRound: before, openSequence: [before, after] });
    api.noteLearningRound.revise.mockResolvedValue(ok(after));
    fireEvent.click([...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.revise)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const input = roundBlock()!.querySelector("input#notebook-round-question") as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: "本机这一发赶上了" } }); });
    fireEvent.click([...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.save)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    const shown = roundBlock()!.textContent ?? "";
    expect(shown).toContain(ROUND_COPY.openLine("本机这一发赶上了"));
    expect(roundBlock()!.querySelector('[role="alert"]')).toBeNull();
  });

  it("收尾这一发迟到了：那一行不撤（撤了会被读成「已经收尾」），并换回现在那一版", async () => {
    const before = roundRow({ drivingQuestion: "本机读到的那一版", revision: 1 });
    const now = roundRow({ drivingQuestion: "另一端推进过的那一版", revision: 5 });
    const { api, roundBlock } = await show([], { openRound: before, openSequence: [before, now] });
    api.noteLearningRound.close.mockResolvedValue(CONFLICT);
    fireEvent.click([...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.end)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    const shown = roundBlock()!.textContent ?? "";
    expect(shown).toContain(ROUND_COPY.openLine("另一端推进过的那一版"));
    expect(shown).not.toContain(ROUND_COPY.openLine("本机读到的那一版"));
    expect(roundBlock()!.querySelector('[role="alert"]')?.textContent).toBe(CONFLICT_TEXT);
  });

  it("没有小节的笔记不许多出那一行（结构是这篇的事实，不是界面的装饰）", async () => {
    const { roundBlock } = await show([]);
    // 对照在上一条：有小节时这一行一定出现，所以这里的"没有"测的是判据不是拼写。
    expect(roundBlock()!.textContent).not.toContain(ROUND_COPY.fromStructure);
  });
});

/**
 * 这一篇的轮次记录（PRD §10.3 读侧第一刀；39d W4-5 第四刀）。
 *
 * 钉的是四件**只有渲染层能钉**的：
 *  1. 每一行把日期、状态那一格、那一轮的问题原文放在**同一行**上；
 *  2. 状态那一格只有一个来源（`roundHistoryStateLabelV1`）：终态才看收尾原因；
 *  3. 数量那句话不替整篇报假总数（只回了最近几条时不说"开过 N 轮"）；
 *  4. 这一发读失败不许把笔记本身顶掉。
 */
function historyItem(overrides: Record<string, unknown> = {}) {
  return {
    roundId: "aaaaaaaa-1111-4111-8111-111111111111",
    phase: "closed",
    outcome: "partial",
    drivingQuestion: "判断为什么有索引，查询仍然可能慢",
    drivingQuestionSource: "suggested",
    drivingQuestionRevision: 1,
    startedAt: "2026-09-24T02:00:00.000Z",
    closedAt: "2026-09-24T03:00:00.000Z",
    ...overrides,
  };
}

function historyOf(items: Record<string, unknown>[], hasMore = false) {
  // 真合同那五格（`hasMore` 为真时必须带游标；`shownCount` 由服务端报）。
  const last = items[items.length - 1] as { roundId?: string } | undefined;
  return {
    version: 1,
    noteId: NOTE_ID,
    items,
    hasMore,
    shownCount: items.length,
    nextCursor: hasMore ? (last?.roundId ?? null) : null,
  };
}

function historyRows(): string[] {
  return [...document.querySelectorAll(".notebook-round-history__list li")].map((row) => row.textContent ?? "");
}

describe("这一篇的轮次记录（§10.3 读侧）", () => {
  it("每一行：日期、状态那一格、那一轮的问题原文，都在同一行上", async () => {
    await show([], {
      roundHistory: historyOf([
        historyItem({ roundId: "bbbbbbbb-1111-4111-8111-111111111111", drivingQuestion: "第二轮的那句问题", outcome: "superseded" }),
        historyItem({ roundId: "cccccccc-1111-4111-8111-111111111111", drivingQuestion: "第一轮的那句问题" }),
      ]),
    });
    const rows = historyRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("第二轮的那句问题");
    expect(rows[0]).toContain("被新的一轮替掉");
    expect(rows[1]).toContain("先到这里");
    // 日期是真格式化出来的：只断言"含数字"太宽（startedAt 写成什么都含数字）。
    expect(/年.*月.*日/.test(rows[0])).toBe(true);
  });

  it("状态那一格只有一个来源：终态看收尾原因，未完成的只看状态、不猜原因", async () => {
    await show([], {
      roundHistory: historyOf([
        historyItem({ roundId: "11111111-2222-4222-8222-222222222222", phase: "active", outcome: null, closedAt: null }),
        historyItem({ roundId: "22222222-3333-4333-8333-333333333333", phase: "paused", outcome: null, closedAt: null }),
        historyItem({ roundId: "33333333-4444-4444-8444-444444444444", outcome: "completed", closedAt: "2026-09-25T03:00:00.000Z" }),
        historyItem({ roundId: "44444444-5555-4555-8555-555555555555", outcome: "system_failure", closedAt: "2026-09-25T04:00:00.000Z" }),
      ]),
    });
    const states = [...document.querySelectorAll(".notebook-round-history__list li")]
      .map((row) => row.querySelectorAll("span")[1].textContent?.trim());
    expect(states).toEqual(["正在进行", "停住了", "走完了", "中途出了问题"]);
  });

  it("翻两页都接在后面；翻到最后一页才许说「开过 N 轮」，那颗也随之消失", async () => {
    const c1 = "77777777-8888-4888-8888-888888888888";
    const c2 = "66666666-7777-4777-8777-777777777777";
    const c3 = "55555555-6666-4666-8666-666666666666";
    const { api, container } = await show([], {
      roundHistory: historyOf([historyItem({ roundId: c1 })], true),
      olderPages: [
        historyOf([historyItem({ roundId: c2 })], true),
        historyOf([historyItem({ roundId: c3 })], false),
      ],
    });
    const lead = () => container.querySelector(".notebook-round-history p")?.textContent ?? "";
    const rows = () => container.querySelectorAll(".notebook-round-history__list li").length;
    const button = () => container.querySelector(".notebook-round-history button");
    expect(lead()).toContain("这一篇列到这里 1 轮，更早的还能看。");
    expect(lead()).not.toContain("这一篇开过");

    fireEvent.click(button()!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(rows()).toBe(2);
    expect(api.noteLearningRound.history.mock.calls[1][0]).toMatchObject({ before: c1 });

    fireEvent.click(button()!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    // 第二页是**接在**第一页后面：覆盖式实现到这里只会剩 1 行。
    expect(rows()).toBe(3);
    expect(api.noteLearningRound.history.mock.calls[2][0]).toMatchObject({ before: c2 });
    expect(lead()).toContain("这一篇开过 3 轮。");
    expect(button()).toBeNull();
  });

  it("取下一页失败时不假装翻到了：那一页不加进来，话要说得出口", async () => {
    const { container } = await show([], {
      roundHistory: historyOf([historyItem({ roundId: "99999999-1111-4111-8111-111111111111" })], true),
      olderPages: [{ version: 1, noteId: NOTE_ID, items: [], hasMore: true, shownCount: 0, nextCursor: null }],
    });
    const before = container.querySelectorAll(".notebook-round-history__list li").length;
    fireEvent.click(container.querySelector(".notebook-round-history button")!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(container.querySelectorAll(".notebook-round-history__list li").length).toBe(before);
  });

  it("翻出来的那几页跟着那一篇走：切到另一篇时不许把上一篇的更早记录接上", async () => {
    const { container } = await show([], {
      roundHistory: historyOf([
        historyItem({ roundId: "aaaa1111-1111-4111-8111-111111111111" }),
        historyItem({ roundId: "aaaa2222-2222-4222-8222-222222222222" }),
      ], true),
      olderPages: [historyOf([historyItem({ roundId: "aaaa3333-3333-4333-8333-333333333333" })], false),],
    });
    fireEvent.click(container.querySelector(".notebook-round-history button")!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(container.querySelectorAll(".notebook-round-history__list li")).toHaveLength(3);

    useRoomStore.setState({
      activeNoteRef: { noteId: "bbbb1111-1111-4111-8111-111111111111", noteVersionId: VERSION_ID, mode: "read" },
    });
    for (let i = 0; i < 6; i += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    }
    // 另一篇的第一页还是那两条（同一份回读），但**不该**再带着上一篇翻出来的那一条。
    expect(container.querySelectorAll(".notebook-round-history__list li")).toHaveLength(2);
  });

  it("这一篇还没有过轮次 ⇒ 那一块根本不在（不给页面添一行空话）", async () => {
    const { container } = await show([]);
    // 缺省回读是空表；上面几条已经证明"有记录时这一块在"，所以这里的"不在"测的是判据。
    expect(container.querySelector(".notebook-round-history")).toBeNull();
  });

  it("读记录失败不许把笔记顶掉：那一块不出现，纸上还是笔记", async () => {
    const { api, container } = await show([], { roundHistoryFails: true });
    expect(api.noteLearningRound.history).toHaveBeenCalled();
    expect(container.querySelector(".notebook-round-history")).toBeNull();
    expect(container.querySelector(".reading-body")?.textContent).toContain("质量是惯性大小的唯一量度。");
    // 对照：同一页上"未完成那一轮"照常画（失败只撤掉它自己那一块，不牵连别人）。
    expect(container.querySelector(".notebook-round")).toBeTruthy();
  });
});

/**
 * 教学面（39d W4-6 刀二）。
 *
 * 这一组钉四件**别的层替它证不了**的事：
 *  1. 讲没讲过这件事只由服务端说：还没讲过就一颗按钮，点下去带着**读过的那一版** `revision`
 *     发一发；成功了屏上那句解释来自服务端回读，不是本机拼的；
 *  2. 依据要点得动：那一段真的有锚点、点一颗会把它标出来并滚过去，高亮自己会过期；
 *  3. 快照不是屏幕上这一版时**不摆依据**（正文后来改过，块序号已经不是同一份材料），
 *     并如实说一句——不假装定位得到；
 *  4. 生成失败不装作已经讲过：错的句子照实说，那颗按钮还在。
 */
describe("笔记页的教学面（39d W4-6 刀二）", () => {
  it("还没讲过：只有那颗按钮；点它带着 revision 发一发，屏上换成服务端回读的那条解释", async () => {
    const open = roundRow({ revision: 3 });
    const teaching = teachingRow();
    const { api, roundBlock } = await show([], {
      openRound: open,
      teachingSequence: [null, teaching],
    });
    const block = roundBlock()!;
    expect(block.querySelector(".notebook-round-teaching__text")).toBeNull();
    const start = [...block.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.teaching.start)!;
    expect(start).toBeTruthy();
    fireEvent.click(start);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.noteLearningRound.explain.mock.calls[0][0]).toMatchObject({
      roundId: ROUND_ID,
      expectedRevision: 3,
    });
    // 屏上那一句是**回读**来的（第二读），不是发出去那一发自己拼的。
    expect(roundBlock()!.querySelector(".notebook-round-teaching__text")?.textContent)
      .toBe(teaching.content.explanation);
    expect(api.noteLearningRound.teaching).toHaveBeenCalledTimes(2);
  });

  it("讲过了：解释、例子与依据都在；点一颗依据会把那一段标出来并滚过去，高亮自己过期", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const blocks: NoteBlockProjectionV1[] = [
      { ordinal: 1, type: "heading", content: "## 间隔重复" },
      { ordinal: 2, type: "paragraph", content: "间隔重复说的是在快要忘记的时候再见到它。" },
    ];
    const teaching = teachingRow({ sourceBlockOrdinals: [1, 2] });
    const { roundBlock, container } = await show([], {
      openRound: roundRow(),
      blocks,
      roundTeaching: teaching,
    });
    const block = roundBlock()!;
    expect(block.querySelector(".notebook-round-teaching__text")?.textContent).toBe(teaching.content.explanation);
    expect(block.textContent).toContain(`${ROUND_COPY.teaching.exampleLead}${teaching.content.example}`);
    expect(block.textContent).toContain(ROUND_COPY.teaching.referencesLead);
    // 那一颗的字**从材料里取**（小节取标题），不是"第 N 段"这种编号冒充。
    const chip = [...block.querySelectorAll(".notebook-round-teaching__references button")]
      .find((b) => b.textContent === "小节「间隔重复」")!;
    expect(chip).toBeTruthy();
    scrollIntoView.mockClear();
    fireEvent.click(chip);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const target = container.querySelector<HTMLElement>('[data-block-ordinal="1"]')!;
    expect(target.getAttribute("data-block-focused")).toBe("true");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    // 高亮只是"我在这儿"，过期就撤——不留"上次点到哪"这种会跟人走的读数。
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(container.querySelector('[data-block-ordinal="1"]')!.getAttribute("data-block-focused")).toBeNull();
  });

  it("快照不是屏幕上这一版：依据不摆，换一句如实的话", async () => {
    const { roundBlock } = await show([], {
      openRound: roundRow({ noteVersionId: "99999999-9999-4999-8999-999999999999" }),
      roundTeaching: teachingRow({ sourceBlockOrdinals: [1, 2] }),
    });
    const block = roundBlock()!;
    expect(block.querySelector(".notebook-round-teaching__text")).toBeTruthy();
    expect(block.querySelectorAll(".notebook-round-teaching__references").length).toBe(0);
    expect(block.textContent).toContain(ROUND_COPY.teaching.staleVersion);
  });

  it("依据的序号在屏幕这一版里对不上：不瞎画，也不说那句「正文改过」", async () => {
    const { roundBlock } = await show([], {
      openRound: roundRow(),
      blocks: [{ ordinal: 9, type: "paragraph", content: "这一段与那条解释无关。" }],
      roundTeaching: teachingRow({ sourceBlockOrdinals: [42] }),
    });
    const block = roundBlock()!;
    expect(block.querySelectorAll(".notebook-round-teaching__references").length).toBe(0);
    expect(block.textContent).not.toContain(ROUND_COPY.teaching.staleVersion);
  });

  it("生成失败：那句错上屏，且屏上不装作已经讲过（按钮还在）", async () => {
    const { api, roundBlock, container } = await show([], { openRound: roundRow(), explainFails: true });
    const block = roundBlock()!;
    fireEvent.click([...block.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.teaching.start)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.noteLearningRound.explain).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".notebook-round-teaching__text")).toBeNull();
    expect([...block.querySelectorAll("button")].some((b) => b.textContent === ROUND_COPY.teaching.start)).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });
});

/**
 * 轮次里的练习（39d W4-6 刀三）。
 *
 * 这一组钉三件别的层替它证不了的事：
 *  1. 「练一道」只在**服务端给了起点**时出现（无目标的轮次没有这一颗），
 *     按下去发出去的就是服务端那一份 `start`——这一页不自己拼 goal／时长／锚点；
 *  2. 开出去之后接上旅程界面（与主要动作同一条路），不是"点了没反应"；
 *  3. 练过的几道在屏上带日期与结论，措辞由一处签发（结算后说结论、没结算说进行到哪）。
 */
describe("轮次里的练习（39d W4-6 刀三）", () => {
  const practiceStart = {
    objectiveId: OBJECTIVE_ID,
    start: {
      version: 2,
      originV2: {
        kind: "note_round",
        roundId: ROUND_ID,
        noteId: NOTE_ID,
        objectiveId: OBJECTIVE_ID,
      },
      goal: "stabilize",
      requestedTimeBudgetSeconds: 180,
      responsePreference: "adaptive",
    },
  };

  it("有起点才摆「练一道」：按下去发的就是服务端那一份 start，随即接上旅程界面", async () => {
    const { api, invoke, roundBlock } = await show([], {
      openRound: roundRow(),
      roundTeaching: teachingRow(),
      practiceStart,
    });
    const button = [...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.teaching.practice);
    expect(button).toBeTruthy();
    fireEvent.click(button!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.learningRun.start).toHaveBeenCalledTimes(1);
    const input = api.learningRun.start.mock.calls[0][0] as { request: unknown };
    // 逐字节比：这一页若自己拼一份 start，最可能拼错的就是锚点那一格
    // （note_round 的 objectiveId 是必填，缺了服务端会拒）。
    expect(input.request).toEqual(practiceStart.start);
    expect((input.request as { originV2: { kind: string } }).originV2.kind).toBe("note_round");
    expect(invoke).toHaveBeenCalledWith("validate");
    expect(useRoomStore.getState().activeRunId).toBe(RUN_ID);
  });

  it("没有起点（无目标的轮次）：不摆「练一道」，其余教学面照旧", async () => {
    const { roundBlock } = await show([], { openRound: roundRow(), roundTeaching: teachingRow() });
    const block = roundBlock()!;
    expect([...block.querySelectorAll("button")].some((b) => b.textContent === ROUND_COPY.teaching.practice)).toBe(false);
    // 对照：解释还在（"没有练一道"不是"整块没画"）。
    expect(block.querySelector(".notebook-round-teaching__text")).toBeTruthy();
  });

  it("练过的几道带日期与结论；没结算的那一场说「正在进行」", async () => {
    const { roundBlock } = await show([], {
      openRound: roundRow(),
      roundTeaching: teachingRow(),
      practices: [
        { runId: RUN_ID, phase: "completed", outcome: "declared_unable", startedAt: "2026-09-26T04:20:00.000Z" },
        {
          runId: "99999999-9999-4999-8999-999999999999",
          phase: "active",
          outcome: null,
          startedAt: "2026-09-26T05:20:00.000Z",
        },
      ],
    });
    const block = roundBlock()!;
    expect(block.textContent).toContain(ROUND_COPY.teaching.practicesLead);
    const items = [...block.querySelectorAll(".notebook-round-teaching__practice-list li")].map((li) => li.textContent?.trim() ?? "");
    expect(items.length).toBe(2);
    // 结算过的那一场说的是结论那一档的字（不是"完成了"这种笼统话）。
    expect(items[0]).toContain(roundPracticeStateLabelV1({ phase: "completed", outcome: "declared_unable" }));
    expect(items[0]).toContain("2026");
    // 还没结算的那一场说"正在进行"，不说结论。
    expect(items[1]).toContain("正在进行");
  });

  it("那一格的措辞由一处签发：七种结论各有自己的话，没结论时按 phase 说状态", () => {
    expect(roundPracticeStateLabelV1({ phase: "completed", outcome: "demonstrated" })).toBe("做出来了");
    expect(roundPracticeStateLabelV1({ phase: "completed", outcome: "needs_repair" })).toBe("还有一处要补");
    expect(roundPracticeStateLabelV1({ phase: "completed", outcome: "not_assessable" })).toBe("这一次判不了");
    expect(roundPracticeStateLabelV1({ phase: "active", outcome: null })).toBe("正在进行");
    expect(roundPracticeStateLabelV1({ phase: "paused", outcome: null })).toBe("停住了");
    expect(roundPracticeStateLabelV1({ phase: "cancelled", outcome: null })).toBe("中断了");
  });
});

/**
 * 缺口帮助停止之后的四选一（39d W4-6 刀四）。
 *
 * 这一组钉三件事：**停了才摆**（没停不许多一行）；四档里那三档真有去处——换解释走同一发
 * 生成的 `regenerate`（同一问题落第二条）、回材料核对把依据那段带到眼前、先结束收尾这一轮；
 * 唯一没接上的那档（补一节前置）**如实写出来**，不摆一颗按不动的按钮装作能用。
 */
describe("缺口帮助停止后的四选一（39d W4-6 刀四）", () => {
  const stopped = { stopped: true, consecutiveHelpCount: 2, threshold: 2 };

  it("停了才摆：那一句只说读数，四档都在（补前置如实说没接上）", async () => {
    const { roundBlock } = await show([], { openRound: roundRow(), roundTeaching: teachingRow(), gapHelp: stopped });
    const block = roundBlock()!;
    expect(block.querySelector(".notebook-round-teaching__stop")).toBeTruthy();
    expect(block.textContent).toContain(ROUND_COPY.teaching.stopLead(2));
    // 那句话是对**读数**说的，不许变成对用户的判断。
    expect(block.textContent).not.toContain("你没有改善");
    const labels = [...block.querySelectorAll(".notebook-round-teaching__stop-options button")].map((b) => b.textContent);
    expect(labels).toEqual([
      ROUND_COPY.teaching.switchExplanation,
      ROUND_COPY.teaching.backToMaterial,
      ROUND_COPY.teaching.endRound,
    ]);
    expect(block.textContent).toContain(ROUND_COPY.teaching.addPrerequisiteUnavailable);
    // 没接上的那一档**不是一颗按钮**（按不动的东西不该长得像能用）。
    expect(labels).not.toContain(ROUND_COPY.teaching.addPrerequisite);
  });

  it("没停就不摆那一块", async () => {
    const { roundBlock } = await show([], { openRound: roundRow(), roundTeaching: teachingRow() });
    expect(roundBlock()!.querySelector(".notebook-round-teaching__stop")).toBeNull();
  });

  it("「换一种解释」发的是 regenerate：同一问题落第二条，不是复用", async () => {
    const { api, roundBlock } = await show([], { openRound: roundRow(), roundTeaching: teachingRow(), gapHelp: stopped });
    const button = [...roundBlock()!.querySelectorAll(".notebook-round-teaching__stop-options button")]
      .find((b) => b.textContent === ROUND_COPY.teaching.switchExplanation)!;
    fireEvent.click(button);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.noteLearningRound.explain).toHaveBeenCalledTimes(1);
    expect(api.noteLearningRound.explain.mock.calls[0][0]).toMatchObject({ regenerate: true });
  });

  it("「回材料核对」把依据那一段带到眼前；「先结束这一轮」走的是收尾那一发", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const blocks: NoteBlockProjectionV1[] = [
      { ordinal: 1, type: "heading", content: "## 间隔重复" },
      { ordinal: 2, type: "paragraph", content: "间隔重复说的是在快要忘记的时候再见到它。" },
    ];
    const { api, roundBlock, container } = await show([], {
      openRound: roundRow({ revision: 5 }),
      blocks,
      roundTeaching: teachingRow({ sourceBlockOrdinals: [1, 2] }),
      gapHelp: stopped,
    });
    const options = (label: string) => [...roundBlock()!.querySelectorAll(".notebook-round-teaching__stop-options button")]
      .find((b) => b.textContent === label)!;

    scrollIntoView.mockClear();
    fireEvent.click(options(ROUND_COPY.teaching.backToMaterial));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-block-ordinal="1"]')!.getAttribute("data-block-focused")).toBe("true");

    fireEvent.click(options(ROUND_COPY.teaching.endRound));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.noteLearningRound.close.mock.calls[0][0]).toMatchObject({ expectedRevision: 5, outcome: "partial" });
  });
});
