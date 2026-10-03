// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectiveLibrarySurface } from "../library/WorkspaceLibrarySurface.tsx";
import { retargetObjectiveLibraryView } from "../run/objective-library-view-state.ts";

/**
 * 理解目标列表行（2026-09-20 实走复盘 #7）。
 *
 * 用户报告的是"作答之后回到列表，完全看不出哪张刚答过"——行上只有一行 8px
 * 灰字，`unvalidated` / `archived` / `superseded` 还共用同一个灰点。本文件把
 * 两件事钉住：状态 tag 用人话，行上带服务端签发的进展事实。
 */

const OBJECTIVE_ID = "00000000-0000-4000-8000-000000000001";
const CARD_START = {
  version: 2,
  originV2: { kind: "card", cardId: "00000000-0000-4000-8000-000000000003", objectiveId: OBJECTIVE_ID },
  goal: "stabilize",
  requestedTimeBudgetSeconds: 180,
  responsePreference: "adaptive",
} as const;

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

function listItem(overrides: Record<string, unknown> = {}) {
  return {
    objectiveId: OBJECTIVE_ID,
    surfaceRevision: 1,
    conceptLabel: "惯性与质量",
    publicSummary: "质量是惯性大小的唯一量度。",
    knowledgeForm: "fact",
    cardStrategy: "why",
    lifecycle: "active",
    freshness: "fresh",
    primaryNoteId: "11111111-1111-4111-8111-111111111111",
    primaryNoteTitle: "物理笔记",
    createdAt: new Date().toISOString(),
    personalState: { state: "unvalidated", activeRunId: null },
    progress: {
      practiceTrailCount: 0,
      lastCanonicalAt: null,
      reviewDueAt: null,
      initialValidation: null,
      validationNotBefore: null,
    },
    primaryAction: {
      kind: "create_run",
      objectiveId: OBJECTIVE_ID,
      label: "开始首次验证",
      start: CARD_START,
    },
    ...overrides,
  };
}

function installApi(items: Array<Record<string, unknown>>, nextPageItems: Array<Record<string, unknown>> | null = null) {
  const objective = {
    list: vi.fn(async (request?: { cursor?: string }) => ok({
      version: 3,
      items: request?.cursor ? nextPageItems ?? [] : items,
      total: items.length + (nextPageItems?.length ?? 0),
      nextCursor: !request?.cursor && nextPageItems ? "later" : null,
      snapshotAt: new Date().toISOString(),
    })),
    get: vi.fn(async () => ok({})),
  };
  const api = {
    auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "ws-1", name: "W" }, workspaceEpoch: 1 })) },
    objective,
    room: { getProjection: vi.fn(async () => ok({ primaryFocus: { state: "empty" } })) },
  };
  Object.defineProperty(window, "ailearn", { value: api, configurable: true });
  return api;
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
  retargetObjectiveLibraryView("ws-1");
  vi.restoreAllMocks();
});

/**
 * 只看列表那一行。焦点卡片渲染的是同一个状态标签，按文本全局查会撞到两个，
 * 而"哪一处显示了它"正是本文件要钉的东西。
 */
function rowText(): string {
  return document.querySelector(".card-collection__card")?.textContent ?? "";
}

async function openIndex(): Promise<void> {
  await waitFor(() => expect(document.querySelector(".card-collection__content")).not.toBeNull());
}

async function openPack(title: string) {
  fireEvent.click(await screen.findByRole("button", { name: `打开卡包：${title}` }));
}

describe("理解目标列表行", () => {
  it("状态 tag 说人话，不把服务端枚举原样印到行上", async () => {
    installApi([listItem()]);
    render(<ObjectiveLibrarySurface />);

    await openIndex();
    await openPack("物理笔记");
    await waitFor(() => expect(rowText()).toContain("还没正式答过"));
    expect(document.body.textContent).not.toContain("unvalidated");
  });

  it("答过一次的卡，在列表上就能看出来，不用点进详情", async () => {
    installApi([listItem({
      personalState: { state: "stable", activeRunId: null },
      progress: {
        practiceTrailCount: 2,
        lastCanonicalAt: new Date().toISOString(),
        reviewDueAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        initialValidation: "completed",
        validationNotBefore: null,
      },
    })]);
    render(<ObjectiveLibrarySurface />);

    await openIndex();
    await openPack("物理笔记");
    await waitFor(() => expect(rowText()).toContain("已经答对过"));
    expect(rowText()).toContain("正式答过 · 今天");
    expect(rowText()).toContain("复习 5 天后");
  });

  it("看过答案的卡把「什么时候才能正式算」直接摆在行上", async () => {
    const notBefore = new Date(Date.now() + 20 * 3_600_000);
    installApi([listItem({
      progress: {
        practiceTrailCount: 0,
        lastCanonicalAt: null,
        reviewDueAt: null,
        initialValidation: "deferred",
        validationNotBefore: notBefore.toISOString(),
      },
      primaryAction: {
        kind: "practice_only",
        objectiveId: OBJECTIVE_ID,
        reasonCodes: ["exposed"],
        label: "带着参考答案练一下",
        start: CARD_START,
        formalValidationNotBefore: notBefore.toISOString(),
      },
    })]);
    render(<ObjectiveLibrarySurface />);

    await openIndex();
    await openPack("物理笔记");
    await waitFor(() => expect(rowText()).toMatch(/后才能正式答/));
    // 时间点必须渲染成"月日 时分"，不能把 ISO 串漏到界面上。
    expect(rowText()).toMatch(/\d+月\d+日 \d{2}:\d{2} 后才能正式答/);
    expect(rowText()).not.toContain(notBefore.toISOString());
  });
});

/**
 * W7-6 刀二：卡库**顶层按笔记成组**（39 §8.5 第一、二段）。
 *
 * 钉的是屏上那一层，纯函数那一层（键是 noteId、三档互斥、未关联排最后）由
 * `packages/shared/src/objective-card-groups-v2.test.ts` 钉住——这里钉的是
 * **它真的被画出来了**：组头存在、三个数分开写、未关联那一组有自己的样子。
 *
 * 每格带正控制：① 的反向是"没有笔记的那些**不**进真实笔记的组"；② 的反向是
 * "三个数合成一个总数"（那会让"两张要核对"看不见）；③ 的反向是"未关联组排在最前"。
 */
describe("卡库按笔记成组（39 §8.5）", () => {
  const NOTE_A = "11111111-1111-4111-8111-111111111111";
  const NOTE_B = "22222222-2222-4222-8222-222222222222";
  const future = () => new Date(Date.now() + 5 * 86_400_000).toISOString();
  const row = (over: Record<string, unknown>) => listItem({ ...over });

  async function renderIndex(items: Array<Record<string, unknown>>) {
    installApi(items);
    render(<ObjectiveLibrarySurface />);
    await openIndex();
  }

  function groupHeads(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(".card-collection__pack[data-note-group]")];
  }

  it("顶层按笔记成组，一篇一个组；卡的真实复习安排保留在要点上", async () => {
    await renderIndex([
      row({ objectiveId: "00000000-0000-4000-8000-0000000000a1", primaryNoteId: NOTE_A, primaryNoteTitle: "力学笔记" }),
      row({ objectiveId: "00000000-0000-4000-8000-0000000000a2", primaryNoteId: NOTE_A, primaryNoteTitle: "力学笔记" }),
      row({
        objectiveId: "00000000-0000-4000-8000-0000000000b1",
        primaryNoteId: NOTE_B,
        primaryNoteTitle: "光学笔记",
        progress: { practiceTrailCount: 0, lastCanonicalAt: null, reviewDueAt: future(), initialValidation: null, validationNotBefore: null },
      }),
    ]);
    expect(groupHeads()).toHaveLength(2);
    expect(screen.getByRole("button", { name: "打开卡包：力学笔记" }).textContent).toContain("2 张学习卡");
    await openPack("光学笔记");
    expect(document.querySelectorAll(".card-collection__card")).toHaveLength(1);
    expect(rowText()).toContain("复习 5 天后");
    fireEvent.click(screen.getByRole("button", { name: "全部卡包" }));
    await openPack("力学笔记");
    expect(document.querySelectorAll(".card-collection__card")).toHaveLength(2);
  });

  it("正对照：没有笔记的那些进「未关联笔记」组，且不混进真实笔记的组", async () => {
    await renderIndex([
      row({ objectiveId: "00000000-0000-4000-8000-0000000000a1", primaryNoteId: NOTE_A, primaryNoteTitle: "力学笔记" }),
      // id 为 null **但标题有值** ⇒ 仍进未关联（§8.5「不按标题猜造」）。
      row({ objectiveId: "00000000-0000-4000-8000-0000000000c1", primaryNoteId: null, primaryNoteTitle: "看起来像笔记的标题" }),
    ]);
    const heads = groupHeads();
    expect(heads.length).toBe(2);
    const ungrouped = heads.find((h) => h.dataset.noteGroup === "ungrouped");
    expect(ungrouped).toBeTruthy();
    expect(ungrouped!.textContent).toContain("未关联笔记");
    // 它排**最后**：真实笔记的组才是主要内容（§8.5 末段：这是切换盘点期的遗留）。
    expect(groupHeads().at(-1)!.dataset.noteGroup).toBe("ungrouped");
  });

  it("组内的卡行仍然是原来那些行（分组不换掉行的内容与入口）", async () => {
    await renderIndex([
      row({ objectiveId: "00000000-0000-4000-8000-0000000000a1", primaryNoteId: NOTE_A, primaryNoteTitle: "力学笔记", conceptLabel: "惯性与质量" }),
    ]);
    await openPack("力学笔记");
    expect(document.querySelectorAll(".card-collection__card").length).toBe(1);
    expect(document.querySelector(".card-collection__card-body > strong")?.textContent).toBe("惯性与质量");
  });

  it("没有制作卡片的笔记目标不占焦点卡、卡组或卡片计数", async () => {
    await renderIndex([
      row({ objectiveId: "00000000-0000-4000-8000-0000000000a1", cardStrategy: null, conceptLabel: "无卡笔记目标", primaryNoteTitle: "无卡笔记" }),
      row({ objectiveId: "00000000-0000-4000-8000-0000000000b1", primaryNoteId: NOTE_B, primaryNoteTitle: "已制卡笔记", conceptLabel: "已保存卡片" }),
    ]);

    await openPack("已制卡笔记");
    expect(document.querySelector(".card-collection__card-body > strong")?.textContent).toBe("已保存卡片");
    expect(groupHeads()).toHaveLength(1);
    expect(groupHeads()[0]?.textContent).toContain("已制卡笔记");
    expect(document.querySelectorAll(".card-collection__card")).toHaveLength(1);
    expect(document.querySelector(".card-collection__welcome")?.textContent).toContain("共 1 张卡");
    expect(document.body.textContent).not.toContain("无卡笔记目标");
  });

  it("当前页只有无卡目标时仍可继续查找后续页的已保存卡", async () => {
    const api = installApi(
      [row({ objectiveId: "00000000-0000-4000-8000-0000000000a1", cardStrategy: null, conceptLabel: "无卡笔记目标" })],
      [row({ objectiveId: "00000000-0000-4000-8000-0000000000b1", conceptLabel: "后续页卡片" })],
    );
    render(<ObjectiveLibrarySurface />);

    const continueButton = await waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>(".approved-state--empty button")]
        .find((candidate) => candidate.textContent?.includes("继续查找学习卡"));
      expect(button).toBeTruthy();
      return button!;
    });
    expect(document.body.textContent).toContain("笔记本身可以直接学习");
    expect(document.querySelector(".objective-quest-node")).toBeNull();

    fireEvent.click(continueButton);
    await openPack("物理笔记");
    expect(document.querySelector(".card-collection__card-body > strong")?.textContent).toBe("后续页卡片");
    expect(api.objective.list).toHaveBeenCalledTimes(2);
    expect(api.objective.list.mock.calls[1]?.[0]?.cursor).toBe("later");
    expect(document.querySelector(".card-collection__welcome")?.textContent).toContain("共 1 张卡");
  });
});
