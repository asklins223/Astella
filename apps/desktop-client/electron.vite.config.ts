import { config as loadDotenv } from 'dotenv'
import { createReadStream, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

import { sharedAlias } from './shared-alias.ts'
import { voiceAsrModelDirectory } from './src/shared/voice-asr-model-path.ts'
// ⚠️ 走**源码相对路径**而不是 `@ailearn/shared/…`：本文件由 Node 直接加载，
// 还没有 vite 的 alias（`sharedAlias` 只作用于被打包的那三份），而
// `node_modules/@ailearn/shared` 是 pnpm 的安装期快照——它还不知道新增的那条
// exports，子路径 import 会直接 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
import {
  VOICE_ASR_MODEL_FILES,
  VOICE_ASR_MODEL_ROUTE_PREFIX,
} from '../../packages/shared/src/contracts/voice-asr-model-contracts.ts'

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
 * 开发模式下由**开发服务器自己**提供用户下载的语音识别模型（2026-10）。
 *
 * ## 为什么不能靠打包后那条 app scheme 路由
 *
 * 打包后页面在 `ailearn-app://bundle`，模型挂在同一 host 的 `/device/asr/`，同源，能读。
 * 开发时页面在 `http://localhost:5173`，从那里 fetch `ailearn-app://bundle/...` 实测
 * **直接 `TypeError: Failed to fetch`**——那种自定义 scheme 不做 CORS 放行，而给
 * `connect-src` 放开它又会波及整套 app scheme 的开发资源（字体、Live2D、wasm 全部
 * 都是从那里跨源取的）。所以开发模式让开发服务器在**自己的 origin** 上提供这两个文件：
 * 同源，两种形态走同一条 worker 代码，CSP 一条都不用改。
 *
 * 只认清单里那两个文件名，且字节数对得上才给——与打包后那条路由同一把尺子。
 */
function voiceAsrModelDevAssets(): Plugin {
  const directory = voiceAsrModelDirectory()
  return {
    name: 'ailearn:voice-asr-model-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? '').split('?')[0]
        if (!path?.startsWith(`/${VOICE_ASR_MODEL_ROUTE_PREFIX}`)) {
          next()
          return
        }
        const name = decodeURIComponent(path.slice(VOICE_ASR_MODEL_ROUTE_PREFIX.length + 1))
        const file = VOICE_ASR_MODEL_FILES.find((entry) => entry.name === name)
        if (!file) {
          response.statusCode = 404
          response.end('Not found')
          return
        }
        let size: number
        try {
          const stats = statSync(resolve(directory, file.name))
          if (!stats.isFile() || stats.size !== file.expectedBytes) throw new Error('not installed')
          size = stats.size
        } catch {
          // 没装就说没装。这一格由设置页负责引导，服务器只如实回答。
          response.statusCode = 404
          response.end('Not found')
          return
        }
        response.setHeader('Content-Type', name.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/octet-stream')
        response.setHeader('Content-Length', String(size))
        // 这里只处理整文件 GET/HEAD，不做 Range：worker 那边是 `fetch(...).arrayBuffer()`，
        // 不发 Range。打包后那条 app scheme 路由有完整 Range 实现（`createAssetResponsePlan`），
        // 两者不一致的地方目前无人走——若日后有代码要 Range，在这里补上，别让它悄悄退化成整读。
        if (request.method === 'HEAD') {
          response.end()
          return
        }
        createReadStream(resolve(directory, file.name)).pipe(response)
      })
    },
  }
}

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
        // 两个入口（2026-10-06）：`voice-asr-host` 是本机识别引擎的宿主脚本，由
        // `utilityProcess.fork` **单独**拉起——随包的引擎是 emscripten 的 Node 构建
        // （工厂里无条件 `require("path")`），而渲染窗口是 `sandbox: true`、worker 里
        // 连 `require` 都没有，它只能在 Node 上下文里跑。`fork` 接的是**文件路径**、
        // 不是函数，所以它必须是一个独立的可执行文件，这里给它第二个入口。
        //
        // `index` 那一行不要省：给了 `input` 就是**接管**默认入口，省掉默认项主进程
        // 根本不会启动。
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'voice-asr-host': resolve(__dirname, 'src/main/voice-asr-host.ts'),
        },

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
    plugins: [react(), voiceAsrModelDevAssets()]
  }
})
