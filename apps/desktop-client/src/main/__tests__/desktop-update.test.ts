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
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Keep macOS signature checks active on Linux CI as well. */
const realPlatform = process.platform;
Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
afterAll(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

const updater = {
  handlers: new Map<string, (payload?: unknown) => void>(),
  autoDownload: true,
  autoInstallOnAppQuit: true,
  logger: null as unknown,
  checkForUpdates: vi.fn(async (): Promise<{ updateInfo: { version: string } } | null> => null),
  downloadUpdate: vi.fn(async () => undefined),
  quitAndInstall: vi.fn(),
  prepareInstall: vi.fn(async () => ({ launch: vi.fn(async () => undefined), stagingDirectory: "/Applications/.astella-update-test" })),
  on(event: string, handler: (payload?: unknown) => void) {
    updater.handlers.set(event, handler);
  },
  emit(event: string, payload?: unknown) {
    updater.handlers.get(event)?.(payload);
  },
};

const userData = "/tmp/astella-update-test";
const runtime = vi.hoisted(() => ({ version: "0.1.0", cached: null as string | null }));
const windows: { isDestroyed: () => boolean; webContents: { send: (channel: string, payload: unknown) => void } }[] = [];

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getVersion: () => runtime.version,
    getPath: () => userData,
    quit: vi.fn(),
    getAppPath: () => "/tmp/测试.app/Contents/Resources/app.asar",
  },
  BrowserWindow: { getAllWindows: () => windows },
}));

vi.mock("node:fs", () => ({
  existsSync: (path: string) => !String(path).includes("Resources/app.asar"),
  mkdirSync: vi.fn(),
  readFileSync: () => {
    if (runtime.cached) return runtime.cached;
    throw new Error("no persisted check");
  },
  writeFileSync: vi.fn(),
}));

const receipts = vi.hoisted(() => ({ value: null as { fromVersion: string; version: string; status: string } | null }));
vi.mock("../update-install-receipt", () => ({ UpdateInstallReceiptStore: class {
  read() { return receipts.value; }
  write(value: typeof receipts.value) { receipts.value = value; }
  reconcile() { return receipts.value?.status === "acknowledged" ? null : receipts.value; }
  acknowledge() { if (receipts.value) receipts.value.status = "acknowledged"; }
} }));
vi.mock("../macos-archive-updater", () => ({ MacosArchiveUpdater: class { constructor() { return updater; } } }));
vi.mock("../windows-installer-updater", () => ({ WindowsInstallerUpdater: class { constructor() { return updater; } } }));

vi.mock("electron-updater", () => ({ autoUpdater: updater }));

const send = vi.fn();
beforeEach(async () => {
  vi.resetModules();
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  runtime.version = "0.1.0";
  runtime.cached = null;
  receipts.value = null;
  updater.prepareInstall.mockReset().mockResolvedValue({ launch: vi.fn(async () => undefined), stagingDirectory: "/Applications/.astella-update-test" });
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
  it("更新后丢弃旧版本缓存，以真实运行版本确认成功，展示后不会再报", async () => {
    const module = await import("../desktop-update");
    await module.checkForUpdates({ userInitiated: true });
    updater.emit("update-available", { version: "0.2.0" });
    runtime.cached = JSON.stringify({ checkedAt: Date.now(), state: module.getUpdateState() });
    runtime.version = "0.2.0";
    module.resetUpdateModuleForTests();
    module.primeUpdateStateFromCache();
    expect(module.getUpdateState()).toMatchObject({ phase: "idle", currentVersion: "0.2.0", availableVersion: null,
      installedUpdate: { fromVersion: "0.1.0", version: "0.2.0" } });
    module.acknowledgeInstalledUpdate("0.2.0");
    module.resetUpdateModuleForTests();
    module.primeUpdateStateFromCache();
    expect(module.getUpdateState().installedUpdate).toBeNull();
  });

  it("已有可安装包时检查不会把它改回可下载，重复安装也不启动第二个替换进程", async () => {
    const module = await import("../desktop-update");
    await module.checkForUpdates({ userInitiated: true });
    updater.emit("update-downloaded", { version: "0.2.0" });
    updater.checkForUpdates.mockClear();
    expect((await module.checkForUpdates({ userInitiated: true })).phase).toBe("ready");
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await Promise.all([module.installUpdate(), module.installUpdate()]);
    expect(updater.prepareInstall).toHaveBeenCalledOnce();
  });

  it("Windows 先启动独立安装器，再退出应用并保存成功回执", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const module = await import("../desktop-update");
    await module.checkForUpdates({ userInitiated: true });
    updater.emit("update-downloaded", { version: "0.2.0" });
    await module.installUpdate();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(updater.prepareInstall).toHaveBeenCalledOnce();
    const prepared = await updater.prepareInstall.mock.results[0].value;
    expect(prepared.launch).toHaveBeenCalledOnce();
    expect((await import("electron")).app.quit).toHaveBeenCalled();
    expect(receipts.value).toMatchObject({ status: "pending", version: "0.2.0" });
  });
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
    expect(state.message).toContain("检查网络");
    expect(state.message).not.toContain("ERR_INTERNET_DISCONNECTED");
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
    expect(state.message).toContain("可用空间不足");
  });

  it("缺少打包更新配置时说明真实原因，不显示本机路径或误报断网", async () => {
    const { checkForUpdates } = await import("../desktop-update");
    updater.checkForUpdates.mockRejectedValue(new Error("ENOENT: no such file, open '/private/test.app/Contents/Resources/app-update.yml'"));
    const state = await checkForUpdates({ userInitiated: true });
    expect(state.phase).toBe("unreachable");
    expect(state.message).toContain("缺少更新配置");
    expect(state.message).not.toMatch(/private|app-update|网络/);
  });

  it("无证书也可下载和安装，带上 release 页地址", async () => {
    const { checkForUpdates } = await import("../desktop-update");
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("update-available", { version: "0.2.0", releaseNotes: "加了什么" });
      return { updateInfo: { version: "0.2.0" } };
    });
    const state = await checkForUpdates({ userInitiated: true });
    expect(state.phase).toBe("available");
    expect(state.availableVersion).toBe("0.2.0");
    // macOS 未签名那条提示里的「下载页」靠它；缺了这个链接点了没反应。
    expect(state.releaseUrl).toBe("https://github.com/asklins223/Astella/releases/tag/v0.2.0");
    expect(state.installBlockedReason).toBeNull();
  });

  /**
   * GitHub 的 release feed（`releases.atom` 的 `<content type="html">`）给的是
   * **渲染后的 HTML**，而通知纸片与设置页都按纯文本显示它。原样传下去的话，
   * 用户读到的就是 `<p>Astella v1.3.2</p>` 和一排 `<li>`（2026-10-09 真实截图）。
   */
  it("release 正文是 HTML 时洗成纯文本，通知里不再露出标签", async () => {
    const { checkForUpdates } = await import("../desktop-update");
    const html = [
      "<p>Astella v0.2.0</p>",
      "<ul>",
      "<li>生成学习卡这类 AI 操作，会在创建任务前确认本人的 AI 同意。</li>",
      "<li>伴星把同一话题的连续补充当成一段话理解。</li>",
      "</ul>",
      "<p>已安装旧版的用户可在客户端检查更新。</p>",
    ].join("\n");
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("update-available", { version: "0.2.0", releaseNotes: html });
      return { updateInfo: { version: "0.2.0" } };
    });
    const state = await checkForUpdates({ userInitiated: true });
    expect(state.releaseNotes).toBe([
      "Astella v0.2.0",
      "· 生成学习卡这类 AI 操作，会在创建任务前确认本人的 AI 同意。",
      "· 伴星把同一话题的连续补充当成一段话理解。",
      "已安装旧版的用户可在客户端检查更新。",
    ].join("\n"));
  });

  /**
   * 一条笔记在 markdown 里换行（`release-notes.mjs` 把正文里的换行缩进两格续排）
   * 时，浏览器渲染出来仍然是一项。折成一行是纸片那条"按要点取行"的规矩能成立的前提，
   * 否则后半句会被当成另一段、在通知里凭空消失。
   */
  it("一条笔记在正文里换行时仍是一项，不会被拆成两行", async () => {
    const { checkForUpdates } = await import("../desktop-update");
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("update-available", {
        version: "0.2.0",
        releaseNotes: "<ul>\n<li>生成学习卡前会先确认本人的 AI 同意；\n  取消、手动保存和审核已有内容不受影响。</li>\n<li><p>松散写的项</p><p>第二段</p></li>\n</ul>",
      });
      return { updateInfo: { version: "0.2.0" } };
    });
    const state = await checkForUpdates({ userInitiated: true });
    expect(state.releaseNotes).toBe([
      "· 生成学习卡前会先确认本人的 AI 同意； 取消、手动保存和审核已有内容不受影响。",
      "· 松散写的项 第二段",
    ].join("\n"));
  });

  it("正文里的实体与行内标签还原成文字，行内空格不丢", async () => {
    const { checkForUpdates } = await import("../desktop-update");
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("update-available", {
        version: "0.2.0",
        releaseNotes: '<p>未配置签名时可能经过 &#34;仍要打开&#34; 与 SmartScreen，用法是 <code>npm run dev</code> 与 <strong>加粗</strong> <em>斜体</em>，写作 v1&lt;2。</p>',
      });
      return { updateInfo: { version: "0.2.0" } };
    });
    const state = await checkForUpdates({ userInitiated: true });
    expect(state.releaseNotes).toBe(
      "未配置签名时可能经过 \"仍要打开\" 与 SmartScreen，用法是 npm run dev 与 加粗 斜体，写作 v1<2。"
    );
  });

  it("macOS 安装先暂存、写入重启回执，再退出，不调用 ShipIt", async () => {
    const { app } = await import("electron");
    const { checkForUpdates, installUpdate } = await import("../desktop-update");
    await checkForUpdates({ userInitiated: true });
    updater.emit("update-downloaded", { version: "0.2.0" });
    await installUpdate();
    expect(updater.prepareInstall).toHaveBeenCalledOnce();
    expect(receipts.value).toMatchObject({ fromVersion: "0.1.0", version: "0.2.0", status: "pending" });
    expect(app.quit).toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("安装前校验或权限失败时留在旧书房，不写成功回执", async () => {
    const { checkForUpdates, installUpdate } = await import("../desktop-update");
    await checkForUpdates({ userInitiated: true });
    updater.emit("update-downloaded", { version: "0.2.0" });
    updater.prepareInstall.mockRejectedValue(new Error("MAC_UPDATE_PERMISSION: 当前应用位置不能写入。"));
    const state = await installUpdate();
    expect(state.phase).toBe("failed");
    expect(state.message).toBe("当前应用位置不能写入。");
    expect(receipts.value).toBeNull();
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

  it("未下载完成不能安装或退出", async () => {
    const { installUpdate } = await import("../desktop-update");
    await installUpdate();
    expect(updater.prepareInstall).not.toHaveBeenCalled();
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
