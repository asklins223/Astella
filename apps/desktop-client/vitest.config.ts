import { defineConfig } from 'vitest/config'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sharedAlias } from './shared-alias.ts'

// 配置自己所在的目录（不要再套一层 dirname——那会退到 apps/，node_modules 就找不到了）
const here = realpathSync(fileURLToPath(new URL('.', import.meta.url)))

/** Match the editor's actual dependency, regardless of npm/pnpm layout. */
function prosemirrorResolve() {
  const ownRequire = createRequire(resolve(here, 'vitest.config.ts'))
  const editorRequire = createRequire(ownRequire.resolve('y-prosemirror'))
  const editorEntry = realpathSync(editorRequire.resolve('prosemirror-model'))
  const directEntry = realpathSync(ownRequire.resolve('prosemirror-model'))
  // An alias to an ESM entry beside an externalized CJS consumer creates a
  // second Schema instance. Only resolve a real mismatch, using its CJS entry.
  return editorEntry === directEntry ? null : { find: 'prosemirror-model', replacement: editorEntry }
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
 * 这里把超时放宽到 60s：**它不隐藏逻辑失败**——真正卡死的用例照样会失败，只是晚一些；
 * 它消除的只是"机器忙不过来"这类与代码无关的红灯。除此之外只有 `resolve.alias`
 * 是显式加进去的两条（见下面），测试环境本身仍由各文件顶部的
 * `@vitest-environment` 声明。
 *
 * 2026-10-08 再放宽（15s → 60s）：重渲染用例（阅读页对拍、编辑器跨视图往返）单跑
 * 已要 10–11s，CI runner 上并行跑时越过 15s，v1.2.0 发布的首轮 CI 就因此红了 3 个
 * 文件 17 条用例——全部是超时和它的后续连带（超时后 body 为空），与改动无关。
 */
export default defineConfig({
  resolve: {
    /**
     * `sharedAlias` 不是可选项：pnpm 对 `file:` 依赖是**安装期快照**，被编辑过的
     * `packages/shared` 文件在 `node_modules` 里留的是编辑前那一份（没编辑过的才是硬链接）。
     * 不指别名，桌面这套用例就在测一份和 `typecheck`（tsconfig paths → 源码）不是同一
     * 个文件的合同——两边可以同时绿，而绿的不是同一件事。
     */
    // The editor and fixture must share one Schema instance.
    alias: [prosemirrorResolve(), ...sharedAlias].filter(Boolean),
  },

  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    /**
     * `waitFor` 的等待上限由 Testing Library 自己管（默认 1000ms），**不受**
     * `testTimeout` 影响——只调 vitest 超时，仍然会在机器忙时撞到它。
     * 这里通过 setup 文件统一放宽，覆盖的仍是"轮询等待"这类与代码无关的红灯。
     */
    setupFiles: ['./vitest.setup.ts'],
    /**
     * 只在 CI 上给红掉的用例**同一条重跑一次**的机会。
     *
     * 为什么要有它：连续两次发布 tag 的 `Desktop client` 各红一条、而且换文件——
     * v1.8.11 红在 `StudySurface`（翻页那一页没接上），v1.8.12 红在
     * `settings-surface`（CAS 冲突后第二次提交带的 revision）。两个 commit 的
     * `main` 检查都是绿的，同一份工作树本地全量（422 文件）也都是绿的，红的永远是
     * 当场随机挑的那一条。`deploy` 这一档 `needs: desktop`，于是一条与服务器无关的
     * 客户端用例把服务端发布一起顶掉了：v1.8.11 的包发出去了，服务器还停在 1.8.10。
     *
     * 为什么不是别的两种做法（都实测过）：
     * - 串行跑（`--no-file-parallelism`）本地 146s → 573s，四核 runner 上整档要
     *   十几分钟，发布链不该为此变长一倍以上；
     * - 把 `desktop` 从 `deploy` 的 `needs` 里摘掉确实最省事，但那是把一道真的质量闸
     *   松掉，不是把噪声去掉。
     *
     * 它**不掩盖逻辑失败**：重跑跑的是同一份断言、同一份代码，稳定的红两次都红，
     * 照旧挡住发布；被消掉的只有"这一次调度没赶上"那一类。本地不设这个值（`CI`
     * 环境变量为假），日常开发仍然一次判红，不把问题留到第二次机会。
     */
    retry: process.env.CI ? 1 : 0,
  },
})
