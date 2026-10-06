import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharedPackage from '../../packages/shared/package.json'

/**
 * `@astella/shared` 的实时源码别名（2026-09-21 建立；2026-09-30 改为按 exports 逐条生成）。
 * 三处共用：`electron.vite.config.ts` 的 main/preload/renderer，以及 `vitest.config.ts`。
 *
 * 为什么必须有这一份：pnpm 对 `file:` 依赖是**安装期快照**。没被改过的文件是硬链接，
 * 内容跟着 `packages/shared` 走；一旦某个契约文件被编辑过，编辑器写的是新 inode，
 * 快照里留下的就是编辑**之前**的那一份——于是"改了合同，测试还是绿的"。
 * 类型侧那一半在 tsconfig.web/node.json 的 paths 里指向源码，所以 `typecheck` 读源码、
 * `vitest` 读快照，两边可以同时"对"而互相不是同一份代码。
 *
 * 路径按本文件自己的位置算，不按 cwd：配置文件被谁加载、cwd 在哪，不该决定解析结果。
 */
const here = realpathSync(fileURLToPath(new URL('.', import.meta.url)))
const pkgDir = resolve(here, '../../packages/shared')
const sharedSrc = resolve(pkgDir, 'src')

/** exports 的值有两种形态：字符串，或 `{ types, import, default }` 条件导出对象。 */
function targetFile(entry: unknown): string | null {
  const pick = (v: unknown): string | null => {
    if (typeof v === 'string') return v
    if (v && typeof v === 'object' && 'import' in v) {
      return ((v as { import?: unknown }).import as string | undefined) ?? null
    }
    return null
  }
  const t = pick(entry)
  if (!t || !t.startsWith('./src/')) return null
  return resolve(pkgDir, t.slice(2))
}

/**
 * 逐条按 exports 生成**精确**别名，不用通配。
 *
 * ## 为什么原来那条通配不行
 *
 * 旧写法是 `@astella/shared/*` → `src/*.ts`，本文件旧注释也写着「子路径全是
 * `src/*.ts` 平铺文件」。2026-09-30 把 46 份合同搬进 `src/contracts/` 之后，
 * 那条假设就不成立了——而它**静默失效**：`src/learning-run-v2-contracts.ts`
 * 已不存在，vite 报出来的是 `Cannot find package`，看不出"别名还指着旧位置"。
 *
 * ## 为什么也不能「先列 contracts/ 再列平铺」
 *
 * vite 的 alias 数组是**首个匹配即采用**，替换后的文件不存在就直接解析失败，
 * 不会「再试下一条」。两条都列出来兜不住底。
 *
 * ## 于是改成查表
 *
 * 直接读 `packages/shared/package.json` 的 `exports`，为每一条生成精确匹配别名：
 *
 * 1. 搬文件 / 改 target **不用动这个文件**——它跟着 exports 走；
 * 2. exports 指向的文件若不存在，这里**加载即抛**，而不是等到某一个测试文件收集失败；
 * 3. 与 B5「零通配符」那条硬约束同向——别名也是逐条的。
 */
// 静态导入让开发配置追踪 exports 的变化，新增能力不再落回安装期快照。
const pkg = sharedPackage as {
  exports?: Record<string, unknown>
}

const exact: Array<{ find: RegExp; replacement: string }> = [
  { find: /^@astella\/shared$/, replacement: resolve(sharedSrc, 'index.ts') },
]

const missing: string[] = []
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  if (key === '.' || !key.startsWith('./')) continue
  const file = targetFile(value)
  if (!file) continue
  if (!existsSync(file)) {
    missing.push(`${key} → ${file}`)
    continue
  }
  const subpath = escapeRe(key.slice(2)) // 去掉 './'；子路径里可能带 '/'
  exact.push({ find: new RegExp(`^@astella/shared/${subpath}$`), replacement: file })
}

// 宁可让配置加载即失败：一条静默失效的别名，症状是"测试绿着而合同已经变了"。
if (missing.length > 0) {
  throw new Error(
    `[shared-alias] packages/shared 的 exports 指向了不存在的文件：\n  ${missing.join('\n  ')}\n`
    + '这条别名是「typecheck 读源码、vitest 也读源码」的那一半；它静默失效的症状是'
    + '测试绿着而合同已经变了。',
  )
}

export const sharedAlias = exact
