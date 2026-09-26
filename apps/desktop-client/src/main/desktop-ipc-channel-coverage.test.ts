/**
 * IPC 通道覆盖对账（doc 34 L1）。
 *
 * 为什么需要这一份而不是再多写几个用例：`ailearn.v1.note.doc.syncTitle` 曾经
 * **契约、preload 转发、网关实现三样齐备，唯独主进程没有 `installHandler`**，
 * 于是渲染层那一句 `window.ailearn.note.doc.syncTitle(...)` 直接 reject，
 * 界面上只剩"重命名未确认"那句兜底话。而它当时的"消费者"是一个 `vi.fn()` 替身——
 * 替身不会去找 handler，所以测试是绿的。
 *
 * 这里断言的是**集合相等**，不是"某个函数被调用过"：契约里声明的每一个通道，
 * 要么在主进程被 `ipcMain.handle` 注册，要么出现在下面那份**写明理由的出站/事件通道名单**里。
 * 名单本身也被断言"确实以那种方式绑定了"，所以它不能慢慢腐烂成一条随手加的豁免。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_CONTRACT_VERSION,
  type GatewayResultV1,
  type RequestMetaV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import type { DesktopGateway } from "./desktop-gateway";
import { MemoryNoteDocCacheStore } from "./note-doc-cache-store.ts";

type InvokeHandler = (
  event: { readonly sender: unknown; readonly senderFrame?: { readonly url: string } },
  input: unknown,
) => Promise<GatewayResultV1<unknown>>;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, InvokeHandler>();
  const listeners = new Set<string>();
  return {
    handlers,
    listeners,
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn((channel: string) => {
      listeners.add(channel);
    }),
  };
});

vi.mock("electron", () => ({
  BrowserWindow: class BrowserWindow {
    static getAllWindows(): never[] {
      return [];
    }
  },
  ipcMain: { handle: electronMock.handle, on: electronMock.on },
  session: { defaultSession: { on: vi.fn(() => true) } },
  app: { on: vi.fn(), whenReady: () => Promise.resolve() },
  nativeTheme: { themeSource: "system", on: vi.fn() },
}));

/**
 * 不走 `ipcMain.handle` 的通道，逐条给理由。**这三条之外不该再有第四条**：
 * 新增一条 invoke 通道却忘了注册，就会像 L1 那样静默 reject。
 */
const NON_INVOKE_CHANNELS: Record<string, string> = {
  [DESKTOP_IPC_CHANNELS.contractGetSnapshot]: "同步取快照，走 `ipcMain.on` + sendSync",
  [DESKTOP_IPC_CHANNELS.subscriptionsEvent]: "主进程 → renderer 的出站事件，用 `webContents.send`",
};

const meta: RequestMetaV1 = {
  version: 1,
  contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
  requestId: "request-channel-coverage",
  correlationId: "correlation-channel-coverage",
  clientStartedAt: "2026-09-22T00:00:00.000Z",
  workspaceEpoch: 9,
} as RequestMetaV1;

const NOTE_ID = "33333333-3333-4333-8333-333333333333";

/** 只给到"注册期不会碰网关"的最小替身：这里测的是边界层有没有口，不是网关行为。 */
function stubGateway(overrides: Partial<DesktopGateway> = {}): DesktopGateway {
  return {
    getDeploymentConfig: () => undefined,
    // 带一个已认证的会话快照：`assertEpoch` 认的是主进程当前那一份 epoch，
    // 而它是读会话时才立起来的——没有会话，所有带 epoch 的通道都会回 `stale_workspace`。
    getSession: vi.fn(async () => ({
      version: 1,
      status: "authenticated",
      user: { userId: "11111111-1111-4111-8111-111111111111", email: "me@example.com" },
      workspace: {
        version: 1,
        workspaceId: "22222222-2222-4222-8222-222222222222",
        name: "空间",
        role: "owner",
        workspaceType: "collaborative",
        isPersonal: false,
        workspaceEpoch: 9,
      },
      membership: { role: "owner" },
      capabilities: null,
      workspaceEpoch: 9,
      credentialPersistence: "memory",
    })),
    flushNoteDocPending: vi.fn(async () => undefined),
    dropNoteDocLocalSessions: vi.fn(() => undefined),
    // `null` = 网关此刻没有本机那一份，`persistNoteDocLocal` 据此直接返回。
    // 本机文档与落盘的真实行为在 `desktop-gateway.test.ts` 里对着网关验，
    // 这里只验边界层：通道通不通、schema 挡不挡、参数有没有原样交出去。
    noteDocLocalSnapshot: vi.fn(() => null),
    syncNoteDocTitle: vi.fn(async () => ({
      via: "uploaded" as const,
      revision: 11,
      savedAt: "2026-09-22T00:00:00.000Z",
    })),
    ...overrides,
  } as unknown as DesktopGateway;
}

async function register(gateway: DesktopGateway = stubGateway()) {
  // `registerM1DesktopIpc` 一个模块实例只准注册一次（重复注册抛错是有意的），
  // 所以每个用例换一份干净的模块实例。
  vi.resetModules();
  const { registerM1DesktopIpc } = await import("./desktop-ipc");
  const fakeWindow = {
    isDestroyed: () => false,
    once: () => undefined,
    webContents: { isDestroyed: () => false, once: () => undefined, send: vi.fn() },
  } as never;
  registerM1DesktopIpc({
    gateway,
    noteDocCache: new MemoryNoteDocCacheStore(),
    env: { AILEARN_DOMAIN_SCHEMA_REVISION: "domain-v2-test" },
    resolveWindow: () => fakeWindow,
    getWindowState: () => ({ state: "visible", revision: 1 }),
    setTitlebarTheme: () => true,
  });
  const event = { sender: {}, senderFrame: { url: "ailearn://renderer/" } };
  // 先读一次状态，把主进程的 activeWorkspaceEpoch 立起来（与笔记协同那份集测同一口径）。
  await electronMock.handlers.get(DESKTOP_IPC_CHANNELS.authGetState)!(event, { meta });
  return { event, gateway };
}

function requireData(result: GatewayResultV1<unknown>): Record<string, unknown> {
  if (!result.ok) throw new Error(`IPC 调用失败：${JSON.stringify(result.error)}`);
  return result.data as Record<string, unknown>;
}

describe("IPC 通道覆盖对账", () => {
  beforeEach(() => {
    electronMock.handlers.clear();
    electronMock.listeners.clear();
    electronMock.handle.mockClear();
    electronMock.on.mockClear();
  });

  it("契约里每一条通道都有归属：注册成 handler，或在写明理由的出站名单里", async () => {
    await register();
    const declared = Object.values(DESKTOP_IPC_CHANNELS);
    const registered = electronMock.handlers;

    const unaccounted = declared.filter(
      (channel) => !registered.has(channel) && !(channel in NON_INVOKE_CHANNELS),
    );
    const exemptedButActuallyRegistered = Object.keys(NON_INVOKE_CHANNELS).filter((channel) =>
      registered.has(channel),
    );
    const exemptedNotBoundAnywhere = Object.keys(NON_INVOKE_CHANNELS).filter(
      (channel) => !registered.has(channel) && !electronMock.listeners.has(channel)
        && !channel.endsWith(".event"),
    );

    // 三条断言分别对应三种"名单开始说谎"的方式。
    expect(
      { unaccounted },
      `这些通道在契约里声明了、主进程却没注册 handler（新通道忘了注册就是这个形状）：${unaccounted.join(", ")}`,
    ).toEqual({ unaccounted: [] });
    expect(exemptedButActuallyRegistered).toEqual([]);
    expect(exemptedNotBoundAnywhere).toEqual([]);
  });

  it("声明数与归属数相等：加一条通道却不注册、也不进名单，这里就会红", async () => {
    await register();
    const declaredCount = Object.keys(DESKTOP_IPC_CHANNELS).length;
    expect(electronMock.handlers.size + Object.keys(NON_INVOKE_CHANNELS).length).toBe(declaredCount);
  });

  it("`note.doc.syncTitle` 这条曾经没人注册：现在它真的能打到网关并带回出口", async () => {
    const gateway = stubGateway();
    const { event } = await register(gateway);
    const channel = DESKTOP_IPC_CHANNELS.noteDocSyncTitle;
    const handler = electronMock.handlers.get(channel);
    if (!handler) throw new Error(`channel ${channel} 没有注册处理器（这就是 L1 报的那个洞）`);

    const result = await handler(event, {
      meta,
      commandId: "note-rename-1",
      noteId: NOTE_ID,
      title: "改过的名字",
      titleSource: "manual",
    });

    expect(requireData(result)).toEqual({
      via: "uploaded",
      revision: 11,
      savedAt: "2026-09-22T00:00:00.000Z",
    });
    const syncNoteDocTitle = gateway.syncNoteDocTitle as unknown as ReturnType<typeof vi.fn>;
    expect(syncNoteDocTitle).toHaveBeenCalledWith(NOTE_ID, "改过的名字", "manual", meta.requestId);
  });

  it("改名口在本机就被 schema 挡住：空标题与多带字段都过不去，不去敲网关", async () => {
    const gateway = stubGateway();
    const { event } = await register(gateway);
    const handler = electronMock.handlers.get(DESKTOP_IPC_CHANNELS.noteDocSyncTitle);
    expect(handler).toBeTruthy();
    const syncNoteDocTitle = gateway.syncNoteDocTitle as unknown as ReturnType<typeof vi.fn>;

    const emptyTitle = await handler!(event, {
      meta,
      commandId: "note-rename-2",
      noteId: NOTE_ID,
      title: "",
      titleSource: "manual",
    });
    const extraField = await handler!(event, {
      meta,
      commandId: "note-rename-3",
      noteId: NOTE_ID,
      title: "可以",
      titleSource: "manual",
      body: "不该存在的字段",
    } as never);

    expect(emptyTitle.ok).toBe(false);
    expect(extraField.ok).toBe(false);
    expect(syncNoteDocTitle).not.toHaveBeenCalled();
  });

  /**
   * 轮次那四条通道（39d W4-3 第三刀）。上面那份对账只保证"注册了"，
   * 这里要的是它在边界层真的做该做的事：
   *  - `create` 把三格与 requestId 原样交给网关（不多不少）；
   *  - 渲染层想塞 `noteVersionId` 或交一句空话 ⇒ **本机**就挡下，网关一次都没被打
   *    （那句"实际用哪一版正文由服务端读"要有人守，注释不算守）；
   *  - `open` 在"这一篇没有未完成轮次"时回 `data: null`，不是 `ok:false`——
   *    每篇新笔记一进页面就吃一条红色提示，是这一族最常见的错法。
   */
  it("轮次那五条：该转发的转发，该在本机挡下的不打网关", async () => {
    const round = {
      version: 1,
      roundId: "77777777-7777-4777-8777-777777777777",
      noteId: NOTE_ID,
      phase: "active",
      outcome: null,
      drivingQuestion: "判断为什么有索引，查询仍然可能慢",
      drivingQuestionSource: "suggested",
      drivingQuestionRevision: 1,
      noteVersionId: "88888888-8888-4888-8888-888888888888",
      sourceContentHash: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      evidenceSnapshotIds: [],
      budgets: { maxModelCalls: 8, maxWallClockSeconds: 900, maxTasks: 6 },
      revision: 1,
      pausedAt: null,
      resumedAt: null,
      closedAt: null,
      createdAt: "2026-09-26T04:00:00.000Z",
      updatedAt: "2026-09-26T04:00:00.000Z",
    };
    const history = {
      version: 1,
      noteId: NOTE_ID,
      items: [{
        roundId: "99999999-9999-4999-8999-999999999999",
        phase: "closed",
        outcome: "partial",
        drivingQuestion: "上一轮的那句问题",
        drivingQuestionSource: "user_authored",
        drivingQuestionRevision: 2,
        // §10.3 那两格给**非默认值**：这条通道对账要证的正是"服务端算出来的事实
        // 穿得过 IPC 的 strictObject、不会被哪一层悄悄丢掉"（`totalCount` 那一课的形状）。
        actualModes: ["explained", "practiced"],
        systemUncertain: true,
        startedAt: "2026-09-25T04:00:00.000Z",
        closedAt: "2026-09-25T05:00:00.000Z",
      }],
      hasMore: true,
      // 照服务端真实回信的形状：`hasMore` 为真时 `nextCursor` 必须是本页最后一条的 id，
      // 而"这一屏列了几轮"由服务端报（`shownCount`），不让界面拿数组长度冒充总数。
      shownCount: 1,
      // 总数那一格是 `9d012b82` 起合同里的**必填**（`totalCount >= shownCount`），
      // 这份替身当时漏了它 → 回执在本机就被 `strictObject` 判成 `unsupported_contract`。
      // 值照真实服务端：`hasMore` 为真时总数一定大于本页条数，写 1 会把"还有更早的"说成没有。
      totalCount: 3,
      nextCursor: "99999999-9999-4999-8999-999999999999",
    };
    const gateway = stubGateway({
      createNoteLearningRound: vi.fn(async () => round),
      getOpenNoteLearningRound: vi.fn(async () => null),
      getNoteLearningRoundHistory: vi.fn(async () => history),
    } as never) as unknown as Record<string, ReturnType<typeof vi.fn>>;
    const { event } = await register(gateway as never);

    const created = await (electronMock.handlers.get(DESKTOP_IPC_CHANNELS.noteLearningRoundCreate))!(event, {
      meta,
      noteId: NOTE_ID,
      drivingQuestion: "判断为什么有索引，查询仍然可能慢",
      drivingQuestionSource: "suggested",
    });
    expect(requireData(created)).toMatchObject({ roundId: round.roundId });
    expect(gateway.createNoteLearningRound).toHaveBeenCalledWith(
      { noteId: NOTE_ID, drivingQuestion: "判断为什么有索引，查询仍然可能慢", drivingQuestionSource: "suggested" },
      meta.requestId,
    );

    const withVersion = await (electronMock.handlers.get(DESKTOP_IPC_CHANNELS.noteLearningRoundCreate))!(event, {
      meta,
      noteId: NOTE_ID,
      drivingQuestion: "想自己指定版本",
      drivingQuestionSource: "user_authored",
      noteVersionId: round.noteVersionId,
    } as never);
    const blank = await (electronMock.handlers.get(DESKTOP_IPC_CHANNELS.noteLearningRoundCreate))!(event, {
      meta,
      noteId: NOTE_ID,
      drivingQuestion: "   ",
      drivingQuestionSource: "user_authored",
    });
    expect(withVersion.ok).toBe(false);
    expect(blank.ok).toBe(false);
    expect(gateway.createNoteLearningRound).toHaveBeenCalledTimes(1);

    const opened = await (electronMock.handlers.get(DESKTOP_IPC_CHANNELS.noteLearningRoundOpen))!(event, { meta, noteId: NOTE_ID });
    expect(opened.ok).toBe(true);
    expect(requireData(opened)).toBeNull();

    // 记录那一条：`limit` 不给就按服务端的默认档转发（本机不自己填一个数，
    // 那会变成"客户端决定了屏幕上看几轮"），而坏值在本机就挡掉。
    const historyHandler = (electronMock.handlers.get(DESKTOP_IPC_CHANNELS.noteLearningRoundHistory))!;
    const gotHistory = await historyHandler(event, { meta, noteId: NOTE_ID });
    expect(requireData(gotHistory)).toMatchObject({
      hasMore: true,
      nextCursor: "99999999-9999-4999-8999-999999999999",
      items: [{ drivingQuestion: "上一轮的那句问题" }],
    });
    expect(gateway.getNoteLearningRoundHistory).toHaveBeenCalledWith({ noteId: NOTE_ID, limit: undefined, before: undefined }, meta.requestId);
    const badLimit = await historyHandler(event, { meta, noteId: NOTE_ID, limit: 0 } as never);
    const badCursor = await historyHandler(event, { meta, noteId: NOTE_ID, before: "不是个 uuid" } as never);
    expect(badLimit.ok).toBe(false);
    expect(badCursor.ok).toBe(false);
    expect(gateway.getNoteLearningRoundHistory).toHaveBeenCalledTimes(1);
  });

  /**
   * 记录的第二级（本人、跨笔记，39d W4-8 刀二）过主进程这一发。
   * 上一批我自己欠下的账：那时只有"声明数＝注册数"自动配平，没有一条正向读它。
   * 替身照**真实服务端**回信给（每行带是哪一篇、两格事实是非默认值），
   * 这样"哪一层悄悄丢掉一格"会在本机就红，而不是变成界面上一个 undefined。
   */
  it("我的记录那一条：不带 noteId 地转发，坏值在本机挡下", async () => {
    const personalPage = {
      version: 1,
      items: [{
        roundId: "99999999-9999-4999-8999-999999999999",
        phase: "closed",
        outcome: "completed",
        drivingQuestion: "上一轮的那句问题",
        drivingQuestionSource: "user_authored",
        drivingQuestionRevision: 2,
        actualModes: ["explained", "practiced"],
        systemUncertain: true,
        startedAt: "2026-09-25T04:00:00.000Z",
        closedAt: "2026-09-25T05:00:00.000Z",
        noteId: NOTE_ID,
        noteTitle: "学习科学术语定义集",
      }],
      hasMore: true,
      shownCount: 1,
      totalCount: 4,
      nextCursor: "99999999-9999-4999-8999-999999999999",
    };
    const gateway = stubGateway({
      getMyLearningRoundHistory: vi.fn(async () => personalPage),
    } as never) as unknown as Record<string, ReturnType<typeof vi.fn>>;
    const { event } = await register(gateway as never);
    const handler = (electronMock.handlers.get(DESKTOP_IPC_CHANNELS.noteLearningRoundPersonalHistory))!;

    const got = await handler(event, { meta });
    expect(requireData(got)).toMatchObject({
      totalCount: 4,
      items: [{ noteTitle: "学习科学术语定义集", actualModes: ["explained", "practiced"], systemUncertain: true }],
    });
    expect(gateway.getMyLearningRoundHistory).toHaveBeenCalledWith({ limit: undefined, before: undefined }, meta.requestId);

    const badLimit = await handler(event, { meta, limit: 0 } as never);
    const badCursor = await handler(event, { meta, before: "不是个 uuid" } as never);
    // 这一级的语义就是"不属于某一篇"：带上 noteId 要在本机就被 strictObject 挡下，
    // 不能让它悄悄变成一个按笔记筛的读法（那会有第二个出处）。
    const withNoteId = await handler(event, { meta, noteId: NOTE_ID } as never);
    expect(badLimit.ok).toBe(false);
    expect(badCursor.ok).toBe(false);
    expect(withNoteId.ok).toBe(false);
    expect(gateway.getMyLearningRoundHistory).toHaveBeenCalledTimes(1);
  });

  /**
   * 「保存到卡组」与「保存并开启复习」共用同一条激活通道，差别只有那一档（39d W7-2 两颗按钮）。
   * 边界层要做的两件事：
   *  - 那一档**原样**交出去——主进程不替用户决定要不要开始安排复习（缺省尤其不许补成 `false`
   *    再往下传：那会把"这一发没说要"写成"这一发说了不要"）；
   *  - 回执里"排到了哪天、是不是沿用"原样交回来。那一格要是被出口 schema 悄悄丢掉，
   *    界面上那句「第一次复习排在 X」就永远不出现，而通道对账那两条仍然全绿。
   * 顺带钉住"多带字段挡在本机"：否则"接受这一格"其实是"什么都接受"。
   */
  it("激活那一条：那一档原样交出去，回执的排期原样交回来，缺省与坏值都不往下传", async () => {
    const runId = "44444444-4444-4444-8444-444444444444";
    const objectiveId = "55555555-5555-5555-8555-555555555555";
    const receipt = {
      version: 1,
      receiptId: "66666666-6666-6666-8666-666666666666",
      runId,
      mappings: [{
        candidateRevisionId: "77777777-7777-7777-8777-777777777777",
        cardId: "88888888-8888-8888-8888-888888888888",
        objectiveId,
        objectiveRevisionId: "99999999-9999-9999-8999-999999999999",
        publicationRevision: 1,
        resultingEvidenceBindingSetHash: "b".repeat(64),
      }],
      lifecycleResults: [],
      scheduling: [{ objectiveId, nextReviewAt: "2026-09-27T04:00:00.000Z", created: true }],
      committedAt: "2026-09-26T04:00:00.000Z",
    };
    const gateway = stubGateway({
      getCapabilities: vi.fn(async () => ({ actionCapabilities: { "card_generation.activate": "allowed" } })),
      watchCardGenerationEvents: vi.fn(async () => () => undefined),
      activateCardGeneration: vi.fn(async () => receipt),
    } as never) as unknown as Record<string, ReturnType<typeof vi.fn>>;
    const { event } = await register(gateway as never);
    const handler = electronMock.handlers.get(DESKTOP_IPC_CHANNELS.noteCardGenerationActivate);
    expect(handler).toBeTruthy();
    const called = () => gateway.activateCardGeneration.mock.calls.map(
      (call) => (call[1] as { request?: unknown } & Record<string, unknown>).request ?? call[1],
    );
    const selection = (extra: Record<string, unknown> = {}) => ({
      meta,
      commandId: "activate-cmd-1",
      runId,
      request: {
        version: 1,
        runId,
        selectedCandidates: [{
          candidateRevisionId: "77777777-7777-7777-8777-777777777777",
          candidateId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          revision: 1,
          revisionHash: "a".repeat(64),
          candidateEvidenceBindingPlanHash: "c".repeat(64),
          intent: { kind: "create_new" },
        }],
        existingLifecycleActions: [],
        expectedReviewDraftRevision: 1,
        ...extra,
      },
    });

    const scheduled = await handler!(event, selection({ startReviewScheduling: true }) as never);
    expect(called()[0]).toMatchObject({ startReviewScheduling: true });
    expect(requireData(scheduled).scheduling).toEqual([
      { objectiveId, nextReviewAt: "2026-09-27T04:00:00.000Z", created: true },
    ]);

    await handler!(event, selection({ startReviewScheduling: false }) as never);
    expect(called()[1]).toMatchObject({ startReviewScheduling: false });

    await handler!(event, selection());
    // 缺省那一发交回去的请求里**没有这一格**：主进程不补默认值。
    expect(Object.keys(called()[2] as Record<string, unknown>)).not.toContain("startReviewScheduling");

    const wrongType = await handler!(event, selection({ startReviewScheduling: "yes" }) as never);
    const extraField = await handler!(event, selection({ subscribeReview: true }) as never);
    expect(wrongType.ok).toBe(false);
    expect(extraField.ok).toBe(false);
    expect(gateway.activateCardGeneration).toHaveBeenCalledTimes(3);
  });
});
