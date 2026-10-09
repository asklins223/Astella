// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "../notebook/notebook-surface.tsx";
import { useNotebookFullscreenState } from "../notebook/notebook-fullscreen-state.ts";
import { useRoomStore } from "../../../app/room-store.ts";

/**
 * 在场那一排要真的长在笔记页上（共享空间的在场）。
 *
 * 组件测试只证明「给它名单它会画印章」，钩子测试只证明「帧来了它会变成名单」——
 * 中间那一环（笔记页把 `presencePeers` 与本机档位交给组件、并在三处摆出来）两边都管不到。
 * 这一条钉的是它：谁把接线改了，这里立刻红。
 *
 * 全屏那一档单独钉：册页页眉那条 meta 在全屏下是被 CSS 收起来的
 * （`notebook-fullscreen.css` 里 `.notebook-volume__meta { display: none }`），
 * jsdom 不跑样式，所以这里问的是**那一排挂在了常驻纸签上**，而不是它可见不可见。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";

type Listener = (event: { data: unknown }) => void;
let listeners: Listener[] = [];
let subscribe: ReturnType<typeof vi.fn>;
let presence: ReturnType<typeof vi.fn>;

function stub(options: { shareScope?: "private" | "shared" } = {}) {
  const shareScope = options.shareScope ?? "shared";
  listeners = [];
  subscribe = vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { subscriptionId: "sub-1" } }));
  presence = vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { shared: true } }));
  window.astella = {
    contract: { enabledRoutes: ["note.detail"] },
    auth: { getState: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { status: "authenticated", workspace: { workspaceId: "w-1" } } })) },
    room: {
      getProjection: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          primaryFocus: {
            state: "data",
            data: { objective: { content: { conceptLabel: "测试目标", publicSummary: "", sourceLabel: null }, personal: { lastCanonicalAt: null }, sources: { primaryNote: { noteId: NOTE_ID, noteVersionId: VERSION_ID } } } },
          },
        },
      })),
    },
    note: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          noteId: NOTE_ID,
          title: "这一篇已经共享给空间",
          sourceId: null,
          currentVersionId: VERSION_ID,
          shareScope,
          permissions: { canEdit: true, canSave: true, canShare: true },
          currentVersion: { versionNo: 1, updatedAt: new Date().toISOString(), contentHash: "hash-0", blocks: [{ ordinal: 1, type: "paragraph", content: "hello" }] },
        },
      })),
      doc: {
        state: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { blocks: [], title: "", titleSource: "auto", revision: 0, backfilled: false, shareScope } })),
        syncBlocks: vi.fn(async () => { throw new Error("gateway unavailable"); }),
        presence,
      },
    },
    capabilities: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          actionCapabilities: { "note.save": "allowed", "note.create": "allowed" },
          featureAvailability: { card_generation_v2: { state: "disabled" }, companion_dialogue_v1: { state: "disabled" } },
        },
      })),
    },
    source: { get: vi.fn(async () => ({ ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } })) },
    subscriptions: {
      subscribe,
      unsubscribe: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { closed: true } })),
      onEvent: (_id: string, listener: Listener) => {
        listeners.push(listener);
        return () => { listeners = listeners.filter((entry) => entry !== listener); };
      },
    },
  } as unknown as typeof window.astella;
}

async function open(mode: "preview" | "live-preview", fullscreen = false) {
  useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode } });
  useNotebookFullscreenState.setState({ active: fullscreen });
  vi.useFakeTimers();
  render(<NotebookSurface />);
  for (let i = 0; i < 12; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  }
}

/** 一帧"还有别人开着这一篇"——从主进程那条订阅通道进来，和真实路径同一个形状。 */
const deliverPresence = (states: unknown[]) => act(() => {
  for (const listener of listeners) {
    listener({ data: { kind: "note_doc_event", noteId: NOTE_ID, event: { type: "presence", states } } });
  }
});

/** 一帧状态帧：`failed` 是那条实时通道坏了。 */
const deliverStatus = (event: Record<string, unknown>) => act(() => {
  for (const listener of listeners) {
    listener({ data: { kind: "note_doc_event", noteId: NOTE_ID, event: { type: "status", ...event } } });
  }
});

const text = () => document.body.textContent ?? "";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useNotebookFullscreenState.setState({ active: false });
  useRoomStore.setState({ activeNoteRef: null, spaceIdentity: null, accountIdentity: null });
});

const inCollabSpace = () => useRoomStore.setState({
  surface: "notebook",
  spaceIdentity: { name: "验收空间", role: "owner", isPersonal: false, userId: "u-owner" },
  accountIdentity: { email: "owner@astella.local", displayName: "Asklins" },
});

describe("笔记页上的在场名单", () => {
  it("阅读态：一个人时也报到自己，别人一报状态就长出第二枚印章", async () => {
    stub();
    inCollabSpace();
    await open("preview");
    expect(document.querySelectorAll(".notebook-presence__peer")).toHaveLength(1);
    expect(text()).toContain("只有你在看");
    await deliverPresence([{ clientId: 7, state: { name: "小琳", mode: "editing" } }]);
    expect(document.querySelectorAll(".notebook-presence__peer")).toHaveLength(2);
    expect(text()).toContain("2 人在场");
    expect(document.querySelector('[aria-label="小琳 · 在写"]')).not.toBeNull();
    // 摆的位置：常驻工具条，不是会随正文滚走的册页页眉（用户 2026-10-09 指出那一处一滚就没了）。
    expect(document.querySelector(".notebook-desk__presence .notebook-presence")).not.toBeNull();
    expect(document.querySelector(".notebook-volume__meta .notebook-presence")).toBeNull();
  });

  it("编辑态也在同一行里（写的人最该知道谁还开着这一篇）", async () => {
    stub();
    inCollabSpace();
    await open("live-preview");
    await deliverPresence([{ clientId: 7, state: { name: "小琳", mode: "reading" } }]);
    // 本机在编辑器里，那一位还在读：这一句数的是**所有人**，包括你自己。
    expect(text()).toContain("2 人在场");
    expect(document.querySelector('[aria-label="Asklins（你） · 在写"]')).not.toBeNull();
  });

  it("报上去的是档位与块号；名字改由服务端下发，不再由本机自报", async () => {
    stub();
    inCollabSpace();
    await open("preview");
    expect(presence).toHaveBeenLastCalledWith(expect.objectContaining({
      // 光标还没进正文，块号就是 null；阅读态的档位是 reading。
      state: JSON.stringify({ mode: "reading", block: null }),
    }));
    await deliverPresence([{ clientId: 7, state: { name: "小琳", mode: "reading" } }]);
    const own = document.querySelectorAll(".notebook-presence__peer")[0];
    expect(own.getAttribute("aria-label")).toBe("Asklins（你） · 在读");
    expect(own.textContent).toBe("A");
  });

  it("全屏那一档：页眉那条被收起来了，这一排挂在常驻纸签上", async () => {
    stub();
    inCollabSpace();
    await open("preview", true);
    const ribbon = document.querySelector(".notebook-focus-ribbon__presence");
    expect(ribbon).not.toBeNull();
    expect(ribbon?.textContent).toContain("只有你在看");
  });

  it("通道坏了说的是「没连上」，不会拿一个空名单说只有你在看", async () => {
    stub();
    inCollabSpace();
    await open("preview");
    await deliverStatus({ status: "failed", reason: "connection_lost" });
    expect(text()).toContain("协同没连上");
    expect(text()).not.toContain("只有你在看");
    // 重连上了这句话要收回去——留住它就是在一条活着的通道上说"别人看不到你在看"。
    await deliverStatus({ status: "authenticated" });
    expect(text()).not.toContain("协同没连上");
    expect(text()).toContain("只有你在看");
  });

  it("还没共享出去的笔记不出现这一排（那里没有别人能连上来）", async () => {
    stub({ shareScope: "private" });
    inCollabSpace();
    await open("preview");
    expect(document.querySelectorAll(".notebook-presence__peer")).toHaveLength(0);
    expect(text()).not.toContain("只有你在看");
  });

  it("个人空间里既不订阅也不出现这一排（那里没有长连接）", async () => {
    stub();
    useRoomStore.setState({
      spaceIdentity: { name: "我的空间", role: "owner", isPersonal: true, userId: "u-owner" },
      accountIdentity: { email: "owner@astella.local", displayName: "Asklins" },
    });
    await open("live-preview");
    expect(subscribe).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".notebook-presence__peer")).toHaveLength(0);
  });
});
