# Astella 桌面客户端

拾星笔记的 Electron 单窗口客户端。源码分为 `src/main`、`src/preload` 与 `src/renderer`；详细说明见 [桌面分册](../../docs/guide/zh/desktop-client.md)／[English](../../docs/guide/en/desktop-client.md)。

## 启动与配置

先按 [根 README](../../README.md) 配置并启动后端。在仓库根执行：

```bash
make desktop-client-install
make desktop-client-dev
```

开发主进程读取仓库根 `.env`。本机 HTTP 连接需配置 `ASTELLA_DESKTOP_PAIRING_KEY_ID`、`ASTELLA_DESKTOP_PAIRING_SECRET` 与 `ASTELLA_DOMAIN_SCHEMA_REVISION`；远程 HTTPS 连接通过证书与契约校验，见 [部署分册](../../docs/guide/zh/deployment.md)。密钥与 API 令牌不进入渲染层。

## 包内命令

以下在本目录运行：

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 按 lockfile 安装依赖；首次单独校验前还需安装 `packages/shared` 的依赖 |
| `npm run dev` | Electron + Vite 开发窗口，CDP `9222` |
| `npm run dev:watch-main` | 同时监听 main／preload 变更；普通 dev 改主进程后需重启 |
| `npm run typecheck` | 分别检查 Node 与 renderer TypeScript 配置 |
| `npm run build` | 校验房间图层，构建 `out/` 并验证输出素材 |
| `npm test` | Vitest；产物包含测试依赖 `out/`，干净检出先 build |
| `npm run preview` | 打开当前 `out/`；不会自动刷新旧构建 |
| `npm run dist` | 类型检查、测试、构建与打包；首次先 build 以供产物测试读取 |
| `npm run package:mac:arm64` / `package:mac:x64` / `package:win:x64` / `package:linux:x64` | 构建并打包指定平台；不代替完整测试 |
| `npm run capture:evidence` | 先构建，再采集窗口与流程证据 |
| `npm run package:smoke` / `package:evidence` | 已打包应用冒烟／将证据绑定到产物摘要 |
| `npm run evidence:manifest` | 按输入清单生成证据 manifest；默认 fixture 仅验证格式 |

当前自动安装包发布覆盖 Windows 与 macOS；Linux 可单独打包。具体平台、签名与更新限制见 [运行与发布](../../docs/guide/zh/operations.md)。

## 进程边界

生产页面通过 `astella-app://bundle/index.html` 提供，支持 GET、HEAD 与单段 Range；文件限制在打包 renderer 目录内，解析符号链接后也须通过路径检查。互动产物使用独立的 `astella-app://artifact/<uuid>` origin 与受限 CSP。

renderer 没有 Node 能力。仅主 frame 获得 `window.astella`（类型化业务 IPC）与 `window.astellaDesktop`（平台、标题栏、窗口状态）两条桥；子 frame 无权获取它们。HTTP、SSE、笔记协同、上传、导出与更新由 main 承担，本机 ASR 在独立 utility process 运行。

实际检查应同时覆盖册页与全屏、阅读／编辑／源码、快速切换、保存与冲突、键盘和减少动态；截图与单测分别提供证据，不能代替交互体验。
