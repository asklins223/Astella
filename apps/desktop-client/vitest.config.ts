import { defineConfig } from 'vitest/config'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sharedAlias } from './shared-alias.ts'

// 配置自己所在的目录（不要再套一层 dirname——那会退到 apps/，node_modules 就找不到了）
const here = realpathSync(fileURLToPath(new URL('.', import.meta.url)))

/**
 * 返回"y-prosemirror 实际链接到的那份 prosemirror-model"的入口文件。
 * 解析不出来就抛：这段 alias 一旦静默失效，note-doc-editor-binding 会退回
 * RangeError 红，而配置本身看起来毫无异常——兜底必须喊。
 *
 * ## 判据是「**几个不同的 realpath**」，不是「几个目录」
 *
 * pnpm 的目录名带一串 peer 解析哈希，所以**同一组依赖可能有多个目录名**。
 * 2026-09-30 把 `prosemirror-model` 补成直接依赖（之前它只是 `y-prosemirror`
 * 的 peer 被顺带装上的）之后，`.pnpm/` 下就出现了**两个 `y-prosemirror@…` 目录名**——
 * 但它们 `node_modules/prosemirror-model` 的 realpath **是同一个**。
 *
 * 旧写法按「目录数必须等于 1」判断，于是**配置自己把测试拦死在门口**：
 * `Error: y-prosemirror 目录数=2`。而它自己上面那段注释写的才是真问题——
 * 「**两个不同 realpath 的实例**」。
 *
 * **所以要判的是 realpath 的去重个数**。多个目录名、同一实例 = 正常；
 * 多个目录名、多个实例 = 真的要抛。
 */
function prosemirrorResolve() {
  const pnpmDir = join(here, 'node_modules', '.pnpm')
  const yDirs = readdirSync(pnpmDir).filter((d) => d.startsWith('y-prosemirror@'))
  if (yDirs.length === 0) throw new Error('[vitest.config] .pnpm 下没有 y-prosemirror@*，无法注入 prosemirror-model alias')
  // 多个目录名可能指向**同一份**实例——按 realpath 去重，别按目录数判
  const instances = new Map<string, string>()
  for (const d of yDirs) {
    const real = realpathSync(join(pnpmDir, d, 'node_modules', 'prosemirror-model'))
    instances.set(real, d)
  }
  if (instances.size !== 1) {
    throw new Error(
      `[vitest.config] y-prosemirror 指向了 ${instances.size} 份不同的 prosemirror-model：\n`
        + [...instances].map(([real, from]) => `  ${from}\n    → ${real}`).join('\n')
        + '\n它们是两份不同的实例，会让编辑器拿到两套 Schema——必须先让它们合并成一份。',
    )
  }
  // 2026-09-30：`prosemirror-model` 补成了**直接依赖**，而 `node_modules/prosemirror-model`
  // 现在是**指向 `.pnpm/` 那一份的软链**——也就是说当初「顶层是混装留下的真实目录」
  // 这个问题**已经不存在了**。
  //
  // 此时**再注入 alias 反而制造第二个实例**：alias 指向 `pkg.module`（ESM 入口），
  // 而外部化消费者的 `require` 走的是 CJS 入口，两边各加载一份 → 又回到
  // `RangeError: multiple versions of prosemirror-model were loaded`。
  //
  // **所以只有真的存在多个实例时才注入 alias**；只有一个实例就让解析器按它自己的规则走。
  const topLevel = realpathSync(join(here, 'node_modules', 'prosemirror-model'))
  if (instances.size === 1 && topLevel === [...instances.keys()][0]) return null
  const pkgDir = [...instances.keys()][0]
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const entry = pkg.module ?? pkg.main
  if (!entry) throw new Error(`[vitest.config] ${pkgDir} 的 package.json 没有 module/main，无法注入 prosemirror-model alias`)
  return { find: 'prosemirror-model', replacement: resolve(pkgDir, entry) }
}

/**
 * 桌面端测试配置。
 *
 * 此前没有这份配置，因此跑的是 vitest 默认值（`testTimeout: 5000`）。默认值对这套
 * 用例偏紧：它包含大量 jsdom + 模块图较重的用例（渲染整个 surface、驱动拖拽手势），
 * 而默认跑法是**并行多 worker**——并行度一高，这些用例就会随机撞到 5 秒上限。
 *
 * 症状是**同一个测试在单跑时通过、在全量并行时超时**：本地全量跑实测出现
 * `Test timed out in 5000ms`，而把同一批文件单独跑（`—no-file-parallelism`
 * 或只跑那几个文件）全部通过。这种"随机的红"会让人误以为改动破坏了东西——
 * 本轮回归就为此多花了几轮排查时间。
 *
 * 这里把超时放宽到 15s：**它不隐藏逻辑失败**——真正卡死的用例照样会失败，只是晚 10 秒；
 * 它消除的只是"机器忙不过来"这类与代码无关的红灯。除此之外只有 `resolve.alias`
 * 是显式加进去的两条（见下面），测试环境本身仍由各文件顶部的
 * `@vitest-environment` 声明。
 */
export default defineConfig({
  /**
   * `prosemirror-model` 在这台机器上有**两个不同 realpath 的实例**：
   * `node_modules/prosemirror-model` 是 npm/pnpm 混装留下的顶层真实目录，而
   * `y-prosemirror`（以及 @milkdown）链接到
   * `node_modules/.pnpm/prosemirror-model@<ver>/node_modules/prosemirror-model`。
   * 测试自己 `import { Schema } from "prosemirror-model"` 走前者，编辑器内部走后者，
   * 于是 `note-doc-editor-binding.test.tsx` 稳定红在
   * `RangeError: Can not convert <paragraph(…)> to a Fragment
   *  (looks like multiple versions of prosemirror-model were loaded)`。
   *
   * 为什么不是 `resolve.dedupe` / `server.deps.inline`：两者都实测无效。vitest 对
   * node_modules 走 SSR 外部化，`y-prosemirror` 的 require 根本不经过 vite 的解析层，
   * 所以 dedupe 只会把**测试这一侧**也拉到顶层那份，两边依旧不同实例。
   * 正解是让测试用**外部化消费者实际拿到的那一份**。
   *
   * ⚠️ **2026-09-30 更新**：当初的病根是「顶层是混装留下的真实目录」。
   * `prosemirror-model` 补成直接依赖 + 重装之后，顶层已经是**指向 `.pnpm/` 的软链**，
   * 两个 realpath 变成同一个——**这个 alias 从「正解」降级成「兜底」**：
   * 只有真的存在多个实例时才注入，否则**不注入**（注入反而会制造第二个实例）。
   *
   * 路径不写死版本号：直接读 y-prosemirror 自己链接到的那个符号链接并解析成 realpath，
   * 升级 prosemirror-model 后它自然跟着走；解析不出来就不注入 alias（宁可让测试红，
   * 也不要静默指向一份错的文件）。
   */
  resolve: {
    /**
     * `sharedAlias` 不是可选项：pnpm 对 `file:` 依赖是**安装期快照**，被编辑过的
     * `packages/shared` 文件在 `node_modules` 里留的是编辑前那一份（没编辑过的才是硬链接）。
     * 不指别名，桌面这套用例就在测一份和 `typecheck`（tsconfig paths → 源码）不是同一
     * 个文件的合同——两边可以同时绿，而绿的不是同一件事。
     */
    // `prosemirrorResolve()` **可能返回 null**（只有一个实例时不需要 alias）——要滤掉。
    alias: [prosemirrorResolve(), ...sharedAlias].filter(Boolean),
  },

  test: {
    testTimeout: 15_000,
    hookTimeout: 15_000,
    /**
     * `waitFor` 的等待上限由 Testing Library 自己管（默认 1000ms），**不受**
     * `testTimeout` 影响——只调 vitest 超时，仍然会在机器忙时撞到它。
     * 这里通过 setup 文件统一放宽，覆盖的仍是"轮询等待"这类与代码无关的红灯。
     */
    setupFiles: ['./vitest.setup.ts'],
  },
})
