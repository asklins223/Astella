import { beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_IPC_CHANNELS, DESKTOP_IPC_CONTRACT_VERSION } from "@astella/shared/desktop-ipc-contracts";
import type { DesktopGateway } from "../desktop-gateway";

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => Promise<unknown>>(),
  writeText: vi.fn(),
  readText: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: class {},
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => electronMock.handlers.set(channel, handler),
    on: vi.fn(),
  },
  clipboard: { writeText: electronMock.writeText, readText: electronMock.readText },
}));

const meta = {
  version: 1,
  contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
  requestId: "clipboard-test-request",
  correlationId: "clipboard-test-correlation",
  clientStartedAt: "2026-10-02T00:00:00.000Z",
};

async function register(trusted = true, readLinks = false) {
  vi.resetModules();
  const { registerM1DesktopIpc } = await import("../desktop-ipc");
  registerM1DesktopIpc({
    gateway: { getDeploymentConfig: () => undefined } as unknown as DesktopGateway,
    env: { ASTELLA_DOMAIN_SCHEMA_REVISION: "domain-v2-test" },
    resolveWindow: () => trusted ? ({} as never) : null,
    getWindowState: () => ({ state: "visible", revision: 1 }),
    setTitlebarTheme: () => true,
  });
  const handler = electronMock.handlers.get(readLinks ? DESKTOP_IPC_CHANNELS.clipboardReadLinks : DESKTOP_IPC_CHANNELS.clipboardWriteText);
  if (!handler) throw new Error("clipboard.writeText handler missing");
  return (request: unknown) => handler({ sender: {}, senderFrame: { url: "astella-app://bundle/index.html" } }, readLinks ? { meta } : { meta, request });
}

describe("系统剪贴板写入 IPC", () => {
  beforeEach(() => {
    electronMock.handlers.clear();
    electronMock.writeText.mockReset();
    electronMock.readText.mockReset();
  });

  it("本机复制无需 API 或登录，保留换行、中文和原文符号", async () => {
    const invoke = await register();
    const text = "引用的原文\n间隔重复把复习排在快忘还没忘的时刻。\n\n解释 **这句** 🐟";
    expect(await invoke({ text })).toMatchObject({ ok: true, data: { written: true } });
    expect(electronMock.writeText).toHaveBeenCalledExactlyOnceWith(text);
  });

  it("异常回执不冒充成功，空文、超限和未声明字段不能写入", async () => {
    const invoke = await register();
    for (const request of [{ text: "" }, { text: "x".repeat(1_000_001) }, { text: "原文", html: "<b>额外字段</b>" }]) {
      expect(await invoke(request)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
    expect(electronMock.writeText).not.toHaveBeenCalled();
    electronMock.writeText.mockImplementationOnce(() => { throw new Error("clipboard unavailable"); });
    expect(await invoke({ text: "原文" })).toMatchObject({ ok: false });
  });

  it("第三方 frame 无法通过主窗口来源检查", async () => {
    const invoke = await register(false);
    expect(await invoke({ text: "原文" })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(electronMock.writeText).not.toHaveBeenCalled();
  });

  it("Electron 44 的异步写入完成前不报告成功，拒绝也回传失败", async () => {
    const invoke = await register();
    let complete!: () => void;
    electronMock.writeText.mockReturnValueOnce(new Promise<void>(resolve => { complete = resolve; }));
    let settled = false;
    const result = invoke({ text: "等待系统完成复制" }).then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(electronMock.writeText).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    complete();
    expect(await result).toMatchObject({ ok: true, data: { written: true } });
    electronMock.writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    expect(await invoke({ text: "失败的复制" })).toMatchObject({ ok: false });
  });

  it("异步读取后只返回候选链接，并截断过长的剪贴板原文", async () => {
    const invoke = await register(true, true);
    electronMock.readText.mockResolvedValueOnce("https://example.com/page\n" + "x".repeat(4000) + " https://hidden.example.com");
    expect(await invoke(undefined)).toMatchObject({ ok: true, data: { urls: ["https://example.com/page"] } });
    electronMock.readText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    expect(await invoke(undefined)).toMatchObject({ ok: false });
  });
});
