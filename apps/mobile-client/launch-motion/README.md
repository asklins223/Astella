# 手机端日夜启动动效

本目录是两端共用的正式动效源文件，素材来自用户在 2026-10-18 选定的两张原画。日间外观使用果冻软星；夜间外观使用深蓝发光书房。这里不包含演示首页、假数据、播放控制台或固定结束倒计时。

原生 SwiftUI / Compose 继续负责认证、会话恢复和真实首页。离线 WebGL 层只渲染原画、材质和伴星，在恢复登录会话或登录成功后接回书房期间显示。完成会话、对话和第一批手记恢复后，原生层发送 `ready`；伴星移到原生首页角色的实测边界，背景与标语隐退。若恢复的是记录视图或其他原生页面，则淡出至该页面，不编造一个角色位置。认证表单保留原有白色设计。

## 调用链

- iOS：`AppStore.restoreSession()` 更新 `startupLoadState` → `RootView` 挂载 `LaunchMotionView` → `LaunchMotionWebView`。`CompanionScene` 通过 PreferenceKey 报告真实角色边界；WebKit 将全局坐标转为自身坐标。归位结束后一次更新移除动效层并显露原生角色。
- Android：`AppViewModel.restoreSession()` 更新 `startupLoadState` → `AstellaRoot` 挂载 `LaunchMotion`。`CompanionStage` 报告 `boundsInWindow()`，宿主减去 WebView 原点并换算 dp。对话恢复会等待初始消息与运行状态快照，首批手记也参与就绪；模型下载独立进行。

页面数据读取失败仍由真实页面显示错误。会话恢复失败、过期或登出会撤下启动层，保留重连／登录入口。后续搜索、发送、朗读和分页不重新播放整屏启动动画。用户可随时跳过动画。系统／本机减少动态关闭水波、果冻与角色动作，归位改用快速淡变。

## 渲染与资源

`source/water-shaders.js` 保留原画纹理上的亮灯、水波折射、侧边光路、同步地面倒影和果冻弹性；`actor-rig.js` 提供眨眼、写字、抬头与摆尾。`timeline.js` 负责真实就绪、前后台及幂等完成；`landing.js` 计算原画角色到原生图片边界的交接。全程共用同一个场景时钟。

首帧由原生图片提供，随后交给 WebGL。PNG 数据按场景拆成包内脚本，通过 data URI 解码，以避开移动 WebView 的 file-origin 纹理跨域限制。没有外网资源请求；桥只接收外观、动效偏好、活动状态、就绪和角色几何，不传账号数据。退出时移除桥、销毁纹理、渲染上下文及 WebView。

## 修改与构建

在本目录运行 `npm install`、`npm run build` 和 `npm test`。工作区已有依赖时也可直接执行：

```sh
node apps/mobile-client/launch-motion/build.cjs
node --test apps/mobile-client/launch-motion/tests/*.test.js
```

构建会生成 iOS 的 `Astella/LaunchMotion/`、Android 的 `src/main/assets/launch-motion/`，以及两端的首帧图片。原生工程直接打包这些产物，运行时不需要 Node 或 CDN。请修改本目录源文件后重建，避免单独编辑某一端生成的副本。`artwork-manifest.json` 记录原始 PNG 的 SHA-256。

两端的具体构建、模拟器运行及未确认范围见 [接入验证记录](../../../docs/testing/mobile-launch-motion-2026-10-18.md)。
