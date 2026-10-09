// @vitest-environment jsdom

/** Explicit saves checkpoint the current document even after autosave cleared local dirty state.
 * Deduplicating unchanged versions belongs to the server, never the renderer.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noteDocResult } from "../../../test-support/note-doc-fixtures.ts";
import { NotebookSurface } from "../notebook/notebook-surface.tsx";
import { useRoomStore } from "../../../app/room-store.ts";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";

function stubGateway() {
  const state = { saveCalls: 0, syncUpdateCalls: 0 };
  const gateway = {
    contract: { enabledRoutes: ["note.detail"] },
    auth: {
      getState: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: { status: "authenticated" as const, workspace: { workspaceId: "w-1" } },
      })),
    },
    room: {
      getProjection: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          primaryFocus: {
            state: "data",
            data: {
              objective: {
                content: { conceptLabel: "测试目标", publicSummary: "", sourceLabel: null },
                personal: { lastCanonicalAt: null },
                sources: { primaryNote: { noteId: NOTE_ID, noteVersionId: VERSION_ID } },
              },
            },
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
          title: "测试笔记",
          sourceId: null,
          currentVersionId: VERSION_ID,
          shareScope: "shared" as const,
          permissions: { canEdit: true, canSave: true },
          currentVersion: {
            versionNo: 1,
            updatedAt: new Date().toISOString(),
            contentHash: "hash-0",
            blocks: [{ ordinal: 1, type: "paragraph", content: "起点正文" }],
          },
        },
      })),
      // 手动定版那一步：把文档此刻定成一个可回去的版本。
      save: vi.fn(async () => {
        state.saveCalls += 1;
        return { ok: true as const, workspaceEpoch: 1, data: { savedAt: new Date().toISOString(), versionNo: 2 } };
      }),
      doc: {
        state: vi.fn(async () => noteDocResult()),
        syncUpdate: vi.fn(async () => {
          state.syncUpdateCalls += 1;
          return { ok: true as const, workspaceEpoch: 1, data: { via: "uploaded" as const, revision: 4, savedAt: new Date().toISOString() } };
        }),
        draftSave: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { saved: true } })),
        draftClear: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { cleared: true } })),
        draftGet: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { draft: null } })),
        presence: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { shared: false } })),
      },
    },
    capabilities: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          actionCapabilities: { "note.save": "allowed", "note.create": "allowed" },
          featureAvailability: {
            card_generation_v2: { state: "disabled" },
            companion_dialogue_v1: { state: "disabled" },
          },
        },
      })),
    },
    source: {
      get: vi.fn(async () => ({
        ok: false as const,
        error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" },
      })),
    },
  };
  window.astella = gateway as unknown as typeof window.astella;
  return { gateway, state };
}

const saveLine = () => document.querySelector('.notebook-desk__status [role="status"]')?.textContent ?? "";

async function renderEditor() {
  const stub = stubGateway();
  useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: "live-preview" } });
  vi.useFakeTimers();
  render(<NotebookSurface />);
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
  }
  return stub;
}

const typeTitle = async (value: string) => {
  const title = document.getElementById("notebook-surface-title") as HTMLInputElement;
  await act(async () => {
    fireEvent.input(title, { target: { value } });
  });
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useRoomStore.setState({ activeNoteRef: null });
});

describe("NotebookSurface · 手动定版（审计 F36）", () => {
  it("切到预览后仍提交排队的标题增量，不自动创建不可变版本", async () => {
    const { state } = await renderEditor();
    await typeTitle("切换前的最后一句");
    fireEvent.click(screen.getByRole("button", { name: "阅读" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(document.querySelector(".notebook-workspace")?.getAttribute("data-mode")).toBe("preview");
    expect(document.querySelector(".notebook-volume__heading h2")?.textContent).toBe("切换前的最后一句");
    expect(state.syncUpdateCalls).toBeGreaterThan(0);
    expect(state.saveCalls).toBe(0);
  });
  it("按钮常驻：没有未提交改动时也在屏上，名字与纸面提示同一个", async () => {
    await renderEditor();

    const button = screen.getByRole("button", { name: "保存版本" });
    expect(button).toBeTruthy();
    // 提示语里指的那个名字，屏上必须真有。
    expect(saveLine()).toBe("已同步");
    expect(document.querySelector(".notebook-save-status")?.getAttribute("title")).toContain("服务器上的版本一致");
    // 干净态不摆第二颗带"保存"字样的按钮：那时「重试保存」必须不在屏上。
    expect(screen.queryByRole("button", { name: /重试保存/ })).toBeNull();
  });

  it("自动同步后的干净态仍向服务端请求定版", async () => {
    const { state } = await renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "保存版本" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(saveLine()).toContain("已保存");
    expect(state.saveCalls).toBe(1);
  });

  it("有改动时点它真的定出一版，回执写明已保存", async () => {
    const { state } = await renderEditor();

    await typeTitle("改过的标题");
    fireEvent.click(screen.getByRole("button", { name: "保存版本" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(state.saveCalls).toBe(1);
    expect(saveLine()).toContain("已保存");
  });

  it("⌘S 在干净态也向服务端请求定版", async () => {
    await renderEditor();

    const title = document.getElementById("notebook-surface-title") as HTMLInputElement;
    await act(async () => {
      fireEvent.keyDown(title, { key: "s", metaKey: true });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(saveLine()).toContain("已保存");
  });
});
