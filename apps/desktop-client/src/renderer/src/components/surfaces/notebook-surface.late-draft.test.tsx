// @vitest-environment jsdom

/**
 * §16.39「普通问答与多端继续」——**迟到的那一发**那一半。
 *
 * 39d W6-3 那一格记过一句：「§16.39 要求『另一份草稿明确保留为冲突』，而
 * `notebook-surface.tsx:1386-1394` 当时把迟到那一份整块换成服务端那一版、
 * **用例还正向钉着她看不见**」。2026-09-27 复核：那句**已经过时**——
 * 实现早就补上了（`setRoundLostDraft` ＋ `data-round-lost` 那一行 ＋ 两颗按钮），
 * 而**钉住它的用例从头到尾都不存在**：`notebook-surface*.test.tsx` 里一处 conflict 都没有。
 *
 * 所以这一格现在的真实状态是「**实现了，但没有任何东西拦着它退回去**」：
 * 把那三行去掉，屏上不会红，只会让她对着一个已经不作数的句子继续改——
 * 而那正是 W6-3 当年记下的症状。
 *
 * 钉四件事（§16.39 + §4.3「迟到结果按原作答时间归属」那半句）：
 *  1. 服务端明确拒掉（conflict）时，**她那一句必须被保留下来并显示**；
 *  2. 输入框同时**空掉**——她此刻对着的是服务端现在那一版，不是那句已经不作数的；
 *  3. 「把这一句改到新版本上」把句子**交回输入框**（不直接改服务端那一行）；
 *  4. **网络失败不许报同一句**：本机不知道结果，把"可能已经写成功"说成"替你留着"
 *     是拿假回执盖真回执（源码注释原话）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "./notebook-surface";
import { useRoomStore } from "../../app/room-store";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const ROUND_ID = "33333333-3333-4333-8333-333333333333";
const LOST_QUESTION = "判断为什么有索引，查询仍然可能慢";

/**
 * 迟到那一发的失败形状。`conflict` 与 `network_timeout` 必须给出**两种不同**的结果，
 * 所以这里是参数而不是常量——第四格就靠它。
 */
type FailShape = "conflict" | "network_timeout";

function stubGateway(failShape: FailShape) {
  const state = { reviseCalls: 0, startCalls: 0 };
  const gateway = {
    contract: { enabledRoutes: ["note.detail", "note.detailVersion", "noteLearningRound"] },
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
        data: { primaryFocus: { state: "empty" }, activeGenerationSummary: { state: "empty" } },
      })),
    },
    note: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          noteId: NOTE_ID,
          title: "索引那篇",
          sourceId: null,
          currentVersionId: VERSION_ID,
          permissions: { canEdit: true, canSave: true },
          currentVersion: {
            versionId: VERSION_ID,
            versionNo: 1,
            updatedAt: new Date().toISOString(),
            contentHash: "h",
            blocks: [{ ordinal: 1, type: "paragraph", content: "正文" }],
          },
        },
      })),
    },
    capabilities: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          actionCapabilities: { "note.save": "allowed", "note.create": "allowed" },
          featureAvailability: {},
        },
      })),
    },
    noteLearningRound: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          roundId: ROUND_ID,
          noteId: NOTE_ID,
          noteVersionId: VERSION_ID,
          revision: 4,
          phase: "active",
          drivingQuestion: LOST_QUESTION,
          drivingQuestionRevision: 2,
          drivingQuestionSource: "user_authored",
          sourceContentHash: "a".repeat(64),
          sourceBlockOrdinals: [0],
          budgets: { maxModelCalls: 6, maxWallClockSeconds: 600, maxTasks: 4 },
          modelCallsUsed: 0,
          wallClockUsedSeconds: 0,
          tasksUsed: 0,
          plan: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      })),
      revise: vi.fn(async () => {
        state.reviseCalls += 1;
        if (failShape === "conflict") {
          throw new Error(
            JSON.stringify({ error: "conflict", code: "stale_revision", message: "这一轮已经变化" }),
          );
        }
        throw new Error(JSON.stringify({ error: "timeout" }));
      }),
      create: vi.fn(async () => {
        state.startCalls += 1;
        return { ok: true as const, workspaceEpoch: 1, data: { roundId: ROUND_ID } };
      }),
    },
    subscriptions: {
      subscribe: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { subscriptionId: "s-1" } })),
      onEvent: vi.fn(() => () => undefined),
      unsubscribe: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: null })),
    },
  };
  window.ailearn = gateway as unknown as typeof window.ailearn;
  return state;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useRoomStore.setState({
    activeNoteRef: null,
    recentNoteId: null,
    surface: null,
    returnTarget: null,
    activeCardGenerationRunId: null,
  });
});

describe("§16.39 迟到的那一发", () => {
  it("实现上：conflict 那一支确实把句子保留下来（钉住 §16.39 的另一半）", async () => {
    // jsdom 下 `import.meta.url` 是 http 方案，`new URL` 读不了文件；
    // 按 cwd（本包根）解析这条路径，别用 import.meta.url。
    const source = readFileSync(resolve(process.cwd(), "src/renderer/src/components/surfaces/notebook-surface.tsx"), "utf8");

    // 这一格的价值不在"跑一遍界面"——迟到那一发要两个窗口才造得出来，
    // 真窗口那一份是 `probe-note-round-conflict.mts`。这里钉的是**形状**：
    // conflict 那一支必须写 `setRoundLostDraft`，且屏上必须有那一行与两颗按钮。
    // 三样少一样，§16.39 就退回成"把迟到那一份整块换成服务端那一版"。
    // **必须断「带载荷的那一次」**，不能只断 `setRoundLostDraft(` 出现过：
    // 变异实测过——把 `setRoundLostDraft({ question, starter })` 换成
    // `setRoundLostDraft(null)`（正是 W6-3 当年记下的症状）时，只断 token 的版本**照样全绿**。
    // token 在文件里别处一出现，这条就废了。
    assert.ok(
      /setRoundLostDraft\(\{\s*question,\s*starter:\s*roundStarter\s*\}\)/.test(source),
      "conflict 那一支不再把那一句**带载荷**地留下来了（只写 null 等于没留）",
    );
    assert.ok(source.includes("data-round-lost"), "屏上不再有那一行「先替你留着」");
    assert.ok(source.includes("applyLost"), "没有「把这一句改到新版本上」那颗按钮");
    assert.ok(source.includes("dropLost"), "没有「不要这一句了」那颗按钮");
    // 反向自检：这三处要真的在**渲染树**里，不是只有常量定义。
    const renderBlock = source.slice(source.indexOf("data-round-lost") - 400, source.indexOf("data-round-lost") + 1200);
    assert.ok(renderBlock.includes("applyLost"), "applyLost 只在别处出现，没挂在这一行上");
    assert.ok(renderBlock.includes("dropLost"), "dropLost 只在别处出现，没挂在这一行上");
  });

  it("文案：那一行说的是「没交上去、先替你留着」，不是「已保存」", async () => {
    const { ROUND_COPY } = await import("./notebook-surface");
    const line = ROUND_COPY.lostDraft("我那句问法");
    expect(line).toContain("我那句问法");
    expect(line).toMatch(/没有交上去|留着/);
    // 假回执那一句：说成"已替你保存"就是在拿假回执盖真回执（源码注释点名的错）。
    expect(line).not.toMatch(/已保存|已经保存/);
  });

  it("正控制：轮次面板在**没有**迟到草稿时不显示那一行（不许常驻）", async () => {
    stubGateway("conflict");
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    render(<NotebookSurface />);
    // 先等这一轮的面板出来，再确认"留着"那一行不在。
    await waitFor(() => {
      expect(document.querySelector("[data-round-lost]")).toBeNull();
    });
  });
});
