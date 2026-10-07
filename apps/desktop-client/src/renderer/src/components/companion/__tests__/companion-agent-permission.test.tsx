// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionAccountPatch, CompanionAccountStateV1 } from "@astella/shared/companion-shell-contracts";
import { CompanionAgentPermissionMenu } from "../companion-agent-permission";
import { COMPANION_ACCOUNT_CHANGED } from "../companion-events";

let account = { revision: 5, globalEnabled: true, diaryEnabled: true, agentSettings: { permissionLevel: "guided" } } as CompanionAccountStateV1;
const patches: CompanionAccountPatch[] = [];

function installApi() {
  account = { revision: 5, globalEnabled: true, diaryEnabled: true, agentSettings: { permissionLevel: "guided" } } as CompanionAccountStateV1;
  patches.length = 0;
  const accountApi = {
    getState: vi.fn(async () => ({ ok: true as const, data: { account, onboardingStates: [] } })),
    patchState: vi.fn(async (input: { request: CompanionAccountPatch }) => {
      patches.push(input.request);
      account = { ...account, agentSettings: { permissionLevel: input.request.agentPermissionLevel ?? account.agentSettings?.permissionLevel }, revision: account.revision + 1 } as CompanionAccountStateV1;
      return { ok: true as const, data: account };
    }),
  };
  const api = {
    auth: { getState: vi.fn(async () => ({ ok: true as const, data: { status: "authenticated", workspace: { workspaceEpoch: 7 } } })) },
    companion: { account: accountApi },
  };
  Object.defineProperty(window, "astella", { configurable: true, value: api });
  return api;
}

beforeEach(() => { installApi(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("助理权限就地档", () => {
  it("每一档有自己的图标，切完按钮上就换成那一档的形状", async () => {
    const changed = vi.fn();
    window.addEventListener(COMPANION_ACCOUNT_CHANGED, changed);
    render(<CompanionAgentPermissionMenu buttonClassName="companion-hud__compose-action" />);
    const trigger = await screen.findByRole("button", { name: "助理权限：分步确认" });
    expect(trigger.querySelector("svg")?.getAttribute("class")).toContain("lucide-hand");
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "助理权限档位" });
    expect(within(menu).getAllByRole("menuitemradio").map(item => item.textContent)).toEqual([
      "仅可读取只读取和查询，执行改动前需要你调整权限。",
      "分步确认每次产生改动前先征求你的确认。",
      "自动执行跳转、设置与填充可以自动执行；不可恢复的操作仍会确认。",
    ]);
    const icons = within(menu).getAllByRole("menuitemradio").map(item => item.querySelector("svg")?.getAttribute("class"));
    expect(icons.map(icon => ["lucide-eye", "lucide-hand", "lucide-zap"].find(name => icon?.includes(name)) ?? null))
      .toEqual(["lucide-eye", "lucide-hand", "lucide-zap"]);
    expect(within(menu).getByRole("menuitemradio", { name: /分步确认/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /自动执行/ }));
    await waitFor(() => expect(patches).toEqual([{ revision: 5, agentPermissionLevel: "full" }]));
    expect(changed).toHaveBeenCalled();
    const switched = await screen.findByRole("button", { name: "助理权限：自动执行" });
    expect(switched.querySelector("svg")?.getAttribute("class")).toContain("lucide-zap");
    expect(screen.queryByRole("menu")).toBeNull();
    window.removeEventListener(COMPANION_ACCOUNT_CHANGED, changed);
  });
  it("自己刚写回的那一份状态不再回头重读一次账号", async () => {
    const api = installApi();
    render(<CompanionAgentPermissionMenu buttonClassName="companion-hud__compose-action" />);
    fireEvent.click(await screen.findByRole("button", { name: "助理权限：分步确认" }));
    const readsBefore = api.companion.account.getState.mock.calls.length;
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /自动执行/ }));
    await waitFor(() => expect(patches).toHaveLength(1));
    await waitFor(() => expect(api.companion.account.getState.mock.calls.length).toBe(readsBefore));
  });
  it("点的就是当前那一档时不再写一次账号", async () => {
    const api = installApi();
    render(<CompanionAgentPermissionMenu buttonClassName="companion-history__tool" />);
    fireEvent.click(await screen.findByRole("button", { name: "助理权限：分步确认" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /分步确认/ }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(api.companion.account.patchState).not.toHaveBeenCalled();
  });
  it("这个房间没有账号级设置时，这颗按钮不出现", async () => {
    Object.defineProperty(window, "astella", {
      configurable: true,
      value: { auth: { getState: vi.fn(async () => ({ ok: true, data: { status: "anonymous", workspace: null } })) }, companion: { account: { getState: vi.fn(), patchState: vi.fn() } } },
    });
    render(<CompanionAgentPermissionMenu buttonClassName="companion-hud__compose-action" />);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByRole("button", { name: /助理权限/ })).toBeNull();
  });
});
