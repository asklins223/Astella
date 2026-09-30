/**
 * 2026-09-30：命名空间方法变自由函数之后，测试的桩必须挂在**模块**上。
 *
 * ## 为什么不写死转发清单
 *
 * 第一版是「`vi.mock` 的工厂里逐个转发 `name: (...args) => stubs.name?.(...args)`」。
 * 实测**它一定会过时**：`desktop-ipc.ts` 里 `ns_note.*` 有 **62 个**调用点，
 * 只要漏一个，vitest 就在运行时抛
 * `No "xxx" export is defined on the mock`——**而它被 `safe_internal_error` 吞掉**，
 * 症状是「断言说 data 是 null」，离真因隔了三层。
 *
 * ## 正解：`importOriginal()` 部分 mock
 *
 * 先拿到**真模块**，再只覆盖登记过的那些；没登记的原样透传。
 * **清单过时就不会出事**——新增方法不需要动任何 mock。
 *
 * 用法（每个测试文件里）：
 * ```ts
 * vi.mock("../desktop-gateway-ns-note", async (importOriginal) => {
 *   const real = await importOriginal<typeof import("../desktop-gateway-ns-note")>();
 *   return noteModuleMock(real);
 * });
 * // 用例里：noteStub("syncNoteDocUpdate", vi.fn(...))
 * ```
 *
 * registry 挂在 `globalThis` 上：`vi.mock` 工厂与测试文件顶层的 `import` 是
 * **两个模块实例**（vitest 的 hoisting 让工厂先跑），模块级变量在工厂那份里
 * 始终是空的。**实测症状是「桩登记了却没被调用」**。
 */
import { vi } from "vitest";

/** 桩的形状：只要「可调用」就行。
 * 不用 `(...args: never[]) => unknown`——`vi.fn()` 的类型带**可构造签名**，
 * 赋给纯函数类型会被 TS 判为不可赋值（实测卡在 `watchNoteDocument` 那个双重断言的桩上）。
 * 这里收 `unknown` 再原样返回，**不改变运行时行为**。
 */
type AnyFn = unknown;

const KEY = "__nsNoteStubRegistry__";
const registry: Record<string, AnyFn> = ((globalThis as unknown as Record<string, Record<string, AnyFn> | undefined>)[KEY] ??=
  {}) as Record<string, AnyFn>;

/** 登记一个桩。**用例里用它替掉原来的 `vi.fn()` 定义。 */
export function noteStub(name: string, impl: AnyFn): AnyFn {
  registry[name] = impl;
  return impl;
}

/** 取回已登记的桩（用例做断言用：`noteStubOf("x").mock.calls`）。 */
export function noteStubOf(name: string): ReturnType<typeof vi.fn> {
  const stub = registry[name];
  if (!stub) {
    throw new Error(
      `笔记命名空间的「${name}」没有登记桩。\n` +
        `自由函数是静态引用模块的，在网关实例上挂同名方法不会被调用——\n` +
        `改用 noteStub("${name}", vi.fn(…)) 登记，见本文件头。`,
    );
  }
  return stub as ReturnType<typeof vi.fn>;
}

/** 只覆盖已登记的，其余走真实现——**清单不会过时**。 */
export function noteModuleMock<T extends Record<string, unknown>>(real: T): T {
  return new Proxy(real, {
    get(target, prop: string) {
      return prop in registry ? registry[prop] : target[prop];
    },
    has(target, prop: string) {
      return prop in registry || prop in target;
    },
  }) as T;
}

/**
 * 把本机正文的存储接缝换成假实现。
 *
 * **为什么需要它**：`uploadNoteDocUpdate` 既是 IPC 入口、又是 note 模块**内部**被调的接缝
 * （`settleNoteDocUpdate` / `flushNoteDocPending` 内部会调它）。模块内部是直接按函数名调用，
 * `vi.mock` 拦不住——**桩登记了，模块内部那一步走的还是真实现**，真持久化跑起来会抛
 * `note_doc_update_unmerged`。
 *
 * 正解是模块自己暴露的依赖对象 `setNoteDocDeps`（和 `desktop-gateway.ts` 的 `options`
 * 同一形状：把外部资源作为可替换的依赖传进来，而不是藏在模块内部）。
 * **生产代码里它是默认实现，没有任何测试专用分支。**
 */
export async function installNoteDocDeps(
  real: typeof import("../desktop-gateway-ns-note"),
  overrides: Record<string, unknown>,
): Promise<void> {
  real.setNoteDocDeps(overrides as never);
  const { registerAuthStub } = await import("./ns-auth-stubs");
  void registerAuthStub;
}

/** 恢复默认实现。 */
export async function resetNoteDocDeps(
  real: typeof import("../desktop-gateway-ns-note"),
): Promise<void> {
  real.resetNoteDocDeps();
}
