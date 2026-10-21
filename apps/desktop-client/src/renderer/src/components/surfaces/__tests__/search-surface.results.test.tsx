// @vitest-environment jsdom

/**
 * F47 的跨层判据：**服务端那一页有几条，界面就必须列出几条**。
 *
 * 这条链路此前没有任何用例覆盖，所以它能"全绿而功能完全不可用"——审计当场量到的
 * 是界面「0 / 0 条 · 没有找到」，而同一时刻服务端对同参请求返回 `total=5`。
 * 复现的条件是真实的：StrictMode（main.tsx 就这么挂的，effect 会跑两遍）、
 * 异步 40ms 才回来的页、连打三个键，以及"同一次输入只发一条请求"。
 *
 * 断言分三层，缺一层就有一条静默失效的路：
 *  1. 只发一条请求——同参发两条正是审计日志里的读数，响应归属错了就会互相覆盖；
 *  2. 行数等于页里的条数（不是"大于 0"，那样空页与半页都能绿）；
 *  3. 进度读数 `N / N 条` 与 `total` 同源。
 */
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GatewayResultV1, SessionContextV1 } from "@astella/shared/desktop-ipc-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../app/home/room-store.ts";
import { SearchSurface } from "../study/search-surface.tsx";

const TITLES = ["阿里云百炼", "IndexTTS 语音合成", "TTS 笔记", "TTS 对比", "理解 TTS"];

function session(): SessionContextV1 {
  return {
    version: 1,
    status: "authenticated",
    user: { userId: "11111111-1111-4111-8111-111111111111", email: "reader@example.com" },
    workspace: {
      version: 1,
      workspaceId: "22222222-2222-4222-8222-222222222222",
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
    requestId: "search-test",
    correlationId: "search-test",
    schemaRevision: "desktop-ipc-v1",
  };
}

/** 与服务端 `apps/api/src/modules/search/service.ts` 返回的行同形。 */
function serverPage() {
  const items = TITLES.map((title, index) => ({
    objectType: index < 2 ? "source" : "note",
    objectId: `33333333-3333-4333-8333-33333333333${index}`,
    title,
    snippet: `…${title}…`,
    indexedAt: "2026-09-22T07:22:05.460Z",
    href: `/x/${index}`,
    matchCount: 1,
  }));
  return { items, total: items.length, nextCursor: null };
}

function installApi() {
  const calls: string[] = [];
  const api = {
    auth: { getState: vi.fn(async () => ok(session())) },
    search: {
      global: vi.fn(async (input: { query: string }) => {
        calls.push(input.query);
        await new Promise((resolve) => setTimeout(resolve, 40));
        return ok(serverPage());
      }),
    },
    note: {
      get: vi.fn(async () => ok({
        noteId: "33333333-3333-4333-8333-333333333333",
        title: TITLES[2],
        sourceId: null,
        currentVersionId: "44444444-4444-4444-8444-444444444444",
        currentVersion: { versionNo: 1, updatedAt: "2026-09-22T07:22:05.460Z", contentHash: "h", blocks: [{ ordinal: 1, type: "paragraph", content: "TTS 笔记正文" }] },
      })),
    },
    source: { get: vi.fn() },
  };
  Object.defineProperty(window, "astella", { configurable: true, value: api });
  return { api, calls };
}

beforeEach(() => {
  useRoomStore.setState({ searchResume: null, searchQuery: "", searchTypeFilter: "all" });
  useRoomStore.setState({ searchQuery: "", searchTypeFilter: "all" });
  Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: () => undefined });
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
});

afterEach(() => {
  useRoomStore.setState({ searchResume: null });
  cleanup();
  Reflect.deleteProperty(window, "astella");
  Reflect.deleteProperty(Element.prototype, "scrollTo");
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  useRoomStore.setState({ searchQuery: "", searchTypeFilter: "all", hudPage: "home" });
  vi.restoreAllMocks();
});

describe("全局搜索 · 界面必须与服务端同一页同量", () => {
  it("输入 TTS：只发一条请求，五行全部列出，进度读数与 total 同源", async () => {
    const { calls } = installApi();
    render(<StrictMode><SearchSurface /></StrictMode>);

    const box = screen.getByRole("searchbox");
    fireEvent.change(box, { target: { value: "T" } });
    fireEvent.change(box, { target: { value: "TT" } });
    fireEvent.change(box, { target: { value: "TTS" } });

    const list = await screen.findByRole("listbox", { name: "搜索结果" });
    const rows = await waitFor(() => {
      const found = list.querySelectorAll("[role='option']");
      expect(found.length).toBe(TITLES.length);
      return found;
    });
    // 每一行都在，而不是"有几行算几行"。
    expect([...rows].map(row => row.querySelector("b")?.textContent)).toEqual(TITLES);
    // 进度读数与那 5 条同源（`items.length / total`）。同一句还出现在 aria-live
    // 状态行里，所以这里量的是列表里那一处可见读数。
    expect(rows.length).toBe(serverPage().total);
    expect(within(list).getByText("5 / 5 条")).toBeTruthy();
    // 三个键只发一条：同参发两条会让响应归属参与竞争（审计日志里的读数）。
    expect(calls).toEqual(["TTS"]);
  });
});

const OBJECTIVE_ID = "55555555-5555-4555-8555-555555555555";
const RUN_ID = "66666666-6666-4666-8666-666666666666";


/**
 * 同一个服务端值只准一套词（39d D3 刀一·附 那条规则的第三个读者）。
 *
 * `objective-state-copy.freshnessLabel` 的注释写的就是这种形状：笔记页要附那枚徽标时，
 * 如果每块屏各写一句，同一个 `freshness` 就会在两块屏上说两个词。搜索这一面此前正是
 * 第二份词（「来源已经过期」对笔记页的「来源已有更新」）。
 * 三条一起给：两个说法各自的状态名要跟服务端那一格同源，而 `fresh` 那一档**不该有这一行**
 * ——少了反向那一条，"出现了"可以是任何东西让它出现。
 */
