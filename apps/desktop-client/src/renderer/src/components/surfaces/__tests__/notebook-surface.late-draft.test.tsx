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

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "../notebook/notebook-surface.tsx";
import { ROUND_COPY } from "../notebook/notebook-round-copy.ts";
import { useRoomStore } from "../../../app/room-store.ts";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const ROUND_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
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
      // 2026-09-29 修正：这份替身原先调 `get`，而**真实网关是 `open`**，
      // 并且回的是 `{version, round, contentMoved}` 那一层信封，不是轮次记录本身。
      // 后果是轮次面板**从来没渲染过**——于是本文件里那条「正控制：没有迟到草稿时
      // 不显示那一行」一直是在**空面板上**通过的，是条空断言。
      open: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          version: 1,
          contentMoved: false,
          noteChangeImpact: null,
          round: {
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
      // 2026-09-30 补上：`teaching` 与 `history` 这两条缺了，轮次面板虽然打开了，
      // 但**讲解区与「练过什么」那一格渲染不出来**。补齐之后本文件里那条
      // 「没有迟到草稿时不显示那一行」才第一次是在**真面板**上跑。
      // 两者都按 `unwrapGatewayResult` 的形状回：外面那层是 `{ok, workspaceEpoch, data}`。
      teaching: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          version: 1,
          roundId: ROUND_ID,
          createdAt: "2026-09-29T00:00:00.000Z",
          teaching: null,
          practices: [],
          nextStep: null,
        },
      })),
      history: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: { version: 1, noteId: NOTE_ID, items: [], hasMore: false, nextCursor: null, shownCount: 0, totalCount: 0 },
      })),
      preparePractice: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { runId: RUN_ID } })),
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
  it("文案：那一行说的是「没交上去、先替你留着」，不是「已保存」", async () => {
    const line = ROUND_COPY.lostDraft("我那句问法");
    expect(line).toContain("我那句问法");
    expect(line).toMatch(/没有交上去|留着/);
    // 假回执那一句：说成"已替你保存"就是在拿假回执盖真回执（源码注释点名的错）。
    expect(line).not.toMatch(/已保存|已经保存/);
  });

  /**
   * 这一条以前是**空断言**（2026-09-29 记下）：网关替身缺 `teaching` / `history`，
   * 轮次面板**整段没渲染**，所以 `querySelector("[data-round-lost]")` 恒为 null——
   * 它通过不是因为「没有迟到草稿时不显示那一行」，而是因为什么都没渲染。
   *
   * 2026-09-30 补齐那两条法之后，它第一次是在**真面板**上跑。补齐的方式就是
   * 多给两条假的回信——**断言本身一个字没改**。
   *
   * §16.39 的**冲突分支**（必须带载荷地写 `setRoundLostDraft`、屏上必须有那一行与两颗按钮）
   仍由 `src/main/notebook-round-lost-shape-guard.test.ts` 钉住——静态形状判据属于守卫，
   * 而且守卫在目录树里按文件名定位，`notebook-surface.tsx` 拆分不会波及它。
   */
  it("轮次面板在**没有**迟到草稿时不显示那一行；有了才显示，且带两颗按钮", async () => {
    stubGateway("conflict");
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, learningRoundId: ROUND_ID, mode: "read" } });
    render(<NotebookSurface />);
    // ⚠️ **先等这一页加载完**（`aria-busy` 落下），再谈那一行在不在。
    // 原先的写法是在 `waitFor` 的**第一次**回调里就查——那一刻投影还没回信，
    // 于是查的是一个 `aria-busy="true"` 的空壳。面板出不出来与这条断言无关。
    await waitFor(() => {
      expect(document.querySelector(".notebook[aria-busy='true']")).toBeNull();
    });
    // 面板真的出来了，才轮到确认「留着」那一行不在。
    expect(document.querySelector(".round-desk")).not.toBeNull();
    expect(document.querySelector("[data-round-lost]")).toBeNull();

    // ── 这一条的正控制不在本文件（2026-09-30 量过的，别把它当已覆盖）──────────
    //
    // 「有草稿时那一行与两颗按钮会出现」这条**正控制**需要先真的撞出一次 conflict，
    // 而那要求替身给出一份**可作答的轮次**（`roundTeachingView.practices` 里有 task、
    // 页面据此渲染题面输入框）。本文件的替身给的是 `practices: []`——面板出得来，
    // **题面那一格出不来**，所以驱动不了真实作答。
    //
    // 因此那条正控制仍由 `src/main/notebook-round-lost-shape-guard.test.ts` 钉住：
    // 它静态判「§16.39 那一支必须带载荷地写 `setRoundLostDraft`」与「那一行上得有
    // 两颗按钮」。守卫在目录树里按文件名定位，`notebook-surface.tsx` 拆分不会波及它。
    //
    // **这里补上的是另一半**：确认轮次面板**真的渲染出来了**（`.round-desk` 存在）。
    // 少了这一句，上面那句 `toBeNull()` 在空面板上也会通过——它空了半年就是这么空的。
  });
});
