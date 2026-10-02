import { config as loadDotenv } from 'dotenv'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

import { sharedAlias } from './shared-alias.ts'

// Keep local desktop development aligned with the root Compose .env. The
// values are consumed by the privileged main process only; they are not
// injected into renderer import.meta.env or exposed through preload.
loadDotenv({
  path: fileURLToPath(new URL('../../.env', import.meta.url)),
})

/*
 * 这个文件曾经带一个 `releasePublicAssetsPlugin`：`publicDir: false` 关掉 Vite 的整目录
 * 拷贝，自己逐个 emitFile，只为了把 `assets/3d/`（旧 3D 学习房归档包）排除在安装包之外。
 * 那套归档包已随旧书房整条删除，public 树下不再有任何需要排除的目录，
 * 于是整个插件连同 `packagingExcludedPublicPrefixes` 一起删掉——**public 现在由 Vite
 * 默认的 publicDir 拷贝**。若日后又要排除什么，加回插件，不要只加一行前缀常量。
 */

/**
 * `@ailearn/shared` 的实时源码别名定义在 `shared-alias.ts`，与 `vitest.config.ts`
 * 共用同一份（两边解析的不是同一个文件，就有一边在测一份快照）。
 */
export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    build: {
      // Shared contracts are source-only TypeScript. Bundle them into the
      // packaged main process so Electron never tries to require a .ts export
      // from the workspace at runtime.
      externalizeDeps: false,
      rollupOptions: {
        // `ws` 的两个可选原生加速依赖（笔记协同通道带进来的）。它们**故意不装**：
        // 没有它们 ws 会退到纯 JS 实现，行为一致。但 Vite 的依赖打包会给解析不到的
        // 可选 peer 生成一句**模块顶层**的 throw（out/main/index.js 里
        // `throw new Error('Could not resolve "bufferutil" imported by "ws"')`），
        // 那会在 Electron 启动时直接炸掉整个主进程，ws 自己的 try/catch 根本轮不到。
        // 标成 external 后运行时是普通 require：解析不到 → ws 捕获 → 走纯 JS。
        external: ['bufferutil', 'utf-8-validate'],
      },
    }
  },
  preload: {
    resolve: { alias: sharedAlias },
    build: {
      // Preload is executed from the packaged artifact, outside Node's
      // workspace resolver; keep the IPC schemas inside the preload bundle.
      externalizeDeps: false
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    base: './',
    resolve: {
      alias: [
        { find: '@renderer', replacement: resolve('src/renderer/src') },
        ...sharedAlias,
      ],
    },
    server: {
      // 别名指向仓库根的 packages/shared，dev server 默认只允许 root 内的文件。
      fs: { allow: [resolve('../..')] },
    },
    plugins: [react()]
  }
})
