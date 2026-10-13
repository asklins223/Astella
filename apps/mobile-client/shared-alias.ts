import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharedPackage from '../../packages/shared/package.json'

/**
 * `@astella/shared` 的实时源码别名，手机端这一份与桌面端 `apps/desktop-client/shared-alias.ts`
 * 同源同规则：**判据只有一处**，就是 `packages/shared/package.json` 的 `exports`。
 *
 * 为什么不能走 `node_modules/@astella/shared`：pnpm 对 `file:` 依赖是**安装期快照**，
 * 被编辑过的契约文件会留下编辑之前的那一份 inode。「改了合同而手机端还是绿的」就是
 * 这条静默失效的症状，所以别名逐条查表生成，并在目标文件缺失时**加载即抛**。
 */
const here = realpathSync(fileURLToPath(new URL('.', import.meta.url)))
const pkgDir = resolve(here, '../../packages/shared')

function targetFile(value: unknown): string | null {
  const pick = (entry: unknown): string | null =>
    typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object' && 'import' in entry
        ? ((entry as { import?: unknown }).import as string | undefined) ?? null
        : null
  const target = pick(value)
  return target?.startsWith('./src/') ? resolve(pkgDir, target.slice(2)) : null
}

const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const exact: Array<{ find: RegExp; replacement: string }> = [
  { find: /^@astella\/shared$/, replacement: resolve(pkgDir, 'src/index.ts') },
]
const missing: string[] = []

for (const [key, value] of Object.entries((sharedPackage as { exports?: Record<string, unknown> }).exports ?? {})) {
  if (key === '.' || !key.startsWith('./')) continue
  const file = targetFile(value)
  if (!file) continue
  if (!existsSync(file)) {
    missing.push(`${key} → ${file}`)
    continue
  }
  exact.push({ find: new RegExp(`^@astella/shared/${escapeRe(key.slice(2))}$`), replacement: file })
}

if (missing.length > 0) {
  throw new Error(
    `[mobile shared-alias] packages/shared 的 exports 指向了不存在的文件：\n  ${missing.join('\n  ')}\n`
    + '别名静默失效的症状是手机端绿着而合同已经变了，所以这里选择加载即失败。',
  )
}

export const sharedAlias = exact
