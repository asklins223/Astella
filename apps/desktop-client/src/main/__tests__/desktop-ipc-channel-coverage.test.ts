/**
 * IPC 通道覆盖对账（doc 34 L1）。
 *
 * 为什么需要这一份而不是再多写几个用例：`astella.v1.note.doc.syncTitle` 曾经
 * **契约、preload 转发、网关实现三样齐备，唯独主进程没有 `installHandler`**，
 * 于是渲染层那一句 `window.astella.note.doc.syncTitle(...)` 直接 reject，
 * 界面上只剩"重命名未确认"那句兜底话。而它当时的"消费者"是一个 `vi.fn()` 替身——
 * 替身不会去找 handler，所以测试是绿的。
 *
 * 这里断言的是**集合相等**，不是"某个函数被调用过"：契约里声明的每一个通道，
 * 要么在主进程被 `ipcMain.handle` 注册，要么出现在下面那份**写明理由的出站/事件通道名单**里。
 * 名单本身也被断言"确实以那种方式绑定了"，所以它不能慢慢腐烂成一条随手加的豁免。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { noteModuleMock, noteStub, noteStubOf } from "./ns-note-stubs";

// 2026-09-30：笔记这一族已变成**自由函数**（`desktop-gateway-ns-note.ts`），
// `desktop-ipc.ts` 静态引用那个模块——**实例上挂的桩不再被调用**，桩要挂模块。
//
// **用 `importOriginal()` 部分 mock**而不是写死转发清单：desktop-ipc 里有 60+ 个
// `ns_note.*` 调用点，清单漏一个，vitest 就在运行时抛「没有这个导出」，
// 而它被 `safe_internal_error` 吞掉——症状离真因隔了三层。**部分 mock 不会过时。**
vi.mock("../gateway/desktop-gateway-ns-note", async (importOriginal) => {
  // **部分 mock**：只覆盖用 noteStub() 登记过的方法，其余走真实现。
  // 写死转发清单一定会过时——实测 desktop-ipc 里有 60+ 个 ns_note 调用点，漏一个
  // vitest 就在运行时抛「没有这个导出」，而它被 safe_internal_error 吞掉。
  //
  // ⚠️ 两处顺序不能改：
  // ① 工厂里**不能引用顶层 import**（vi.mock 被提升，顶层变量那时还没初始化）
  //    ——所以 noteModuleMock 也在工厂内部 import；
  // ② `importOriginal()` **不能与别的 import 并发**（实测 `Promise.all` 会让
  //    mock 提前返回半成品，症状是「桩登记了但一次都没被调用」）。
  const real = await importOriginal<typeof import("../gateway/desktop-gateway-ns-note")>();
  const { noteModuleMock } = await import("./ns-note-stubs");
  return noteModuleMock(real);
});

// 2026-09-30：笔记这一族已变成**自由函数**（`desktop-gateway-ns-note.ts`），
// `desktop-ipc.ts` 静态引用那个模块——**实例上的桩不再被调用**，桩要挂模块。
// 桩既可以是 `vi.fn()`（用例要断言 `.mock`），也可以是裸箭头（用例不碰它）——
// **统一放宽**成「函数」，否则给裸箭头赋值会 typecheck 报错。


/**
 * 2026-09-30：`getCapabilities` 已从 `DesktopGateway` 的方法变成**自由函数**
 * （`desktop-gateway-ns-source.ts`），而 `desktop-ipc.ts` 现在静态引用那个模块——
 * **在实例上挂的桩不再被调用**。正解是 `vi.mock` 那个模块：
 * **桩要挂在调用真正经过的地方**。
 */
const nsSourceStubs: Record<string, ReturnType<typeof vi.fn<(...args: never[]) => unknown>>> = {};
vi.mock("../gateway/desktop-gateway-ns-source", () => ({
  getCapabilities: (...args: never[]) => nsSourceStubs.getCapabilities?.(...args),
}));
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_CONTRACT_VERSION,
  type GatewayResultV1,
  type RequestMetaV1,
} from "@astella/shared/desktop-ipc-contracts";
import type { DesktopGateway } from "../gateway/desktop-gateway";
import { MemoryNoteDocCacheStore } from "../note-doc/note-doc-cache-store.ts";
import { registerAuthStub } from "./ns-auth-stubs";
import * as ns_auth from "../gateway/desktop-gateway-ns-auth";

vi.mock("../gateway/desktop-gateway-ns-auth", async () => {
  const { authModuleMock } = await import("./ns-auth-stubs");
  return authModuleMock();
});

type InvokeHandler = (
  event: { readonly sender: unknown; readonly senderFrame?: { readonly url: string } },
  input: unknown,
) => Promise<GatewayResultV1<unknown>>;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, InvokeHandler>();
  // `ipcMain.on` 那一份也要**存下处理函数**，不能只记频道名：豁免名单里
  // `contractGetSnapshot` 的理由是"它走 on + sendSync"，只记名字等于没验——
  // 注册错地方（比如哪天把它挪进 `handle`）这里照样是绿的。
  const listeners = new Map<string, (event: { returnValue?: unknown }) => void>();
  return {
    handlers,
    listeners,
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, listener: (event: { returnValue?: unknown }) => void) => {
      listeners.set(channel, listener);
    }),
  };
});

/** 主进程往 renderer 推的字节块（`webContents.send`）在这里换成交接器，用例自己接管。 */
const outboundStubs = vi.hoisted(() => ({
  streamVoiceSegment: null as null | ((
    transport: unknown,
    request: unknown,
    requestId: string,
    onChunk: (chunk: Uint8Array) => void,
  ) => Promise<{ byteLength: number }>),
}));

vi.mock("../gateway/desktop-gateway-ns-companion", async (importOriginal) => {
  // 又是**部分 mock**（理由见 `ns-note-stubs.ts` 头）：只有流式朗读那一条换成可驱动
  // 的假实现，其余 55 条伴星通道走真模块——写死清单会过时，而这里要验的恰恰是
  // "清单之外的也没被漏掉"。
  const real = await importOriginal<typeof import("../gateway/desktop-gateway-ns-companion")>();
  return new Proxy(real, {
    get(target, prop: string) {
      if (prop === "streamCompanionVoiceSegment") {
        // 两边都按"原样转发"处理：`target[prop]` 的类型是整个模块导出的联合，而桩的
        // 签名是固定四参，展开一个数组元组过不去——运行时这一层就是转发。
        type Forward = (...a: never[]) => unknown;
        return (...args: never[]) => {
          const stub = outboundStubs.streamVoiceSegment as Forward | null;
          return (stub ?? (target[prop as keyof typeof target] as Forward))(...args);
        };
      }
      return target[prop as keyof typeof target];
    },
  }) as typeof real;
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
  powerMonitor: { on: vi.fn() },
}));

/**
 * 不走 `ipcMain.handle` 的通道，逐条给理由。**这三条之外不该再有第四条**：
 * 新增一条 invoke 通道却忘了注册，就会像 L1 那样静默 reject。
 */
const NON_INVOKE_CHANNELS: Record<string, string> = {
  [DESKTOP_IPC_CHANNELS.contractGetSnapshot]: "同步取快照，走 `ipcMain.on` + sendSync",
  [DESKTOP_IPC_CHANNELS.subscriptionsEvent]: "主进程 → renderer 的出站事件，用 `webContents.send`",
  [DESKTOP_IPC_CHANNELS.companionVoiceSpeakSegmentChunk]:
    "主进程 → renderer 的逐块音频事件（2026-10-17），用 `webContents.send`；配对入口是 `companionVoiceSpeakSegmentStream`",
  [DESKTOP_IPC_CHANNELS.openedFileIncoming]:
    "系统文件关联的主进程 → renderer 推送（2026-11），用 `webContents.send`；配对入口是 `openedFileTake` 的首帧补读",
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
    // 2026-09-30 补上：默认这份 stub 是「注册期不碰网关」的最小替身，**可它也少了
    // `getOpenNoteLearningRound`**。于是「轮次那五条」那条用例驱动 `noteLearningRoundOpen`
    // 时调的是一个 `undefined` → `unsupported_contract`，而那条断言期望的是「没有进行中的
    // 轮次，回 null」。缺一条 stub 与「通道没注册」在报错上长得一模一样。
    //
    // 「注册期不碰网关」约束的是**注册那一刻**，不是运行期——运行期 handler 照样会调它。
    // 带一个已认证的会话快照：`assertEpoch` 认的是主进程当前那一份 epoch，
    // 而它是读会话时才立起来的——没有会话，所有带 epoch 的通道都会回 `stale_workspace`。
    getSession: registerAuthStub("getSession", vi.fn(async () => ({
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
    }))),
    // 2026-09-30：`readTodayBatch` 是这一轮补上的网关方法。stub 是一份「网关有哪些方法」
    // 的清单，**少写一条就等于说网关没有它**——而主进程那条 handler 会真的去调它。
    readTodayBatch: vi.fn(async () => ({
      // ⚠️ **不要多给 `version`**——`todayBatchWireV2Schema` 是 `strictObject`，
      // 多一格就判成 `unsupported_contract`（这个坑本文件上面已经踩过一次，
      // 那次是 history 回执漏了 `totalCount`）。
      items: [],
      lockedLength: 0,
      deferredCount: 0,
      paused: false,
    })),
    flushNoteDocPending: noteStub("flushNoteDocPending", vi.fn(async () => undefined)),
    dropNoteDocLocalSessions: vi.fn(() => undefined),
    // `null` = 网关此刻没有本机那一份，`persistNoteDocLocal` 据此直接返回。
    // 本机文档与落盘的真实行为在 `desktop-gateway.test.ts` 里对着网关验，
    // 这里只验边界层：通道通不通、schema 挡不挡、参数有没有原样交出去。
    // 2026-09-30：轮次「打开当前那一条」这条通道会调它。没桩到模块就走了真实现，
    // 而测试的网关对象上没有 `gatewayTransport`——`ensureConnected` 直接炸，
    // 再被 `safe_internal_error` 吞掉，症状是 `opened.ok === false`。
    getOpenNoteLearningRound: noteStub("getOpenNoteLearningRound", vi.fn(async () => null)),
    noteDocLocalSnapshot: noteStub("noteDocLocalSnapshot", vi.fn(() => null)),
    syncNoteDocTitle: noteStub("syncNoteDocTitle", vi.fn(async () => ({
      via: "uploaded" as const,
      revision: 11,
      savedAt: "2026-09-22T00:00:00.000Z",
    }))),
    ...overrides,
  } as unknown as DesktopGateway;
}

async function register(gateway: DesktopGateway = stubGateway()) {
  // `registerM1DesktopIpc` 一个模块实例只准注册一次（重复注册抛错是有意的），
  // 所以每个用例换一份干净的模块实例。
  vi.resetModules();
  const { registerM1DesktopIpc } = await import("../ipc/desktop-ipc");
  const send = vi.fn();
  const fakeWindow = {
    isDestroyed: () => false,
    once: () => undefined,
    on: () => undefined,
    focus: () => undefined,
    isVisible: () => true,
    isMinimized: () => false,
    webContents: { isDestroyed: () => false, once: () => undefined, on: () => undefined, send, getURL: () => "astella://renderer/" },
  } as never;
  registerM1DesktopIpc({
    gateway,
    // 文件关联只在这条通道族里用到 broker；覆盖对账只需要它存在，不驱动推送。
    openedFileBroker: { take: () => null } as never,
    noteDocCache: new MemoryNoteDocCacheStore(),
    env: { ASTELLA_DOMAIN_SCHEMA_REVISION: "domain-v2-test" },
    resolveWindow: () => fakeWindow,
    getWindowState: () => ({ state: "visible", revision: 1 }),
    setTitlebarTheme: () => true,
  });
  const event = { sender: {}, senderFrame: { url: "astella://renderer/" } };
  // 先读一次状态，把主进程的 activeWorkspaceEpoch 立起来（与笔记协同那份集测同一口径）。
  await electronMock.handlers.get(DESKTOP_IPC_CHANNELS.authGetState)!(event, { meta });
  return { event, gateway, send };
}

function requireData(result: GatewayResultV1<unknown>): Record<string, unknown> {
  if (!result.ok) { throw new Error(`IPC 调用失败：${JSON.stringify(result.error)}`); }
  return result.data as Record<string, unknown>;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** 契约里声明的全部通道字符串（写成 `string[]`：下面要拿它跟任意注册上来的通道名比）。 */
const declaredChannels: string[] = Object.values(DESKTOP_IPC_CHANNELS);

describe("IPC 通道覆盖对账", () => {
  beforeEach(() => {
    electronMock.handlers.clear();
    electronMock.listeners.clear();
    outboundStubs.streamVoiceSegment = null;
  });

  it("每一条声明过的通道都有归宿：注册成 handler，或在写明理由的那份名单里", async () => {
    await register();
    const registered = new Set(electronMock.handlers.keys());
    const exempt = new Set(Object.keys(NON_INVOKE_CHANNELS));

    // 两条通道撞成同一个字符串时，"少注册一条"会被另一条掩盖掉。
    expect(declaredChannels.length).toBe(new Set(declaredChannels).size);

    const unhandled = declaredChannels.filter((channel) => !registered.has(channel) && !exempt.has(channel));
    expect(unhandled, `这些通道契约里有、主进程却没注册，渲染层调用只会静默 reject`).toEqual([]);

    const undeclared = [...registered].filter((channel) => !declaredChannels.includes(channel));
    expect(undeclared, `这些 handler 注册的通道不在契约里：preload 永远不会调到它们`).toEqual([]);

    // 豁免名单不许慢慢变成垃圾桶：名单里的既不能其实有 handler，也不能指向已删掉的通道。
    for (const channel of exempt) expect(registered.has(channel), `${channel} 既在名单里又注册了`).toBe(false);
    expect(declaredChannels.filter((channel) => exempt.has(channel))).toHaveLength(exempt.size);
  });

  it("contractGetSnapshot 那条同步通道确实绑在 ipcMain.on 上，且答得出一份快照", async () => {
    await register();
    const listener = electronMock.listeners.get(DESKTOP_IPC_CHANNELS.contractGetSnapshot);
    expect(listener, "豁免名单说它走 ipcMain.on，这里要看到那个监听器").toBeTypeOf("function");
    const event: { sender: unknown; senderFrame: { url: string }; returnValue?: unknown } = {
      sender: {}, senderFrame: { url: "astella://renderer/" },
    };
    listener!(event);
    expect(event.returnValue).toMatchObject({ contractVersion: DESKTOP_IPC_CONTRACT_VERSION });
  });

  it("subscriptionsEvent 那条出站通道，事件真的落到 renderer 的 send 上", async () => {
    noteStub("watchNoteDocument", vi.fn(async () => ({ stop: () => undefined })));
    const { event, send } = await register();
    const subscribed = await electronMock.handlers.get(DESKTOP_IPC_CHANNELS.subscriptionsSubscribe)!(event, {
      meta, topic: { kind: "noteDoc", noteId: NOTE_ID },
    });
    const subscriptionId = requireData(subscribed).subscriptionId as string;
    expect(subscriptionId).toBeTruthy();
    await settle();
    send.mockClear();

    // 首参是传输层，`onEvent` 在索引 3（与 `desktop-ipc-note-doc.test.ts` 同一口径）。
    const onEvent = noteStubOf("watchNoteDocument").mock.calls[0][3] as (payload: unknown) => void;
    // 状态帧（不是增量）：增量那条分支还要本机文档树，这里要验的只是出站通道有没有口。
    onEvent({ noteId: NOTE_ID, type: "status", status: "authenticated", authorizedScope: "read-write" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe(DESKTOP_IPC_CHANNELS.subscriptionsEvent);
    expect(send.mock.calls[0][1]).toMatchObject({ subscriptionId, kind: "note_doc_event", workspaceEpoch: 9 });
  });

  it("companionVoiceSpeakSegmentChunk 那条出站通道，音频块真的落到 renderer 的 send 上", async () => {
    outboundStubs.streamVoiceSegment = async (_transport, _request, _requestId, onChunk) => {
      onChunk(new Uint8Array([1, 2, 3]));
      return { byteLength: 3 };
    };
    const { event, send } = await register();
    const accepted = await electronMock.handlers.get(DESKTOP_IPC_CHANNELS.companionVoiceSpeakSegmentStream)!(event, {
      meta,
      request: {
        version: 2,
        conversationId: "44444444-4444-4444-8444-444444444444",
        runId: "55555555-5555-5555-8555-555555555555",
        generation: 1,
        ordinal: 1,
        segmentId: "a".repeat(64),
      },
    });
    expect(requireData(accepted)).toMatchObject({ accepted: true, requestId: meta.requestId });
    await settle();
    const frames = send.mock.calls.filter((call) => call[0] === DESKTOP_IPC_CHANNELS.companionVoiceSpeakSegmentChunk);
    expect(frames.map((call) => (call[1] as { kind: string }).kind)).toEqual(["chunk", "end"]);
  });
});



