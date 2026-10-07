// @vitest-environment jsdom
/**
 * 设置页「客户端更新」那一组的渲染契约。
 *
 * 盯的是**措辞与可点性**，不是样式：
 * - 「暂时没问到」与「更新坏了」必须长得不一样（语气与 role 都不同）；
 * - macOS 未签名时那句「下载页」必须真的有 href——曾经 `releaseUrl` 从没被填过，
 *   那个链接点了没反应，而它是那条提示唯一的出路。
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UpdateStateV1 } from "@astella/shared/desktop-ipc-contracts";

const openExternal = vi.fn();
vi.mock("../../../../../app/desktop-client", () => ({
  createRequestMeta: () => ({ requestId: "r", correlationId: "c" }),
}));

import { SettingsUpdateGroup } from "../settings-update-panel";

function state(patch: Partial<UpdateStateV1>): UpdateStateV1 {
  return {
    phase: "idle", currentVersion: "0.1.0", availableVersion: null, releaseNotes: null,
    releaseName: null,
    releaseDate: null,
    fileSize: null,
    releaseUrl: null, percent: null, transferred: null, total: null,
    message: null, installBlockedReason: null, checkedAt: null, ...patch,
  };
}

function renderGroup(patch: Partial<UpdateStateV1>) {
  const props = { state: state(patch), busy: false, onCheck: vi.fn(), onDownload: vi.fn(), onInstall: vi.fn() };
  render(<SettingsUpdateGroup {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  (window as unknown as { astella?: unknown }).astella = { shell: { openExternal } };
});

describe("设置页「客户端更新」", () => {
  it("默认状态说清楚更新走 GitHub、不经过自家服务器", () => {
    renderGroup({});
    expect(screen.getByText(/不经过本项目的服务器/)).toBeTruthy();
    expect(screen.getByText(/当前版本 0\.1\.0/)).toBeTruthy();
  });

  it("拿不到更新信息是平的语气，不是错误语气", () => {
    renderGroup({ phase: "unreachable", message: "GitHub 的查询次数用完了，请稍后再检查。" });
    const note = screen.getByRole("status");
    expect(note.textContent).toContain("GitHub 的查询次数用完了");
    expect(note.textContent).not.toContain("API rate limit exceeded");
    // role=status 而不是 alert：这不是错误。
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("更新真的坏了才用 alert", () => {
    renderGroup({ phase: "failed", message: "ENOSPC: no space left on device" });
    expect(screen.getByRole("alert").textContent).toContain("ENOSPC");
  });

  it("下载中给真实字节数，并画一条可访问的进度条", () => {
    renderGroup({ phase: "downloading", availableVersion: "0.2.0", percent: 42, transferred: 88_080_384, total: 209_715_200 });
    expect(screen.getByText(/84\.0 MB \/ 200\.0 MB/)).toBeTruthy();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
  });

  it("macOS 未签名：说明手动安装，并给出一个真能点的下载页链接", () => {
    renderGroup({
      phase: "available", availableVersion: "0.2.0",
      installBlockedReason: "macosUnsigned",
      releaseUrl: "https://github.com/asklins223/Astella/releases/tag/v0.2.0",
    });
    expect(screen.getByText(/更新签名无效/)).toBeTruthy();
    // 曾经 releaseUrl 永远是 null，这条链接点了没反应——它是那段提示唯一的出路。
    const link = screen.getByRole("link", { name: "下载页" });
    expect(link.getAttribute("href")).toBe("https://github.com/asklins223/Astella/releases/tag/v0.2.0");
    // 未签名挡的是"自动替换应用"，**不是**下载：dmg 照样下得下来，只是要手动装。
    expect(screen.getByRole("button", { name: /下载更新/ })).toBeTruthy();
  });

  it("未签名时禁用「重启并安装」——点了也装不上，不该给一个注定失败的按钮", () => {
    renderGroup({ phase: "ready", availableVersion: "0.2.0", installBlockedReason: "macosUnsigned" });
    expect((screen.getByRole("button", { name: /重启并安装/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("行标题稳定：版本号在说明里，不在标题里", () => {
    renderGroup({ phase: "upToDate", currentVersion: "0.9.9" });
    // 这一屏的行标题要登记给伴星读；标题若随版本变化，那份登记每次发版都会整条抖动。
    expect(screen.getByText("客户端更新")).toBeTruthy();
    expect(screen.getByText(/当前版本 0\.9\.9/)).toBeTruthy();
  });
});
describe("有新版本时给出这次更新的内容、时间与大小", () => {
  it("三件事都摆出来", () => {
    renderGroup({
      phase: "available",
      availableVersion: "0.2.0",
      releaseName: "给书房加了新版房间",
      releaseNotes: "- 修复了若干问题\n- 优化了启动速度",
      releaseDate: "2026-10-04T12:50:09.026Z",
      fileSize: 250_043_464,
    });
    expect(screen.getByText(/新版本 0\.2\.0/)).toBeTruthy();
    expect(screen.getByText("给书房加了新版房间")).toBeTruthy();
    expect(screen.getByText(/2026/)).toBeTruthy();
    expect(screen.getByText("238.5 MB")).toBeTruthy();
  });

  it("有标题时优先显示标题，而不是自动生成的 notes", () => {
    renderGroup({
      phase: "available",
      availableVersion: "0.2.0",
      releaseName: "给书房加了新版房间",
      releaseNotes: "## What's Changed\n- 一堆自动生成的条目",
    });
    // GitHub 自动生成的 notes 往往把整个 changelog 铺进来；标题更像一句人话。
    expect(screen.getByText("给书房加了新版房间")).toBeTruthy();
    expect(screen.queryByText(/What's Changed/)).toBeNull();
  });

  it("只有 notes 没有标题时，退回显示 notes", () => {
    renderGroup({ phase: "available", availableVersion: "0.2.0", releaseNotes: "- 只写了条目" });
    expect(screen.getByText("- 只写了条目")).toBeTruthy();
  });

  it("没有日期或大小时，那一行不出现——不留空位也不写 0 MB", () => {
    renderGroup({ phase: "available", availableVersion: "0.2.0", fileSize: null, releaseDate: null });
    expect(screen.queryByText(/安装包大小/)).toBeNull();
    expect(screen.queryByText(/发布时间/)).toBeNull();
  });

  it("日期解析不了就不显示那一行", () => {
    renderGroup({ phase: "available", availableVersion: "0.2.0", releaseDate: "不是日期" });
    expect(screen.queryByText(/发布时间/)).toBeNull();
  });

  it("已是最新时，这些字段一并清掉", () => {
    // 否则会读成"最新版本是 0.2.0、238.5 MB、2026-10-04 发的"——那是在骗人。
    renderGroup({
      phase: "upToDate",
      availableVersion: null,
      releaseNotes: null,
      releaseName: null,
      releaseDate: null,
      fileSize: null,
    });
    expect(screen.queryByText(/安装包大小/)).toBeNull();
    expect(screen.queryByText(/发布时间/)).toBeNull();
    expect(screen.queryByText("新版本 0.2.0")).toBeNull();
    expect(screen.getByText(/已经是最新版本/)).toBeTruthy();
  });
});
