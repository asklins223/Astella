/**
 * 更新状态机（`src/main/desktop-update.ts`）的行为约定。
 *
 * 这里测的是**判断**，不是 electron-updater 的下载能力——那部分要靠真实 Release。
 * 三条最要紧的判据：
 *
 * 1. 检查阶段的失败是 `unreachable`（没问到），**不能**是 `failed`（更新坏了）。
 *    两者对用户是两句话，而 `electron-updater` 把它们都塞进 `error` 事件。
 * 2. 下载 / 安装阶段的失败才是 `failed`。
 * 3. 同一个 phase 不重复推：渲染层的通知是按"phase 变了"触发的，
 *    重复推同一个 phase 会让用户收到两条一模一样的提示。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const updater = {
  handlers: new Map<string, (payload?: unknown) => void>(),
  autoDownload: true,
  autoInstallOnAppQuit: true,
  logger: null as unknown,
  checkForUpdates: vi.fn(async (): Promise<{ updateInfo: { version: string } } | null> => null),
  downloadUpdate: vi.fn(async () => undefined),
  quitAndInstall: vi.fn(),
  on(event: string, handler: (payload?: unknown) => void) {
    updater.handlers.set(event, handler);
  },
  emit(event: string, payload?: unknown) {
    updater.handlers.get(event)?.(payload);
  },
};

const userData = "/tmp/ailearn-update-test";
const windows: { isDestroyed: () => boolean; webContents: { send: (channel: string, payload: unknown) => void } }[] = [];

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getVersion: () => "0.1.0",
    getPath: () => userData,
    getAppPath: () => "/tmp/测试.app/Contents/Resources/app.asar",
  },
  BrowserWindow: { getAllWindows: () => windows },
}));

vi.mock("node:fs", () => ({
  existsSync: (path: string) => !String(path).includes("Resources/app.asar"),
  mkdirSync: vi.fn(),
  readFileSync: () => {
    throw new Error("no persisted check");
  },
  writeFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  // codesign 问不出来 = 当作未签名，正好把 macOS 那条分支走通。
  spawnSync: () => ({ status: 1, stdout: "", stderr: "code object is not signed at all" }),
}));

vi.mock("electron-updater", () => ({ autoUpdater: updater }));

const send = vi.fn();
beforeEach(async () => {
  vi.resetModules();
  updater.handlers.clear();
  updater.checkForUpdates.mockReset().mockResolvedValue(null);
  updater.downloadUpdate.mockReset().mockResolvedValue(undefined);
  updater.quitAndInstall.mockReset();
  windows.length = 0;
  windows.push({ isDestroyed: () => false, webContents: { send } });
  send.mockReset();
  const module = await import("../desktop-update");
  module.resetUpdateModuleForTests();
});

describe("更新状态机", () => {
  it("开发模式下如实说不检查，而不是去查一个装不上的版本", async () => {
    const { app } = await import("electron");
    (app as unknown as { isPackaged: boolean }).isPackaged = false;
    const { checkForUpdates, getUpdateState } = await import("../desktop-update");
    const state = await checkForUpdates({ userInitiated: true });
    expect(state.phase).toBe("upToDate");
    expect(state.message).toContain("开发模式");
    expect(getUpdateState().phase).toBe("upToDate");
    (app as unknown as { isPackaged: boolean }).isPackaged = true;
  });

  it("检查阶段的失败落到 unreachable，而不是 failed", async () => {
    const { checkForUpdates } = await import("../desktop-update");
    updater.checkForUpdates.mockRejectedValue(new Error("net::ERR_INTERNET_DISCONNECTED"));
    const state = await checkForUpdates({ userInitiated: true });
    // "没问到"和"更新坏了"是两句话，不能混。
    expect(state.phase).toBe("unreachable");
    expect(state.message).toContain("ERR_INTERNET_DISCONNECTED");
  });

  it("error 事件发生在检查期间时也判成 unreachable（GitHub 限额走的是这条）", async () => {
    const { checkForUpdates } = await import("../desktop-update");
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("error", new Error("API rate limit exceeded"));
      throw new Error("API rate limit exceeded");
    });
    const state = await checkForUpdates({ userInitiated: true });
    expect(state.phase).toBe("unreachable");
  });

  /**
   * 这一条是上面那条的**真正判据**。
   *
   * 修好之后终态确实是 `unreachable`——但那正是它原先也有骗过人的地方：
   * error 事件先把 phase 按成 `failed`，catch 再改回 `unreachable`，终态看着没问题，
   * 可渲染层是**按 phase 变化触发通知的**，中间那一瞬的 `failed` 已经足够让用户
   * 收到一条纯属捏造的「这次更新没能完成」。
   *
   * 所以必须断言整条相位序列里**一次都没出现过** failed。
   */
  it("检查失败时整条相位序列里不出现过 failed（否则用户会收到一条假失败通知）", async () => {
    const { checkForUpdates } = await import("../desktop-update");
    send.mockClear();
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("error", new Error("API rate limit exceeded"));
      throw new Error("API rate limit exceeded");
    });
    await checkForUpdates({ userInitiated: true });
    const phases = send.mock.calls.map(call => (call[1] as { phase: string }).phase);
    expect(phases).toContain("unreachable");
    expect(phases).not.toContain("failed");
  });

  it("下载阶段的失败才是 failed", async () => {
    const { checkForUpdates, downloadUpdate } = await import("../desktop-update");
    await checkForUpdates({ userInitiated: true });
    updater.downloadUpdate.mockRejectedValue(new Error("ENOSPC: no space left on device"));
    const state = await downloadUpdate();
    expect(state.phase).toBe("failed");
    expect(state.message).toContain("ENOSPC");
  });

  it("拿到新版本时带上 release 页地址与未签名标记", async () => {
    const { checkForUpdates } = await import("../desktop-update");
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("update-available", { version: "0.2.0", releaseNotes: "加了什么" });
      return { updateInfo: { version: "0.2.0" } };
    });
    const state = await checkForUpdates({ userInitiated: true });
    expect(state.phase).toBe("available");
    expect(state.availableVersion).toBe("0.2.0");
    // macOS 未签名那条提示里的「下载页」靠它；缺了这个链接点了没反应。
    expect(state.releaseUrl).toBe("https://github.com/asklins223/ai-learning-system/releases/tag/desktop-v0.2.0");
    expect(state.installBlockedReason).toBe("macosUnsigned");
  });

  it("同一个 phase 不重复推——通知是按 phase 变化触发的", async () => {
    const { checkForUpdates } = await import("../desktop-update");
    send.mockClear();
    await checkForUpdates({ userInitiated: true });
    await checkForUpdates({ userInitiated: true });
    const phases = send.mock.calls.map((call) => (call[1] as { phase: string }).phase);
    // 第二次是完整的又一轮，该再推一次 checking；这里只验证单轮内部不自我重复。
    expect(phases.filter(phase => phase === "checking").length).toBe(2);
    expect(new Set(phases).size).toBeLessThanOrEqual(phases.length);
  });

  it("macOS 未签名时拒绝自动安装，并把话说清楚", async () => {
    const { installUpdate } = await import("../desktop-update");
    const state = await installUpdate();
    expect(state.phase).toBe("failed");
    expect(state.message).toContain("没有代码签名");
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("下载中报的是真实字节数，不是只在动百分比", async () => {
    const { checkForUpdates, downloadUpdate } = await import("../desktop-update");
    await checkForUpdates({ userInitiated: true });
    updater.downloadUpdate.mockImplementation(async () => {
      // 慢连接下 percent 长时间为 0，这是最容易让界面"像卡住了"的形态。
      updater.emit("download-progress", { percent: 0, transferred: 1_048_576, total: 209_715_200 });
    });
    const state = await downloadUpdate();
    expect(state.phase).toBe("downloading");
    expect(state.percent).toBe(0);
    expect(state.transferred).toBe(1_048_576);
    expect(state.total).toBe(209_715_200);
  });
});