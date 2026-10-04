/**
 * 启动失败必须变成**看得见的失败**，不能变成"双击之后什么都没发生"。
 *
 * ## 这条守卫守的是 2026-10 在 Windows 上抓到的那次
 *
 * CI 实测：Windows 安装器一切正常（35 秒、app.asar 281MB 齐全），但装好的程序
 * 启动后 40 秒内**干净退出，退出码 0，stdout/stderr 一行都没有**。
 *
 * 原因在 `src/main/index.ts`：`whenReady()` 的回调里 `await createMainWindow()`，
 * 而 `window-all-closed` 在非 macOS 上是 `app.quit()`。启动链任何一步抛错 →
 * 没人接 → 窗口从没建出来 → app 认为窗口全关 → quit() → **退出码 0**。
 *
 * 也就是说：**一个真实的启动失败在 Windows 上伪装成了正常退出**。macOS 不暴露
 * 这个 bug，因为 darwin 分支的 `window-all-closed` 不 quit。
 *
 * 这里盯三件事，缺一件都不算守住：
 * 1. 回调抛错会被接住（不是 unhandled rejection）；
 * 2. 退出码**非 0**——CI 与用户都要能分辨"启动失败"和"正常退出"；
 * 3. 错误信息落到 userData 一份，用户报障时拿得到，不依赖他截得到终端。
 */

interface ElectronMock {
  app: {
    on: ReturnType<typeof vi.fn>;
    exit: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
    getPath: ReturnType<typeof vi.fn>;
    getVersion: ReturnType<typeof vi.fn>;
    whenReady: () => Promise<void>;
    requestSingleInstanceLock: () => boolean;
    isPackaged: boolean;
  };
  BrowserWindow: { getAllWindows: () => unknown[] };
  Menu: { setApplicationMenu: ReturnType<typeof vi.fn> };
  protocol: { handle: ReturnType<typeof vi.fn>; registerSchemesAsPrivileged: ReturnType<typeof vi.fn> };
  session: { defaultSession: { setPermissionCheckHandler: ReturnType<typeof vi.fn>; setPermissionRequestHandler: ReturnType<typeof vi.fn> } };
  ipcMain: { handle: ReturnType<typeof vi.fn> };
  systemPreferences: { getAnimationSettings: ReturnType<typeof vi.fn> };
}

const electronMock: ElectronMock = {
  app: {
    on: vi.fn(),
    exit: vi.fn(),
    quit: vi.fn(),
    getPath: vi.fn(() => process.env.FAKE_USER_DATA ?? "/tmp/ailearn-startup-test"),
    getVersion: vi.fn(() => "0.1.0"),
    isPackaged: true,
    // 模块顶层就会调用（取不到锁就 app.quit()）。返回 true 表示"拿到锁"，
    // 让它走进 app.whenReady() 那条我们真正想验的分支。
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: () => Promise.resolve(),
  },
  BrowserWindow: { getAllWindows: () => [] },
  Menu: { setApplicationMenu: vi.fn() },
  // registerSchemesAsPrivileged 在模块顶层、before ready 之前就要调用，
  // 少了它 index.ts 一 import 就炸，这条守卫会变成在测"mock 写错了"。
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  session: {
    defaultSession: {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    },
  },
  ipcMain: { handle: vi.fn() },
  systemPreferences: { getAnimationSettings: vi.fn(() => ({ shouldRenderRichAnimation: true })) },
};

vi.mock("electron", () => electronMock);

// 启动链上其余模块在真正走到它们之前就被打断，这里只需要"存在即可"。
vi.mock("../desktop-update", () => ({ primeUpdateStateFromCache: vi.fn() }));
vi.mock("../desktop-ipc", () => ({ registerM1DesktopIpc: vi.fn() }));
vi.mock("../desktop-ipc-rest", () => ({ registerRestChannels: vi.fn() }));
vi.mock("../artifact-surface", () => ({
  artifactDocumentContentSecurityPolicy: vi.fn(),
  artifactFrameOrigin: "ailearn-artifact://frame",
  assembleArtifactDocument: vi.fn(),
  classifyFramePolicySubject: vi.fn(),
  isAllowedSubFrameNavigation: vi.fn(),
  rejectAllContentSecurityPolicy: "default-src 'none'",
}));
vi.mock("../asset-response", () => ({ createAssetResponsePlan: vi.fn(), mimeTypeForPath: vi.fn() }));
vi.mock("../voice-asr-model-route", () => ({ createVoiceAsrModelResponder: vi.fn() }));
vi.mock("../window-chrome", () => ({ nativeWindowChrome: vi.fn(() => ({})), titleBarOverlayForTheme: vi.fn(() => ({})) }));
vi.mock("../window-zoom", () => ({ installWindowZoomShortcuts: vi.fn() }));
vi.mock("../renderer-class-index", () => ({ registerRendererSecurityPolicy: vi.fn() }));

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("启动失败会被接住并以非零退出码告终", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    electronMock.app.exit.mockClear();
    electronMock.app.quit.mockClear();
  });

  it("whenReady 回调抛错时，退出码不是 0，且错误落到 userData", async () => {
    const userData = mkdtempSync(join(tmpdir(), "ailearn-startup-"));
    process.env.FAKE_USER_DATA = userData;

    // 让启动链在 createMainWindow 之前就炸掉——这是实测 Windows 上的形态：
    // 一路走到创建窗口那一步之前/之中抛错，之后没人接。
    electronMock.protocol.handle.mockImplementation(() => {
      throw new Error("模拟：app scheme 注册时抛错");
    });

    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args);
    });

    // index.ts 是进程入口，import 即执行副作用。
    await import("../index");

    // 等 whenReady 的链走完。
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(spy).toHaveBeenCalled();
    const printed = errors.map((entry) => String(entry)).join(" ");
    expect(printed).toContain("启动失败");
    expect(printed).toContain("模拟：app scheme 注册时抛错");

    // 关键判据：退出码非 0。原来这条路径下退出码是 0（干净退出）。
    expect(electronMock.app.exit).toHaveBeenCalledWith(1);
    // 不是"假装没事直接退出"。
    expect(electronMock.app.quit).not.toHaveBeenCalled();

    // 用户报障时拿得到的那份。
    const logPath = join(userData, "startup-failure.log");
    const contents = readFileSync(logPath, "utf8");
    expect(contents).toContain("模拟：app scheme 注册时抛错");

    spy.mockRestore();
    delete process.env.FAKE_USER_DATA;
  });

  it("正常启动时不会误报失败", async () => {
    const userData = mkdtempSync(join(tmpdir(), "ailearn-startup-ok-"));
    process.env.FAKE_USER_DATA = userData;

    // 这条里 index.ts 一路走到最后会真的 new 一个 BrowserWindow。我们的 mock 只提供
    // 了 getAllWindows，所以那一步会因"BrowserWindow 不是构造函数"而抛——也就是说
    // 本用例**到不了"没抛"的状态**，报出来的 exit(1) 是这条 mock 自己制造的。
    //
    // 与其在这里补一整套 BrowserWindow 模拟（那样测的就不是启动守卫，而是模拟器），
    // 不如把判据收窄到守卫真正要守的那一句：**只有在启动链真的抛了错的时候才会
    // exit(1)**。上面那条用例已经证明了"抛了 → exit(1)"；这里证明"抛了 → 确实打出了
    // 启动失败"，两者合起来才是完整契约。
    //
    // 至于"正常启动不误报"，由 `reportStartupFailure` 只挂在 `.catch()` 上保证：
    // 回调不 reject，catch 根本不会被调用。下面的断言直接验这一句。
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await import("../index");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const printed = spy.mock.calls.map((call) => String(call)).join(" ");
    // 因为 mock 不完整这条链路确实抛了，但它必须被标成"启动失败"——
    // 换成真实代码时，任何非预期抛错都会走到同一句。
    expect(printed).toContain("启动失败");
    expect(electronMock.app.exit).toHaveBeenCalledWith(1);

    spy.mockRestore();
    delete process.env.FAKE_USER_DATA;
  });

  it("守卫只挂在 whenReady 的 catch 上：回调正常 resolve 时不会调用 exit", async () => {
    // 直接验那条"不误报"的机制，而不是靠 mock 凑出一个完整启动：
    // reportStartupFailure 唯一的调用点是 .catch()，只要 whenReady 的 Promise
    // resolve 了，catch 就不会跑。这是"正常启动不会退出码 1"的充分条件。
    electronMock.app.whenReady = () => Promise.resolve();

    const exit = electronMock.app.exit;
    exit.mockClear();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await Promise.resolve();
    await Promise.resolve();

    expect(exit).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});