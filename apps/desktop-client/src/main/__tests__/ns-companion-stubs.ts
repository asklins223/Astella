/**
 * 伴星这一族（`desktop-gateway-ns-companion.ts`）的测试桩。
 *
 * ## 为什么是「部分 mock」而不是枚举式工厂
 *
 * 这个模块有 **52 个导出**。枚举式工厂（`vi.mock(path, async () => ({ a, b, c }))`）
 * 只在清单里写出来的那几个存在——**其余一律在运行时抛**
 * `No "xxx" export is defined on the mock`，而那个异常会被 `desktop-ipc.ts` 的
 * `mapFailure` **吞成 `safe_internal_error`**。
 *
 * 症状于是变成「`ok: false`，而且桩一次都没被调用」——
 * **离真因隔了三层**：不是通道的问题、不是参数的问题、不是 stub 没登记的问题，
 * 是**清单少了一条**。
 *
 * `importOriginal()` 部分 mock 只覆盖登记过的那些，其余走真实现：
 * **清单不会过时**——新增方法不需要动任何 mock。
 *
 * 用法：
 * ```ts
 * vi.mock("../desktop-gateway-ns-companion", async (importOriginal) => {
 *   const real = await importOriginal<typeof import("../desktop-gateway-ns-companion")>();
 *   const { companionModuleMock } = await import("./ns-companion-stubs");
 *   return companionModuleMock(real);
 * });
 * // 用例里：companionStub("listCompanionMemories", vi.fn(async () => …))
 * ```
 */
import { vi } from "vitest";

type AnyFn = (...args: never[]) => unknown;

const KEY = "__nsCompanionStubRegistry__";
const registry: Record<string, AnyFn> = ((globalThis as unknown as Record<string, Record<string, AnyFn> | undefined>)[KEY] ??=
  {}) as Record<string, AnyFn>;

/** 登记一个桩。 */
export function companionStub(name: string, impl: AnyFn): AnyFn {
  registry[name] = impl;
  return impl;
}

/** 取回已登记的桩（用例做断言用：`companionStubOf("x").mock.calls`）。 */
export function companionStubOf(name: string): ReturnType<typeof vi.fn> {
  const stub = registry[name];
  if (!stub) {
    throw new Error(
      `伴星命名空间的「${name}」没有登记桩。\n` +
        `自由函数是静态引用模块的，网关实例上的桩不会被调用——\n` +
        `改用 companionStub("${name}", vi.fn(…))，见本文件头。`,
    );
  }
  return stub as ReturnType<typeof vi.fn>;
}

/**
 * 只覆盖已登记的，其余走真实现——**清单不会过时**。
 *
 * `own` 可以传测试文件**自己的**那个 registry 对象
 * （很多老测试已经有一个 `const companionStubs = {}` 了，不必为了换 mock 去重写它）。
 * 不传就用本文件的全局 registry。
 */
export function companionModuleMock<T extends Record<string, unknown>>(
  real: T,
  own?: Record<string, unknown>,
): T {
  const table = own ?? (registry as Record<string, unknown>);
  return new Proxy(real, {
    get(target, prop: string) {
      return prop in table ? table[prop] : target[prop];
    },
    has(target, prop: string) {
      return prop in table || prop in target;
    },
  }) as T;
}
