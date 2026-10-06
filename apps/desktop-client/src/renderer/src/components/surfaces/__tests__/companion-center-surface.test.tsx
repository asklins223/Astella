// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GatewayResultV1, SessionContextV1 } from "@astella/shared/desktop-ipc-contracts";
import type {
  CompanionActivityDeliveryV1,
  CompanionActivityTimelineV1,
  CompanionDailyMonthV1,
  CompanionDailySummaryV1,
  CompanionHistoryItemV1,
  CompanionMemoryItemV1,
  CompanionMemoryRecycleListV1,
  CompanionMemoryStarMapV2,
  CompanionPersonaPendingV1,
  CompanionPersonaV1,
  CompanionPersonaProfileV1,
  CompanionPersonaVersionListV1,
} from "@astella/shared/companion-memory-desktop-contracts";
import type { CompanionOverview } from "@astella/shared/companion-shell-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompanionChatProvider,
  useCompanionChat,
  type CompanionUiMode,
} from "../../../app/companion-chat-session.tsx";
import { useRoomStore } from "../../../app/room-store.ts";
import { CompanionCenterSurface } from "../companion/companion-center-surface.tsx";
import { RendererGatewayError } from "../../../app/desktop-client.ts";
import { accountPreferenceRejectionMessage } from "@astella/shared/companion-memory-scope";

/**
 * 伴星中心与伴星叠加层是**兄弟节点**：一个在任务面里，一个挂在 App 外壳。
 * 两者共用同一条会话，所以 `CompanionChatProvider` 必须挂在两棵子树之上——
 * 曾经它只包住叠加层，surface 里的 `useCompanionChat()` 便在渲染时抛错，
 * 而应用没有 ErrorBoundary，点「伴星中心」= 整页黑屏。
 *
 * 这里的用例因此按真实外壳的形状渲染：Provider 在外，surface 在内。
 * 「继续交流」必须落到**同一条**会话上（叠加层的交互台读的就是它），
 * 所以断言读的是 Provider 的 mode，而不是 surface 自己的局部状态。
 */

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const discoveryEntry = () => ({
  entryId: "44444444-4444-4444-8444-a444444444444",
  kind: "diary_excerpt" as const,
  source: "diary" as const,
  sourceId: "d-2026-10-01",
  author: "assistant" as const,
  body: "嘿嘿，今天状态不错嘛。",
  annotation: null,
  visibility: "private" as const,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const UPDATED_AT = "2026-09-19T08:00:00.000Z";

function session(): SessionContextV1 {
  return {
    version: 1,
    status: "authenticated",
    user: { userId: "55555555-5555-4555-8555-555555555555", email: "reader@example.com" },
    workspace: {
      version: 1,
      workspaceId: WORKSPACE_ID,
      name: "理解空间",
      role: "owner",
      workspaceType: "personal",
      isPersonal: true,
      workspaceEpoch: 7,
    },
    membership: { role: "owner" },
    capabilities: null,
    workspaceEpoch: 7,
    credentialPersistence: "memory",
  };
}

function ok<T>(data: T): GatewayResultV1<T> {
  return {
    version: 1,
    ok: true,
    data,
    requestId: "companion-center-test",
    correlationId: "companion-center-test",
    schemaRevision: "desktop-ipc-v1",
  };
}

function memoryItem(): CompanionMemoryItemV1 {
  return {
    memoryItemId: MEMORY_ID,
    kind: "preference",
    content: "我更喜欢从例子开始理解概念",
    sourceEventId: null,
    sourceSessionId: null,
    sourceSpeaker: null,
    sourceBasis: null,
    appliesWhen: null,
    validFrom: null,
    validUntil: null,
    userStated: true,
    userConfirmed: true,
    candidate: false,
    importance: 0.9,
    confidence: 1,
    scope: "workspace",
    budgetTier: "resident",
    pinned: true,
    archived: false,
    dismissedAt: null,
    conflictGroup: null,
    embeddingStatus: "ready",
    sourceType: "confirmed",
    revision: 1,
    authorType: "user",
    authorId: "33333333-3333-4333-8333-333333333333",
    epistemicStatus: "supported",
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
  };
}

function secondMemoryItem(): CompanionMemoryItemV1 {
  return {
    ...memoryItem(),
    memoryItemId: "66666666-6666-4666-8666-666666666666",
    kind: "goal",
    content: "这个月完成力学复习",
    pinned: false,
  };
}

function starMap(): CompanionMemoryStarMapV2 {
  return {
    version: 2,
    nodes: [{
      memoryId: MEMORY_ID,
      kind: "preference",
      content: "我更喜欢从例子开始理解概念",
      state: "pinned",
      importance: 0.9,
      updatedAt: UPDATED_AT,
      entityLinks: [{
        entityType: "note",
        entityId: NOTE_ID,
        label: "牛顿第二定律笔记",
        target: { kind: "note", noteId: NOTE_ID },
        orphaned: false,
      }],
    }],
    cursor: null,
  };
}

function persona(): CompanionPersonaV1 {
  return {
    version: 1,
    profile: null,
    profileRevision: 0,
    relationship: { familiarity: 0, interactionCount: 0, lastActiveAt: null },
    presets: [],
    activePreset: null,
  };
}

function personaProfile(revision = 1): CompanionPersonaProfileV1 {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    userId: "55555555-5555-4555-8555-555555555555", presetId: null,
    name: "小星", personalityTags: ["温柔"], speakingStyle: "简洁", examples: [],
    activeness: "moderate", boundaries: { allowPlayful: true }, revision,
    createdAt: UPDATED_AT, updatedAt: UPDATED_AT,
  };
}

/** 日记页要能渲染出日期导航，前提是这一天的记录读得回来（默认 mock 是「读不到」）。 */
/**
 * 显式逐字段合并，而不是 `{ ...base, ...overrides }`。
 *
 * 原因：TS 会把「展开一个 Partial」建模成**所有键都变成可选**，于是返回值不再
 * 满足 `CompanionDailySummaryV1` 的必填约束（selectedId / revision 这些带
 * default 的列，输出类型里是必填的）。以前没有这列所以碰巧能过。
 *
 * 用 as 断言能"修好"，但那等于把这条夹具的类型检查关掉；逐字段写既过得了 tsc，
 * 也让"新增必填列"这件事在编译期照样能提醒人补默认值。
 */
function dailySummary(overrides: Partial<CompanionDailySummaryV1> = {}): CompanionDailySummaryV1 {
  return {
    version: overrides.version ?? 1,
    date: overrides.date ?? "2026-09-20",
    revision: overrides.revision ?? 1,
    status: overrides.status ?? "generated",
    generatedAt: overrides.generatedAt ?? "2026-09-20T16:00:00.000Z",
    failureReason: overrides.failureReason ?? null,
    selectionReason: overrides.selectionReason ?? null,
    selectedId: overrides.selectedId ?? null,
    blocks: overrides.blocks ?? [{ type: "text", text: "晚上十点他说想慢慢来，我就把复习那件事咽回去了。" }],
    memory: overrides.memory ?? null,
    // §10：隐藏是另一种语义，所以它是独立一列而不是 status 的一种取值。
    hidden: overrides.hidden ?? false,
    hiddenAt: overrides.hiddenAt ?? null,
  };
}

/**
 * 一份带「失效关联」的星图：正常实体与失效实体各一个，记忆节点一个。
 * 失效那条的 label 就是服务端那句「关联内容已不存在」——B4 之前它被当成一条
 * 正常记录平铺在索引第二位，读起来像一条真记录。
 */
function starMapWithOrphan(): CompanionMemoryStarMapV2 {
  return {
    version: 2,
    nodes: [{
      memoryId: MEMORY_ID,
      kind: "preference",
      content: "我更喜欢从例子开始理解概念",
      state: "pinned",
      importance: 0.9,
      updatedAt: UPDATED_AT,
      entityLinks: [
        { entityType: "note", entityId: NOTE_ID, label: "牛顿第二定律笔记", target: { kind: "note", noteId: NOTE_ID }, orphaned: false },
        { entityType: "source", entityId: "77777777-7777-4777-8777-777777777777", label: "关联内容已不存在", target: null, orphaned: true },
      ],
    }],
    cursor: null,
  };
}

function historyItem(): CompanionHistoryItemV1 {
  return {
    version: 1,
    messageId: MESSAGE_ID,
    role: "assistant",
    kind: "text",
    blocks: [{ type: "text", text: "可以先从这道例题入手。" }],
    runId: null,
    createdAt: UPDATED_AT,
    editedAt: null,
  };
}

function delivery(index: number): CompanionActivityDeliveryV1 {
  return {
    version: 1,
    deliveryId: `88888888-8888-4888-8888-88888888888${index}`,
    inboxSequence: index,
    state: "queued",
    kind: "memory_candidate",
    label: `待确认记忆 ${index}`,
    target: { kind: "memory", memoryId: MEMORY_ID },
    expired: false,
    createdAt: `2026-09-2${index}T08:00:00.000Z`,
    expiresAt: "2026-10-01T08:00:00.000Z",
  };
}

function installApi() {
  let accountOverview: CompanionOverview = {
    account: { revision: 0, epoch: 0, globalEnabled: true, diaryEnabled: true },
    onboardingStates: [],
  };
  const api = {
    auth: { getState: vi.fn(async () => ok(session())) },
    companion: {
      account: {
        getState: vi.fn(async () => ok(accountOverview)),
        patchState: vi.fn(async (input: { readonly request: { readonly diaryEnabled: boolean } }) => {
          accountOverview = {
            ...accountOverview,
            account: {
              ...accountOverview.account,
              revision: accountOverview.account.revision + 1,
              diaryEnabled: input.request.diaryEnabled,
            },
          };
          return ok(accountOverview.account);
        }),
      },
      bridge: {
        setContext: vi.fn(async () => ok({ version: 1, ok: true })),
        clearContext: vi.fn(async () => ok({ version: 1, ok: true })),
      },
      memory: {
        starMap: vi.fn(async () => ok(starMap())),
        list: vi.fn(async (_input: Parameters<Window["astella"]["companion"]["memory"]["list"]>[0]) => ok({ version: 2, items: [memoryItem()] })),
        revisions: vi.fn(async (input: { readonly memoryId: string }) => ok({
          version: 1 as const,
          memoryItemId: input.memoryId,
          items: [],
        })),
        create: vi.fn(async (_input: Parameters<Window["astella"]["companion"]["memory"]["create"]>[0]): Promise<GatewayResultV1<CompanionMemoryItemV1>> => ok(memoryItem())),
        correct: vi.fn(async (_input: Parameters<Window["astella"]["companion"]["memory"]["correct"]>[0]) => ok({ ...memoryItem(), revision: 2 })),
        archive: vi.fn(async () => ok({ ...memoryItem(), archived: true })),
        restore: vi.fn(async () => ok(memoryItem())),
        confirm: vi.fn(async () => ok(memoryItem())),
        remove: vi.fn(async () => ok({ version: 1, ok: true })),
        clear: vi.fn(async () => ok({ deletedCount: 1 })),
        recycleList: vi.fn(async (): Promise<GatewayResultV1<CompanionMemoryRecycleListV1>> => ok({ version: 1, items: [] })),
        conflicts: vi.fn(async () => ok({ version: 1, items: [] })),
        restoreDeleted: vi.fn(async () => ok(memoryItem())),
        erase: vi.fn(async () => ok({ version: 1, ok: true })),
        // 40 §7 发现簿。取消收藏回 `{ status }` 而不是记忆体（服务端 204）。
        discovery: {
          get: vi.fn(async () => ok({ version: 1, entries: [] as ReturnType<typeof discoveryEntry>[], studyVisible: [] as ReturnType<typeof discoveryEntry>[] })),
          collect: vi.fn(async () => ok({ status: "collected", entry: discoveryEntry() })),
          uncollect: vi.fn(async () => ok({ status: "uncollected" })),
          annotate: vi.fn(async () => ok({ status: "annotated" })),
          state: vi.fn(async () => ok({ collected: false, entryId: null, annotation: null })),
        },
      },
      persona: {
        get: vi.fn(async () => ok(persona())),
        versions: vi.fn(async (): Promise<GatewayResultV1<CompanionPersonaVersionListV1>> => ok({ version: 1, currentRevision: 0, versions: [] })),
        patch: vi.fn(async () => ok({ version: 1, profile: personaProfile() })),
        restore: vi.fn(async () => ok({ version: 1 as const, profile: personaProfile(), profileRevision: 2 })),
        reset: vi.fn(async () => ok({ version: 1 as const, ok: true as const, profileRevision: 2 })),
        // 「待生效版本」（40 §4.8.4 / A50）。默认没有排队——各用例再改成有。
        pending: vi.fn(async (): Promise<GatewayResultV1<CompanionPersonaPendingV1>> => ok({ version: 1, currentRevision: 0, pending: null })),
        stage: vi.fn(async () => ok({ version: 1 as const, pendingRevision: 2, profileRevision: 1 })),
        activate: vi.fn(async () => ok({ version: 1 as const, ok: true as const, profile: personaProfile(), profileRevision: 2 })),
      },
      history: {
        list: vi.fn(async (_input: { meta: unknown; query?: { before?: string; limit?: number; throughMessageId?: string } }) => ok({ version: 1, items: [historyItem()], nextCursor: null as string | null })),
        search: vi.fn(async (_input: { meta: unknown; query: { q: string; limit?: number } }) => ok({ version: 1, query: _input.query.q, items: [historyItem()] })),
        clear: vi.fn(async () => ok({ deletedCount: 1 })),
      },
      data: { deleteAudit: vi.fn(async () => ok({ deletedCount: 1 })) },
      learningContext: { get: vi.fn(async () => { throw new Error("learning context unavailable"); }) },
      journey: { bootstrap: vi.fn(async () => { throw new Error("journey unavailable"); }) },
      activity: {
        timeline: vi.fn(async (): Promise<GatewayResultV1<CompanionActivityTimelineV1>> => { throw new Error("activity unavailable"); }),
        ack: vi.fn(async () => ok({ ...delivery(1), state: "dismissed" as const })),
        present: vi.fn(async () => ok({ ...delivery(1), state: "displayed" as const })),
      },
      // 默认是"读不到"，各用例再 mockResolvedValue 成自己的形状。
      // 这里必须把返回类型标出来：不标的话 `async () => { throw }` 推成
      // `Promise<never>`，第一个 mockResolvedValue 就把 mock 钉死在那个对象上。
      daily: {
        hide: vi.fn(async () => ok({ version: 1, ok: true })),
        unhide: vi.fn(async () => ok({ version: 1, ok: true })),
        remove: vi.fn(async () => ok({ version: 1, ok: true })),
        // 参数也要标出来：不标的话 `calls` 推成空元组，用例里读 `calls.at(-1)[0].date`
        // 是类型错误——而 vitest 只剥类型不做检查，这条会一路绿到 typecheck。
        get: vi.fn(async (
          _request: { readonly meta: unknown; readonly date?: string },
        ): Promise<GatewayResultV1<CompanionDailySummaryV1>> => {
          throw new Error("daily unavailable");
        }),
        month: vi.fn(async (
          _request: { readonly meta: unknown; readonly month: string },
        ): Promise<GatewayResultV1<CompanionDailyMonthV1>> => {
          throw new Error("daily month unavailable");
        }),
      },
    },
    subscriptions: {
      subscribe: vi.fn(async () => ok({ version: 1, subscriptionId: "subscription-1" })),
      onEvent: vi.fn(() => () => undefined),
      unsubscribe: vi.fn(async () => ok({ version: 1, ok: true })),
    },
  };
  Object.defineProperty(window, "astella", { configurable: true, value: api });
  return api;
}

/** 外壳里同一条会话的读数：叠加层的交互台读的就是它。 */
let shellMode: CompanionUiMode | null = null;
function ShellSessionProbe() {
  shellMode = useCompanionChat().mode;
  return null;
}

beforeEach(() => {
  shellMode = null;
  useRoomStore.setState({ companionComposerDraft: "", companionCenterTarget: null });
  // jsdom 没有这两个浏览器接口，而星图画布组件在挂载时会用到它们。
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      media: "",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => null,
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "astella");
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(window, "ResizeObserver");
  Reflect.deleteProperty(HTMLCanvasElement.prototype, "getContext");
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  // 房间 store 是模块级单例，测试文件之间共用。
  useRoomStore.setState({ hudPage: "home", surface: null, companionCenterTarget: null });
  vi.restoreAllMocks();
});

function renderCompanionCenter() {
  // 与 App 同形：Provider 在两者之上，叠加层（探针）与任务面 surface 是兄弟。
  render(
    <CompanionChatProvider>
      <ShellSessionProbe />
      <CompanionCenterSurface />
    </CompanionChatProvider>,
  );
}

describe("重构后的伴星中心", () => {
  it("提供七个内容页面，规则与数据管理有独立设置入口", async () => {
    installApi(); renderCompanionCenter();
    expect(screen.getAllByRole("tab").map(tab => tab.textContent?.replace(/0[1-7]/g, ""))).toEqual(["近况", "对话", "日记", "记忆", "发现簿", "动态", "人格"]);
    expect(screen.getByRole("tablist", { name: "伴星中心分区" }).getAttribute("aria-orientation")).toBe("vertical");
    expect(await screen.findByRole("heading", { name: /接着聊/ })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "设置" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "伴星设置" }));
    expect(useRoomStore.getState().surface).toBe("settings");
    expect(useRoomStore.getState().settingsSection).toBe("companion");
  });

  it("竖排导航的上下与首尾键即时切页并保留焦点，隐藏页面不进入阅读路径", async () => {
    installApi(); renderCompanionCenter();
    await screen.findByRole("heading", { name: /接着聊/ });
    let current = screen.getByRole("tab", { name: "近况" });
    current.focus();
    for (const [key, label] of [["ArrowDown", "对话"], ["ArrowDown", "日记"], ["ArrowUp", "对话"], ["End", "人格"], ["Home", "近况"]]) {
      fireEvent.keyDown(current, { key });
      current = screen.getByRole("tab", { name: label });
      expect(document.activeElement).toBe(current);
      expect(current.getAttribute("aria-selected")).toBe("true");
      expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
      expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(current.id);
    }
    await screen.findByRole("heading", { name: /接着聊/ });
  });

  it("近况展示真实日记，只把提议计算为需要回应", async () => {
    const api = installApi();
    const proposal = { ...delivery(3), kind: "proposal" as const, target: { kind: "proposal" as const, proposalId: MESSAGE_ID } };
    api.companion.daily.get.mockResolvedValue(ok(dailySummary()));
    api.companion.activity.timeline.mockResolvedValue(ok({ version: 1, items: [delivery(1), proposal], nextCursor: 3, serverTime: UPDATED_AT }));
    renderCompanionCenter();
    expect(await screen.findByText("原文摘录")).toBeTruthy();
    expect(screen.getByText(/晚上十点他说想慢慢来/)).toBeTruthy();
    expect(await screen.findByText("1 件提议")).toBeTruthy();
    expect(screen.queryByText("待确认记忆 1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "读完整篇" }));
    expect(screen.getByRole("tab", { name: "日记" }).getAttribute("aria-selected")).toBe("true");
  });

  it("各块失败独立呈现，交流入口打开已有轻聊", async () => {
    const api = installApi();
    api.companion.daily.get.mockResolvedValue(ok(dailySummary({ status: "failed", blocks: [], failureReason: "model_unavailable" })));
    renderCompanionCenter();
    expect(await screen.findByText("这一天她没能写下来。")).toBeTruthy();
    expect(screen.getByText("动态暂时读不到。")).toBeTruthy();
    expect(screen.getByText("可以先从这道例题入手。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "开始交流" }));
    expect(shellMode).toBe("conversation");
    expect(screen.getByRole("tab", { name: "近况" }).getAttribute("aria-selected")).toBe("true");
  });

  it("未访问页面不读取数据，星图在明确打开时读取", async () => {
    const api = installApi(); renderCompanionCenter();
    await screen.findByRole("heading", { name: /接着聊/ });
    expect(api.companion.memory.list).not.toHaveBeenCalled();
    expect(api.companion.memory.starMap).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "记忆" }));
    await screen.findByRole("button", { name: /我更喜欢从例子开始理解概念/ });
    expect(api.companion.memory.starMap).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关联星图" }));
    expect((await screen.findByLabelText("星图节点列表")).textContent).toContain("牛顿第二定律笔记");
    expect(api.companion.memory.starMap).toHaveBeenCalledTimes(1);
  });

  it("记录页仅供查阅，切换页面和搜索保留轻聊草稿", async () => {
    installApi(); renderCompanionCenter();
    useRoomStore.setState({ companionComposerDraft: "我还想继续问这件事" });
    fireEvent.click(screen.getByRole("tab", { name: "对话" }));
    await screen.findByText("可以先从这道例题入手。");
    expect(screen.queryByRole("textbox", { name: /继续问/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /发送|语音与轻聊|继续交流/ })).toBeNull();
    expect(document.querySelector(".cc-page--dialogue textarea")).toBeNull();
    fireEvent.change(screen.getByLabelText("搜索全部对话正文"), { target: { value: "例题" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await screen.findByRole("button", { name: "返回最新对话" });
    fireEvent.click(screen.getByRole("tab", { name: "人格" }));
    fireEvent.click(screen.getByRole("tab", { name: "对话" }));
    expect((screen.getByLabelText("搜索全部对话正文") as HTMLInputElement).value).toBe("例题");
    expect(useRoomStore.getState().companionComposerDraft).toBe("我还想继续问这件事");
    expect(shellMode).toBe("closed");
  });

  it("对话记录读取失败可重试，仍可编辑查询", async () => {
    const api = installApi(); api.companion.history.list.mockRejectedValue(new Error("history unavailable"));
    renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "对话" }));
    expect(await screen.findByText("对话记录当前不可用")).toBeTruthy();
    expect(screen.getByLabelText("搜索全部对话正文")).toBeTruthy();
    api.companion.history.list.mockResolvedValue(ok({ version: 1, items: [historyItem()], nextCursor: null }));
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(await screen.findByText("可以先从这道例题入手。")).toBeTruthy();
  });

  it("末页返回空游标后不再重复请求上一页", async () => {
    const api = installApi();
    api.companion.history.list.mockImplementation(async input => ok({ version: 1, items: [historyItem()], nextCursor: input.query?.before ? null : "older-page" }));
    useRoomStore.setState({ companionCenterTarget: { tab: "dialogue" } }); renderCompanionCenter();
    fireEvent.click(await screen.findByRole("button", { name: "加载更早记录" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "加载更早记录" })).toBeNull());
    expect(api.companion.history.list.mock.calls.at(-1)?.[0].query?.before).toBe("older-page");
  });

  it("搜索通过真实接口读取；正在编辑的查询不会冒充已应用筛选", async () => {
    const api = installApi(); renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "对话" }));
    await screen.findByText("可以先从这道例题入手。");
    fireEvent.change(screen.getByLabelText("搜索全部对话正文"), { target: { value: "例题" } });
    expect(useRoomStore.getState().pageReadableView?.view?.filters).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() => expect(api.companion.history.search).toHaveBeenCalledWith(expect.objectContaining({ query: { q: "例题", limit: 50 } })));
    expect(await screen.findByRole("button", { name: "返回最新对话" })).toBeTruthy();
  });

  it("旧消息定位使用目标读取，并把焦点交给那条消息", async () => {
    const api = installApi();
    useRoomStore.setState({ companionCenterTarget: { tab: "dialogue", focusMessageId: MESSAGE_ID } }); renderCompanionCenter();
    await waitFor(() => expect(api.companion.history.list).toHaveBeenCalledWith(expect.objectContaining({ query: { limit: 50, throughMessageId: MESSAGE_ID } })));
    await waitFor(() => expect(document.activeElement?.id).toBe("companion-message-" + MESSAGE_ID));
  });

  it("关联记忆即使不在最近一批中也按目标读取", async () => {
    const api = installApi();
    useRoomStore.setState({ companionCenterTarget: { tab: "memory", focusMemoryId: MEMORY_ID } }); renderCompanionCenter();
    expect((await screen.findByRole("button", { name: /我更喜欢从例子开始理解概念/ })).getAttribute("aria-pressed")).toBe("true");
    expect(api.companion.memory.list).toHaveBeenCalledWith(expect.objectContaining({ query: { includeCandidates: true, includeArchived: true, focusMemoryId: MEMORY_ID } }));
  });

  it("星图往返保留列表筛选与选中记忆", async () => {
    installApi(); renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "记忆" }));
    await screen.findByRole("button", { name: /我更喜欢从例子开始理解概念/ });
    fireEvent.change(screen.getByLabelText("筛选记忆列表"), { target: { value: "例子" } });
    fireEvent.click(screen.getByRole("button", { name: "关联星图" })); await screen.findByLabelText("星图节点列表");
    fireEvent.click(screen.getByRole("button", { name: "返回记忆列表" }));
    expect((screen.getByLabelText("筛选记忆列表") as HTMLInputElement).value).toBe("例子");
    expect(screen.getByRole("button", { name: /我更喜欢从例子开始理解概念/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("从星图打开较早的记忆会补读目标，等待时不跳回最近一条", async () => {
    const api = installApi();
    let resolveTarget!: (value: GatewayResultV1<{ version: 2; items: CompanionMemoryItemV1[] }>) => void;
    const target = new Promise<GatewayResultV1<{ version: 2; items: CompanionMemoryItemV1[] }>>(resolve => { resolveTarget = resolve; });
    api.companion.memory.list.mockImplementation(async input => input.query?.focusMemoryId === MEMORY_ID ? target : ok({ version: 2, items: [secondMemoryItem()] }));
    useRoomStore.setState({ companionCenterTarget: { tab: "memory" } }); renderCompanionCenter();
    await screen.findByRole("button", { name: /这个月完成力学复习/ });
    fireEvent.click(screen.getByRole("button", { name: "关联星图" }));
    fireEvent.click(await screen.findByRole("button", { name: /记忆\s*我更喜欢从例子开始理解概念/ }));
    fireEvent.click(screen.getByRole("button", { name: "查看这条记忆" }));
    expect(await screen.findByText("正在定位这条记忆…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /这个月完成力学复习/ })).toBeNull();
    resolveTarget(ok({ version: 2, items: [secondMemoryItem(), memoryItem()] }));
    expect((await screen.findByRole("button", { name: /我更喜欢从例子开始理解概念/ })).getAttribute("aria-pressed")).toBe("true");
  });

  it("从回收区恢复较早记忆后按目标补读并选中它", async () => {
    const api = installApi();
    api.companion.memory.list.mockImplementation(async input => ok({ version: 2, items: input.query?.focusMemoryId === MEMORY_ID ? [secondMemoryItem(), memoryItem()] : [secondMemoryItem()] }));
    api.companion.memory.recycleList.mockResolvedValue(ok({ version: 1, items: [{ id: MEMORY_ID, kind: "preference", content: memoryItem().content, deletedAt: "2026-10-01T08:00:00.000Z", purgeAfter: "2026-10-31T08:00:00.000Z", sourceEventId: null }] }));
    useRoomStore.setState({ companionCenterTarget: { tab: "memory" } }); renderCompanionCenter();
    fireEvent.click(await screen.findByRole("button", { name: "整理与回收" }));
    fireEvent.click(await screen.findByRole("button", { name: "恢复这条记忆" }));
    expect((await screen.findByRole("button", { name: /我更喜欢从例子开始理解概念/ })).getAttribute("aria-pressed")).toBe("true");
    expect(api.companion.memory.restoreDeleted).toHaveBeenCalledWith(expect.objectContaining({ memoryId: MEMORY_ID }));
    expect(api.companion.memory.list).toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({ focusMemoryId: MEMORY_ID }) }));
  });

  it("候选确认和删除分别执行，删除需要当前记忆的确认", async () => {
    const api = installApi(); const candidate = { ...memoryItem(), candidate: true, userConfirmed: false, pinned: false, sourceType: "model_inferred" as const };
    api.companion.memory.list.mockResolvedValueOnce(ok({ version: 2, items: [candidate] }));
    renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "记忆" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认写入" }));
    await waitFor(() => expect(api.companion.memory.confirm).toHaveBeenCalledWith(expect.objectContaining({ memoryId: MEMORY_ID })));
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    expect(api.companion.memory.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(api.companion.memory.remove).toHaveBeenCalledWith(expect.objectContaining({ memoryId: MEMORY_ID })));
    expect(await screen.findByRole("button", { name: "撤回删除" })).toBeTruthy();
  });

  it("切到另一条记忆会收起之前的删除确认", async () => {
    const api = installApi(); api.companion.memory.list.mockResolvedValue(ok({ version: 2, items: [memoryItem(), secondMemoryItem()] }));
    renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "记忆" }));
    await screen.findByRole("button", { name: /我更喜欢从例子开始理解概念/ });
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(screen.getByRole("button", { name: "确认删除" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /这个月完成力学复习/ }));
    expect(screen.queryByRole("button", { name: "确认删除" })).toBeNull();
  });

  it("记忆和回收区的彻底清除先聚焦取消，Esc 只收起确认并恢复原操作", async () => {
    const api = installApi();
    api.companion.memory.recycleList.mockResolvedValue(ok({ version: 1, items: [{ id: MEMORY_ID, kind: "preference", content: memoryItem().content, deletedAt: "2026-10-01T08:00:00.000Z", purgeAfter: "2026-10-31T08:00:00.000Z", sourceEventId: null }] }));
    renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "记忆" }));
    fireEvent.click(await screen.findByRole("button", { name: "彻底清除" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消彻底清除" }));
    const confirmation = screen.getByRole("button", { name: "确认彻底清除" });
    confirmation.focus();
    expect(fireEvent.keyDown(confirmation, { key: "Escape" })).toBe(false);
    expect(screen.queryByRole("button", { name: "确认彻底清除" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "彻底清除" }));

    fireEvent.click(screen.getByRole("button", { name: "整理与回收" }));
    fireEvent.click(await screen.findByRole("button", { name: "彻底清除" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
    expect(fireEvent.keyDown(document.activeElement!, { key: "Escape" })).toBe(false);
    expect(screen.queryByRole("button", { name: "确认彻底清除" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "彻底清除" }));
    expect(screen.getByRole("tab", { name: "记忆" }).getAttribute("aria-selected")).toBe("true");
    expect(api.companion.memory.erase).not.toHaveBeenCalled();
    expect(api.companion.memory.remove).not.toHaveBeenCalled();
  });

  it("手动记忆保存失败时保留输入，切页后仍可继续修改", async () => {
    const api = installApi(); api.companion.memory.create.mockRejectedValue(new Error("create failed"));
    renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "记忆" }));
    fireEvent.click(await screen.findByRole("button", { name: "手动添加" }));
    fireEvent.change(screen.getByLabelText("新记忆内容"), { target: { value: "我习惯先看例子" } });
    fireEvent.click(screen.getByRole("button", { name: "保存记忆" }));
    await waitFor(() => expect(api.companion.memory.create).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("tab", { name: "日记" })); fireEvent.click(screen.getByRole("tab", { name: "记忆" }));
    expect((screen.getByLabelText("新记忆内容") as HTMLTextAreaElement).value).toBe("我习惯先看例子");
  });

  it("合作方式只展示偏好，并保留真实范围、来源、条件和确认状态", async () => {
    const api = installApi();
    const rule = { ...memoryItem(), scope: "global" as const, appliesWhen: "讲解新概念时", pinned: false };
    api.companion.memory.list.mockResolvedValue(ok({ version: 2, items: [rule, secondMemoryItem()] }));
    renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "记忆" }));
    fireEvent.click(await screen.findByRole("button", { name: "合作方式" }));
    expect(screen.getByText("我们怎样合作")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /这个月完成力学复习/ })).toBeNull();
    expect(screen.getByText("所有书房")).toBeTruthy();
    expect(screen.getByText("讲解新概念时")).toBeTruthy();
    expect(screen.getByText("用户确认")).toBeTruthy();
    expect(screen.getAllByText("已确认")).toHaveLength(2);
    expect(screen.queryByText("正在使用")).toBeNull();
  });

  it("合作方式保存失败保留范围与例外，重试按原输入提交", async () => {
    const api = installApi(); api.companion.memory.create.mockRejectedValueOnce(new RendererGatewayError({
      code: "memory_global_condition_bound", safeMessageKey: "error.memory_global_condition_bound", retry: "never",
    }));
    renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "记忆" }));
    fireEvent.click(await screen.findByRole("button", { name: "合作方式" }));
    fireEvent.click(screen.getByRole("button", { name: "添加合作方式" }));
    fireEvent.change(screen.getByLabelText("新记忆内容"), { target: { value: "讲解时先举例再解释" } });
    fireEvent.change(screen.getByLabelText("新记忆适用条件"), { target: { value: "正式作答时不要主动提示" } });
    fireEvent.click(screen.getByRole("button", { name: "新记忆适用书房" }));
    fireEvent.click(screen.getByRole("option", { name: "所有书房" }));
    fireEvent.click(screen.getByRole("button", { name: "保存合作方式" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存合作方式" }).hasAttribute("disabled")).toBe(false));
    expect(await screen.findByText(accountPreferenceRejectionMessage("applies_when_workspace_bound"))).toBeTruthy();
    expect((screen.getByLabelText("新记忆内容") as HTMLTextAreaElement).value).toBe("讲解时先举例再解释");
    expect((screen.getByLabelText("新记忆适用条件") as HTMLTextAreaElement).value).toBe("正式作答时不要主动提示");
    expect(screen.getByRole("button", { name: "新记忆适用书房" }).textContent).toBe("所有书房");
    api.companion.memory.create.mockResolvedValue(ok({ ...memoryItem(), scope: "global", appliesWhen: "正式作答时不要主动提示" }));
    fireEvent.click(screen.getByRole("button", { name: "保存合作方式" }));
    await waitFor(() => expect(api.companion.memory.create).toHaveBeenCalledTimes(2));
    expect(api.companion.memory.create).toHaveBeenLastCalledWith(expect.objectContaining({ request: {
      kind: "preference", content: "讲解时先举例再解释", scope: "global", appliesWhen: "正式作答时不要主动提示",
    } }));
    expect(await screen.findByText("已保存，适用于所有书房。")).toBeTruthy();
    expect(screen.queryByLabelText("新记忆内容")).toBeNull();
  });

  it("仅修订适用条件也能保存，并提交编辑开始时的 revision", async () => {
    const api = installApi();
    renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "记忆" }));
    fireEvent.click(await screen.findByRole("button", { name: "合作方式" }));
    fireEvent.click(screen.getByRole("button", { name: "修订" }));
    expect(screen.getByRole("button", { name: "保存修订" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("修订后的适用条件"), { target: { value: "新概念讲解时，做题时先让我试试" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修订" }));
    await waitFor(() => expect(api.companion.memory.correct).toHaveBeenCalledWith(expect.objectContaining({ memoryId: MEMORY_ID,
      request: { content: memoryItem().content, appliesWhen: "新概念讲解时，做题时先让我试试", expectedRevision: 1 } })));
    expect(await screen.findByText(/已修订为第 2 版，适用于这个书房/)).toBeTruthy();
    expect(screen.queryByLabelText("纠正后的记忆内容")).toBeNull();
  });

  it("编辑期间后台刷新不会抬高 expectedRevision；冲突时保留正文与条件", async () => {
    const api = installApi();
    renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "记忆" }));
    fireEvent.click(await screen.findByRole("button", { name: "纠正" }));
    fireEvent.change(screen.getByLabelText("纠正后的记忆内容"), { target: { value: "先让我举例，再补充解释" } });
    fireEvent.change(screen.getByLabelText("修订后的适用条件"), { target: { value: "轻松讨论时" } });
    api.companion.memory.list.mockResolvedValue(ok({ version: 2, items: [{ ...memoryItem(), revision: 2, content: "后台保存的另一条解释习惯" }] }));
    fireEvent(window, new Event("astella:companion-records-changed"));
    await screen.findByRole("button", { name: /后台保存的另一条解释习惯/ });
    api.companion.memory.correct.mockRejectedValue(new Error("revision conflict"));
    fireEvent.click(screen.getByRole("button", { name: "保存修订" }));
    await waitFor(() => expect(api.companion.memory.correct).toHaveBeenCalledWith(expect.objectContaining({ request: {
      content: "先让我举例，再补充解释", appliesWhen: "轻松讨论时", expectedRevision: 1,
    } })));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存修订" }).hasAttribute("disabled")).toBe(false));
    expect((screen.getByLabelText("纠正后的记忆内容") as HTMLTextAreaElement).value).toBe("先让我举例，再补充解释");
    expect((screen.getByLabelText("修订后的适用条件") as HTMLTextAreaElement).value).toBe("轻松讨论时");
    expect(screen.queryByText(/已修订为第/)).toBeNull();
  });

  it("合作方式停用与恢复都等待真实回执，显示保存状态", async () => {
    const api = installApi();
    renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "记忆" }));
    fireEvent.click(await screen.findByRole("button", { name: "合作方式" }));
    api.companion.memory.list.mockResolvedValue(ok({ version: 2, items: [{ ...memoryItem(), archived: true }] }));
    fireEvent.click(screen.getByRole("button", { name: "暂时不用" }));
    expect(await screen.findByRole("button", { name: "恢复这条规则" })).toBeTruthy();
    expect(api.companion.memory.archive).toHaveBeenCalledWith(expect.objectContaining({ memoryId: MEMORY_ID }));
    api.companion.memory.list.mockResolvedValue(ok({ version: 2, items: [memoryItem()] }));
    fireEvent.click(screen.getByRole("button", { name: "恢复这条规则" }));
    await screen.findByRole("button", { name: "暂时不用" });
    expect(api.companion.memory.restore).toHaveBeenCalledWith(expect.objectContaining({ memoryId: MEMORY_ID }));
  });

  it("整理与回收走真实回收接口", async () => {
    const api = installApi(); renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "记忆" }));
    fireEvent.click(await screen.findByRole("button", { name: "整理与回收" }));
    expect(await screen.findByText("回收区是空的")).toBeTruthy();
    expect(api.companion.memory.recycleList).toHaveBeenCalled();
  });

  it("日记按原来的正文、图片、引文顺序阅读", async () => {
    const api = installApi();
    api.companion.daily.get.mockResolvedValue(ok(dailySummary({ blocks: [{ type: "text", text: "第一段正文" }, { type: "image", url: "https://example.test/diary.png", alt: "她画的小图", label: "她画的" }, { type: "quote", text: "他当时说的话", label: "原话" }, { type: "text", text: "最后一段正文" }] })));
    renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "日记" }));
    await screen.findByText("第一段正文");
    const blocks = [...document.querySelectorAll(".cc-diary-prose > *")];
    expect(blocks.map(node => node.tagName)).toEqual(["DIV", "FIGURE", "FIGURE", "DIV"]);
    expect(blocks[0]?.querySelector("p")?.textContent).toBe("第一段正文");
    expect(blocks[3]?.querySelector("p")?.textContent).toBe("最后一段正文");
    expect(document.querySelector(".cc-diary-prose > :nth-child(2)")?.textContent).toContain("她画的");
    expect(document.querySelector(".cc-diary-prose > :nth-child(3)")?.textContent).toContain("他当时说的话");
  });

  it("最新日记的隐藏使用读回的真实日期，并重新读取月历", async () => {
    const api = installApi(); api.companion.daily.get.mockResolvedValue(ok(dailySummary()));
    api.companion.daily.month.mockResolvedValue(ok({ version: 1, month: "2026-09", days: [] }));
    renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "日记" }));
    await screen.findByText("晚上十点他说想慢慢来，我就把复习那件事咽回去了。");
    const before = api.companion.daily.month.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "藏起来" }));
    await waitFor(() => expect(api.companion.daily.hide).toHaveBeenCalledWith(expect.objectContaining({ date: "2026-09-20" })));
    await waitFor(() => expect(api.companion.daily.month.mock.calls.length).toBeGreaterThan(before));
  });

  it("月历失败有明确说明，Escape 只关闭月历", async () => {
    const api = installApi(); api.companion.daily.get.mockResolvedValue(ok(dailySummary()));
    renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "日记" }));
    fireEvent.click(await screen.findByRole("button", { name: /^选择日记日期/ }));
    expect(await screen.findByText("这个月的日记标记暂时读不到。")).toBeTruthy();
    expect(fireEvent.keyDown(document, { key: "Escape" })).toBe(false);
    expect(document.querySelector(".companion-record__calendar")).toBeNull();
  });

  it("日记读取失败时日期导航仍可使用", async () => {
    installApi(); renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "日记" }));
    expect(await screen.findByText("日记当前不可用")).toBeTruthy();
    expect(screen.getByRole("button", { name: "前一天" })).toBeTruthy();
  });

  it("发现簿保存失败保留正在编辑的批注", async () => {
    const api = installApi(); api.companion.memory.discovery.get.mockResolvedValue(ok({ version: 1, entries: [discoveryEntry()], studyVisible: [] }));
    api.companion.memory.discovery.annotate.mockRejectedValue(new Error("annotation failed"));
    renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "发现簿" }));
    fireEvent.click(await screen.findByRole("button", { name: "加批注" }));
    fireEvent.change(screen.getByLabelText("你的批注"), { target: { value: "保留这句话" } });
    fireEvent.click(screen.getByRole("button", { name: "保存批注" }));
    await waitFor(() => expect(api.companion.memory.discovery.annotate).toHaveBeenCalled());
    expect((screen.getByLabelText("你的批注") as HTMLTextAreaElement).value).toBe("保留这句话");
  });

  it("人格改名失败时保留名字草稿，中心不再清空数据", async () => {
    const api = installApi(); api.companion.persona.get.mockResolvedValue(ok({ ...persona(), profile: personaProfile(), profileRevision: 1 }));
    api.companion.persona.patch.mockRejectedValue(new Error("rename failed"));
    renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "人格" }));
    fireEvent.change(await screen.findByLabelText("她叫什么"), { target: { value: "新名字" } }); fireEvent.click(screen.getByRole("button", { name: "改名" }));
    await waitFor(() => expect(api.companion.persona.patch).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ name: "新名字", revision: 1 }) })));
    expect((screen.getByLabelText("她叫什么") as HTMLInputElement).value).toBe("新名字");
    expect(screen.queryByRole("button", { name: "清除" })).toBeNull();
  });

  it("完整版本记录可展开，恢复时携带当前版本号", async () => {
    const api = installApi(); api.companion.persona.get.mockResolvedValue(ok({ ...persona(), profile: personaProfile(21), profileRevision: 21 }));
    api.companion.persona.versions.mockResolvedValue(ok({ version: 1, currentRevision: 21, versions: Array.from({ length: 21 }, (_, index) => ({ id: "00000000-0000-4000-8000-" + String(21 - index).padStart(12, "0"), revision: 21 - index, examplesRevision: 21 - index, author: "user" as const, action: "update" as const, reason: null, moduleScope: ["companion"], profile: null, createdAt: UPDATED_AT })) }));
    renderCompanionCenter(); fireEvent.click(screen.getByRole("tab", { name: "人格" }));
    fireEvent.click(await screen.findByText("人格版本记录 · 21 版"));
    fireEvent.click(screen.getByRole("button", { name: "恢复第 1 版" }));
    await waitFor(() => expect(api.companion.persona.restore).toHaveBeenCalledWith(expect.objectContaining({ revision: 1, currentRevision: 21 })));
  });

  it("动态进入后才呈现投递；忽略产生真实回执", async () => {
    const api = installApi(); api.companion.activity.timeline.mockResolvedValue(ok({ version: 1, items: [delivery(1)], nextCursor: 1, serverTime: UPDATED_AT }));
    renderCompanionCenter(); await screen.findByRole("heading", { name: /接着聊/ });
    expect(api.companion.activity.present).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "动态" }));
    fireEvent.click(await screen.findByRole("button", { name: "忽略" }));
    await waitFor(() => expect(api.companion.activity.ack).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ deliveryId: delivery(1).deliveryId, transition: "dismissed" }) })));
  });

  it("键盘切换立即移动焦点与活动面板，隐藏页不登记可读内容", async () => {
    installApi(); renderCompanionCenter();
    const first = screen.getByRole("tab", { name: "近况" }); fireEvent.keyDown(first, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "人格" }));
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("companion-tab-persona");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(screen.getByRole("tab", { name: "近况" }).getAttribute("aria-selected")).toBe("true");
  });
});
