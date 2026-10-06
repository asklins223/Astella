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
} from "@astella/shared/desktop-ipc-contracts";
import { type DesktopGateway } from "../desktop-gateway";
import { registerAuthStub } from "./ns-auth-stubs";
import * as ns_auth from "../desktop-gateway-ns-auth";

vi.mock("../desktop-gateway-ns-auth", async () => {
  const { authModuleMock } = await import("./ns-auth-stubs");
  return authModuleMock();
});

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

/**
 * 2026-09-30：`getNoteLearningRoundArtifactHtml` / `getNoteLearningArtifactHtml` 已从
 * `DesktopGateway` 的方法变成**自由函数**（`desktop-gateway-ns-artifact.ts`），
 * 而 `desktop-ipc.ts` 现在是
 * `ns_artifact.getNoteLearningRoundArtifactHtml(gateway.gatewayTransport, …)`——
 * **静态引用那个模块**。
 *
 * 所以在网关实例上挂 `getNoteLearningRoundArtifactHtml` 桩**不再被调用**：
 * 桩挂在实例上，调用点走的是模块。正解是 `vi.mock` 那个模块——
 * **桩要挂在调用真正经过的地方**。
 *
 * 这一条对之后每一族命名空间都成立：**搬成自由函数之后，测试要 mock 模块，不能 mock 实例。**
 */
// 类型要带 `mock`：用例要断言调用参数与一次性的 reject。
// 2026-09-30 补：上一轮把它写成裸函数类型，于是 `.mock.calls` / `.mockRejectedValueOnce`
// 在 typecheck 里报「不存在」——**测试因此不能 typecheck 通过**，那等于没做。
/** 每个键是一个 `vi.fn()` 桩：既能调（转发用），也能断言（`.mock.calls` / `.mockRejectedValueOnce`）。 */
const artifactStubs: Record<string, ReturnType<typeof vi.fn<(...args: never[]) => unknown>>> = {};
vi.mock("../desktop-gateway-ns-artifact", () => ({
  getNoteLearningArtifactHtml: (...args: never[]) => artifactStubs.getNoteLearningArtifactHtml?.(...args),
  getNoteLearningRoundArtifactHtml: (...args: never[]) => artifactStubs.getNoteLearningRoundArtifactHtml?.(...args),
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
  userDataDir = await mkdtemp(join(tmpdir(), "astella-artifact-ipc-"));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

function stubGateway(overrides: Partial<DesktopGateway> = {}): DesktopGateway {
  return {
    getDeploymentConfig: () => undefined,
    getSession: registerAuthStub("getSession", vi.fn(async () => ({
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
    }))),
    ...overrides,
  } as unknown as DesktopGateway;
}

/** 每个用例换一份干净的模块实例（`registerM1DesktopIpc` 只准注册一次）。 */
async function register(gateway: DesktopGateway, injectUserDataDir = true) {
  vi.resetModules();
  const [{ registerM1DesktopIpc }, gatewayModule, failureModule] = await Promise.all([
    import("../desktop-ipc"),
    import("../desktop-gateway"),
    // 2026-09-30：失败类搬到了 `../desktop-gateway-failure`（它原先和网关类同文件，
    // 而每个方法抛的都是它）。**必须从这一份模块图里取**——`vi.resetModules()` 之后
    // 静态 import 的那个是另一份实例，拿它造的错误 `instanceof` 过不了 `mapFailure`，
    // 会假红成别的错误码。从旧模块取则更隐蔽：拿到 undefined，报「not a constructor」。
    import("../desktop-gateway-failure"),
  ]);
  registerM1DesktopIpc({
    gateway,
    env: { ASTELLA_DOMAIN_SCHEMA_REVISION: "domain-v2-test" },
    resolveWindow: () => ({} as never),
    getWindowState: () => ({ state: "visible", revision: 1 }),
    setTitlebarTheme: () => true,
    ...(injectUserDataDir ? { artifactUserDataDir: () => userDataDir } : {}),
  });
  const event = { sender: {}, senderFrame: { url: "astella://renderer/" } };
  // 先读一次状态把 activeWorkspaceEpoch 立起来（与通道覆盖那份同一口径）。
  const st = await electronMock.handlers.get(DESKTOP_IPC_CHANNELS.authGetState)!(event, { meta });
  return {
    event,
    ensure: electronMock.handlers.get(DESKTOP_IPC_CHANNELS.artifactEnsure)!,
    // 2026-09-30： 搬到了 `../desktop-gateway-failure`（它原先和
    // 网关类同文件，而每个方法抛的都是它）。从旧模块取会拿到 undefined，
    // 报错是「not a constructor」——离「类搬走了」隔了两层。
    freshGatewayFailure: failureModule.DesktopGatewayFailure,
  };
}

describe("artifact.ensure desktop IPC", () => {
  it("落盘并原样回报；第二发幂等，不再打网关", async () => {
    const artifactId = randomUUID();
    const html = "<html><body>动态讲解</body></html>";
    artifactStubs.getNoteLearningRoundArtifactHtml = vi.fn(async () => html);
    const gateway = stubGateway({ getNoteLearningRoundArtifactHtml: artifactStubs.getNoteLearningRoundArtifactHtml } as never);
    const { event, ensure } = await register(gateway);
    const scopedMeta = { ...meta, workspaceEpoch: 9 };

    const first = await ensure(event, { meta: scopedMeta, artifactId });
    // 跨桥只回"在不在盘上了"；字节数由 `artifact-store.test.ts` 在那一层断（界面不读它）。
    expect(first).toMatchObject({ ok: true, data: { stored: true } });
    // 自由函数的第一个参数是 `t: GatewayTransport`（2026-09-30 搬出），
    // 所以这里比的是**第二个参数往后**。
    expect(artifactStubs.getNoteLearningRoundArtifactHtml.mock.calls[0].slice(1))
      .toEqual([artifactId, meta.requestId]);
    expect(await readFile(resolve(userDataDir, "artifacts", `${artifactId}.html`), "utf8")).toBe(html);

    const second = await ensure(event, { meta: scopedMeta, artifactId });
    expect(second).toMatchObject({ ok: true, data: { stored: false } });
    // 幂等：盘上已有就一个字节都不该再取。
    expect(artifactStubs.getNoteLearningRoundArtifactHtml).toHaveBeenCalledTimes(1);
  });

  it("落盘失败与取件失败都带着 code 翻出去，不折成 stored:false", async () => {
    const artifactId = randomUUID();
    artifactStubs.getNoteLearningRoundArtifactHtml = vi.fn(async () => "<html>不该被取</html>");
    const gateway = stubGateway({ getNoteLearningRoundArtifactHtml: artifactStubs.getNoteLearningRoundArtifactHtml } as never);
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
    expect(artifactStubs.getNoteLearningRoundArtifactHtml).not.toHaveBeenCalled();

    // 取件失败（404）⇒ 网关自己的码原样上来。
    artifactStubs.getNoteLearningRoundArtifactHtml.mockRejectedValueOnce(new freshGatewayFailure("not_found", "never"));
    const fetchFailure = await ensure(event, { meta: scopedMeta, artifactId: randomUUID() });
    expect(fetchFailure).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("id 形状在本机就被挡住，网关一次都没被打", async () => {
    artifactStubs.getNoteLearningRoundArtifactHtml = vi.fn(async () => "<html>不该被取</html>");
    const gateway = stubGateway({ getNoteLearningRoundArtifactHtml: artifactStubs.getNoteLearningRoundArtifactHtml } as never);
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
    expect(artifactStubs.getNoteLearningRoundArtifactHtml).not.toHaveBeenCalled();
  });

  it("没注入产物目录 ⇒ configuration_error，不许静默不落盘", async () => {
    const gateway = stubGateway({ getNoteLearningRoundArtifactHtml: vi.fn() } as never);
    const { event, ensure } = await register(gateway, false);

    const result = await ensure(event, { meta: { ...meta, workspaceEpoch: 9 }, artifactId: randomUUID() });
    expect(result).toMatchObject({ ok: false, error: { code: "configuration_error" } });
  });
});
