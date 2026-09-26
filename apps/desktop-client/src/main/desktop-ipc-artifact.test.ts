/**
 * `artifact.ensure` 在 IPC 边界上的接线（39d W4-6 刀五）。
 *
 * 通道覆盖那份对账只保证"注册了"；这里要的是它在边界层真的做该做的事：
 *  - 把 id 与 `meta.requestId` 原样交给网关，并把真实落盘结果原样报回去；
 *  - 幂等那一发**不打网关**（盘上已有 = 不重复下载）；
 *  - 任何失败（落盘、取件）都带着 `code` 如实翻出去，不许折成 `stored:false`。
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_CONTRACT_VERSION,
  type GatewayResultV1,
  type RequestMetaV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import { type DesktopGateway } from "./desktop-gateway";

type InvokeHandler = (
  event: { readonly sender: unknown; readonly senderFrame?: { readonly url: string } },
  input: unknown,
) => Promise<GatewayResultV1<unknown>>;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, InvokeHandler>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler);
    }),
  };
});

vi.mock("electron", () => ({
  BrowserWindow: class BrowserWindow {},
  ipcMain: { handle: electronMock.handle, on: vi.fn() },
}));

const meta: RequestMetaV1 = {
  version: 1,
  contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
  requestId: "request-artifact-ensure-ipc",
  correlationId: "correlation-artifact-ensure-ipc",
  clientStartedAt: "2026-09-26T00:00:00.000Z",
};

let userDataDir: string;

beforeEach(async () => {
  electronMock.handlers.clear();
  electronMock.handle.mockClear();
  userDataDir = await mkdtemp(join(tmpdir(), "ailearn-artifact-ipc-"));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

function stubGateway(overrides: Partial<DesktopGateway> = {}): DesktopGateway {
  return {
    getDeploymentConfig: () => undefined,
    getSession: vi.fn(async () => ({
      version: 1,
      status: "authenticated",
      user: { userId: "11111111-1111-4111-8111-111111111111", email: "me@example.com" },
      workspace: {
        version: 1,
        workspaceId: "22222222-2222-4222-8222-222222222222",
        name: "空间",
        role: "owner",
        workspaceType: "personal",
        isPersonal: true,
        workspaceEpoch: 9,
      },
      membership: { role: "owner" },
      capabilities: null,
      workspaceEpoch: 9,
      credentialPersistence: "memory",
    })),
    ...overrides,
  } as unknown as DesktopGateway;
}

/** 每个用例换一份干净的模块实例（`registerM1DesktopIpc` 只准注册一次）。 */
async function register(gateway: DesktopGateway, injectUserDataDir = true) {
  vi.resetModules();
  const [{ registerM1DesktopIpc }, gatewayModule] = await Promise.all([
    import("./desktop-ipc"),
    // 顺带取回**这一份模块图里**的失败类：`vi.resetModules()` 之后静态 import 的那个
    // 是另一份实例，拿它造的错误 `instanceof` 过不了 `mapFailure`，会假红成别的码。
    import("./desktop-gateway"),
  ]);
  registerM1DesktopIpc({
    gateway,
    env: { AILEARN_DOMAIN_SCHEMA_REVISION: "domain-v2-test" },
    resolveWindow: () => ({} as never),
    getWindowState: () => ({ state: "visible", revision: 1 }),
    setTitlebarTheme: () => true,
    ...(injectUserDataDir ? { artifactUserDataDir: () => userDataDir } : {}),
  });
  const event = { sender: {}, senderFrame: { url: "ailearn://renderer/" } };
  // 先读一次状态把 activeWorkspaceEpoch 立起来（与通道覆盖那份同一口径）。
  await electronMock.handlers.get(DESKTOP_IPC_CHANNELS.authGetState)!(event, { meta });
  return {
    event,
    ensure: electronMock.handlers.get(DESKTOP_IPC_CHANNELS.artifactEnsure)!,
    freshGatewayFailure: gatewayModule.DesktopGatewayFailure,
  };
}

describe("artifact.ensure desktop IPC", () => {
  it("落盘并原样回报；第二发幂等，不再打网关", async () => {
    const artifactId = randomUUID();
    const html = "<html><body>动态讲解</body></html>";
    const getNoteLearningRoundArtifactHtml = vi.fn(async () => html);
    const gateway = stubGateway({ getNoteLearningRoundArtifactHtml } as never);
    const { event, ensure } = await register(gateway);
    const scopedMeta = { ...meta, workspaceEpoch: 9 };

    const first = await ensure(event, { meta: scopedMeta, artifactId });
    // 跨桥只回"在不在盘上了"；字节数由 `artifact-store.test.ts` 在那一层断（界面不读它）。
    expect(first).toMatchObject({ ok: true, data: { stored: true } });
    expect(getNoteLearningRoundArtifactHtml).toHaveBeenCalledWith(artifactId, meta.requestId);
    expect(await readFile(resolve(userDataDir, "artifacts", `${artifactId}.html`), "utf8")).toBe(html);

    const second = await ensure(event, { meta: scopedMeta, artifactId });
    expect(second).toMatchObject({ ok: true, data: { stored: false } });
    // 幂等：盘上已有就一个字节都不该再取。
    expect(getNoteLearningRoundArtifactHtml).toHaveBeenCalledTimes(1);
  });

  it("落盘失败与取件失败都带着 code 翻出去，不折成 stored:false", async () => {
    const artifactId = randomUUID();
    const getNoteLearningRoundArtifactHtml = vi.fn(async () => "<html>不该被取</html>");
    const gateway = stubGateway({ getNoteLearningRoundArtifactHtml } as never);
    const { event, ensure, freshGatewayFailure } = await register(gateway);
    const scopedMeta = { ...meta, workspaceEpoch: 9 };

    // 落点被目录占用 ⇒ 写盘那一类失败：`safe_internal_error`，且没去打网关。
    await mkdir(resolve(userDataDir, "artifacts", `${artifactId}.html`), { recursive: true });
    const writeFailure = await ensure(event, { meta: scopedMeta, artifactId });
    expect(writeFailure).toMatchObject({
      ok: false,
      error: { code: "safe_internal_error" },
      workspaceEpoch: 9,
    });
    expect(getNoteLearningRoundArtifactHtml).not.toHaveBeenCalled();

    // 取件失败（404）⇒ 网关自己的码原样上来。
    getNoteLearningRoundArtifactHtml.mockRejectedValueOnce(new freshGatewayFailure("not_found", "never"));
    const fetchFailure = await ensure(event, { meta: scopedMeta, artifactId: randomUUID() });
    expect(fetchFailure).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("id 形状在本机就被挡住，网关一次都没被打", async () => {
    const getNoteLearningRoundArtifactHtml = vi.fn(async () => "<html>不该被取</html>");
    const gateway = stubGateway({ getNoteLearningRoundArtifactHtml } as never);
    const { event, ensure } = await register(gateway);
    const scopedMeta = { ...meta, workspaceEpoch: 9 };

    for (const input of [
      { meta: scopedMeta, artifactId: "不是个 uuid" },
      { meta: scopedMeta, artifactId: randomUUID(), extra: "不该存在的字段" },
      { meta: scopedMeta },
    ]) {
      const rejected = await ensure(event, input as never);
      expect(rejected).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
    expect(getNoteLearningRoundArtifactHtml).not.toHaveBeenCalled();
  });

  it("没注入产物目录 ⇒ configuration_error，不许静默不落盘", async () => {
    const gateway = stubGateway({ getNoteLearningRoundArtifactHtml: vi.fn() } as never);
    const { event, ensure } = await register(gateway, false);

    const result = await ensure(event, { meta: { ...meta, workspaceEpoch: 9 }, artifactId: randomUUID() });
    expect(result).toMatchObject({ ok: false, error: { code: "configuration_error" } });
  });
});
