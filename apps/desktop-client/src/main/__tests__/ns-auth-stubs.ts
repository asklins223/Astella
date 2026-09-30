/**
 * 2026-09-30：命名空间方法变自由函数之后，测试的桩必须挂在**模块**上。
 *
 * 背景：`desktop-ipc.ts` 现在是 `ns_auth.getSession(gateway.gatewayTransport, …)`——
 * **静态引用那个模块**。所以在网关实例上挂 `getSession: vi.fn()` **不再被调用**：
 * 桩挂在实例上，调用点走的是模块。**桩要挂在调用真正经过的地方。**
 *
 * ## 为什么 registry 挂在 `globalThis` 上（而不是模块变量）
 *
 * `vi.mock` 的工厂里 `await import("./ns-auth-stubs")` 与测试文件顶层的
 * `import … from "./ns-auth-stubs"` **拿到的是两个模块实例**——vitest 的 hoisting
 * 让工厂先跑，两次 import 的求值顺序不保证一致，于是模块级 `registry` 变量
 * **在工厂那份里始终是空的**。
 * 实测症状：`authGetState` 返回 `safe_internal_error`，而桩明明登记了。
 *
 * 挂到 `globalThis` 上，**两份实例共用同一张表**，问题消失。
 * 代价是这个键会留在全局——测试进程是短命的，可以接受；真要严谨可以在
 * `afterEach` 里清空（本仓的 `afterEach` 本来就要清 userDataDir）。
 */
import { vi } from "vitest";

/** auth 命名空间搬成自由函数的方法。搬一个加一个——这里就是那张清单。 */
export const NS_AUTH_METHODS = [
  "getSession",
  "getProfile",
  "getAvatar",
  "uploadAvatar",
  "updateProfile",
  "getAuthSurfaceManifest",
  "joinWorkspace",
  "leaveWorkspace",
] as const;

export type NsAuthMethod = (typeof NS_AUTH_METHODS)[number];

type Stub = ReturnType<typeof vi.fn<(...args: never[]) => unknown>>;

const KEY = "__nsAuthStubRegistry__";

type Registry = Partial<Record<NsAuthMethod, Stub>>;

function registry(): Registry {
  const g = globalThis as unknown as Record<string, Registry | undefined>;
  if (!g[KEY]) g[KEY] = {};
  return g[KEY]!;
}

/** 把用例建好的 `vi.fn()` 登记到模块 mock 上。 */
export function registerAuthStub(name: NsAuthMethod, stub: Stub): Stub {
  registry()[name] = stub;
  return stub;
}

/** 取回已登记的桩（用例做断言用：`authStub("getSession").mock.calls`）。 */
export function authStub(name: NsAuthMethod): Stub {
  const stub = registry()[name];
  if (!stub) {
    throw new Error(
      `auth 命名空间的「${name}」没有登记桩。\n` +
        `自由函数是静态引用模块的，在网关实例上挂同名方法不会被调用——\n` +
        `在网关对象那里写 registerAuthStub("${name}", ${name});（见本文件头）。`,
    );
  }
  return stub;
}

/** `vi.mock("../desktop-gateway-ns-auth", () => authModuleMock())` 里那个工厂。 */
export function authModuleMock(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of NS_AUTH_METHODS) {
    out[name] = (...args: never[]) => registry()[name]?.(...args);
  }
  return out;
}
