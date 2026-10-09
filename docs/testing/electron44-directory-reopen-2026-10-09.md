# Electron 44 与目录重新展开闪烁验证

2026-10-09。用户在盲测 A（44.7.0）与 B（43.4.1）中观察到滚动均未闪烁，目录收起再打开均会闪一下；随后选择 44，理由是感觉更顺畅。这次选择不构成升级已经修复所有滚动闪烁的证据。

## 目录闪烁原因与改动

`DirectoryRail` 先使真实控件采用最新展开状态，再由不可交互的冻结副本绘制弹簧过程。动画结束移除副本与 `data-rail-morphing`，交回真实目录。真实图标原来的 `opacity 120ms` CSS transition 在交接时重新从 0 淡入，副本已经消失，产生空白。原副本的三段平面底色也没有真实目录的背景模糊，阴影不同，交接时材质发生变化。

- `hud-surface.css` 将目录图标 transition 限定为背景、文字颜色和阴影，透明度由目录形变动画持有。
- `directory-rail-motion.ts` 用一个底部定位的皮肤承接高度变化，复制真实目录的背景、边框、圆角、阴影和背景模糊。保留同一弹簧时钟、换向速度与即时焦点路径。
- 目录回归测试覆盖展开副本材质与完成交接；原有测试继续覆盖快速换向、旧回调、键盘焦点、Off 和系统减少动效。

真实 Mac 窗口通过原生点击及键盘操作，并用只读逐帧采样观察交接：

| 指标 | 改动前 | 改动后 |
| --- | --- | --- |
| 完整展开交接样本 | 1 次 | 2 次 |
| 真实图标交接首帧透明度 | 0 | 两次均为 1 |
| 随后 150ms 最低透明度 | 0 | 两次均为 1 |
| 交接附加 CSS 淡入 | 有 | 无 |
| 副本背景模糊 | none | blur(12px) |

还操作了连续往返、展开中用键盘进入设置、Lite、Off，以及动画中切换 Off；结束后副本与形变标记均清除，控件可立即操作。系统减少动效由已有组件测试覆盖，没有修改本机系统设置。

## Electron 44 配套适配

依赖与锁文件固定为 44.7.0。Mac 打包声明最低 macOS 13；Electron 44 已移除旧 macOS 支持，见 [官方 44 发布说明](https://www.electronjs.org/blog/electron-44-0) 与 [44.7.0 发布记录](https://releases.electronjs.org/release/v44.7.0)。

主进程剪贴板在 44 中改为异步，富文本写入使用 `ClipboardItem[]`，见 [官方 Clipboard API](https://www.electronjs.org/docs/latest/api/clipboard)。读取候选链接、复制纯文本和笔记富文本导出均等待操作完成；测试覆盖延迟完成与拒绝结果，富文本和 Markdown 放在同一条目中。

兼容渲染模式保留 `disable-gpu-compositing`，去掉此前试验发现会影响 44 WebGL 的 `disable-skia-graphite`。独立 44 实例实测：`companionStatus=ready`、WebGL 上下文可创建、`gpu_compositing=disabled_software`、`webgl=enabled_readback`，Graphite 禁用开关未设置。具体图形故障后的既有回退行为保留。

## 验证范围与交付

- 7 个相关测试文件、56 个测试通过：目录组件与弹簧、渲染偏好、渲染设置、HUD 页面、剪贴板 IPC、笔记文件操作。
- 桌面包 `npm run typecheck`、`npm run build` 通过，构建包含房间资源源文件与输出守卫。
- Mac arm64 与 Windows x64 的 electron-builder 应用目录打包通过。Mac 框架版本核对为 44.7.0，最低系统声明为 13.0。
- 本机原生修复窗口已经登录本地已有长对话测试账户，Full 动效，默认渲染；窗口名为「拾星笔记 44修复版」，使用生产 `out/`。没有替换 `/Applications/Astella.app`，没有发布安装器。
- 尚未验证 Windows 实机、旧 Mac 硬件、安装器发布与完整产品回归。

本地证据位于 `apps/desktop-client/outputs/directory-reopen-20261009/`：`before-report.json`、`after-report.json`、两次逐帧采样、`compatible-runtime.json`、Mac/Windows 打包日志。原盲测资料在 `outputs/ab-blind-20261009/`。测试 profile 含本地登录会话，不作为发布材料。
