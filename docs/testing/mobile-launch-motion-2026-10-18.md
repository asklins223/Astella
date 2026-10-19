# 手机端日夜启动动效接入 · 2026-10-18

日间使用用户选定的果冻软星原画，夜间使用发光书房原画。两端随已有外观设置选择，保留原画纹理、伴星动作与材质动效；真实恢复完成后，伴星移动、缩放到原生首页的实际角色边界，场景与标语隐退。

## 实现范围

- 共用源文件在 `apps/mobile-client/launch-motion/`。`build.cjs` 生成两端包内渲染资源、原生首帧图片和相同的透明伴星素材。图片采用按场景脚本内嵌的 data URI，避免本地 file-origin WebGL 纹理的跨域限制。
- SwiftUI 由 `AppStore.restoreSession()`、`RootView`、`LaunchMotionView` 和 `LaunchMotionWebView` 接通；`CompanionScene` 报告全局角色边界，由 WebKit 转为自身坐标。
- Compose 由 `AppViewModel.restoreSession()`、`AstellaRoot` 和 `ui/launch/LaunchMotion.kt` 接通；角色通过 `boundsInWindow()` 报告位置。消息、运行状态及首批手记参与启动就绪，模型下载独立进行。
- 首页、认证、错误与重连入口均使用真实原生页面和数据。记录视图／其他页面没有角色时采用淡出；会话失败或过期会撤下动效层。没有演示首页或固定完成倒计时。
- 生命周期控制场景时钟；减少动态停止水波、果冻和人物动作，归位改为快速淡变。用户可跳过动效，渲染失败可返回真实页面。退出会清理桥、纹理和渲染上下文。

## 已执行检查

1. 修改前分别运行 iOS Simulator Debug 构建和 Android `assembleDebug`，均成功。
2. 修改后的双端 Debug 构建成功。iOS 使用 `xcodebuild ... CODE_SIGNING_ALLOWED=NO build`；Android 使用 JDK 17 和 `./gradlew --offline assembleDebug`。
3. `node --test apps/mobile-client/launch-motion/tests/*.test.js`：**10 项通过**。覆盖长期真实加载不会按演示时间结束、首帧时间衔接、重复就绪、后台暂停、减少动态中途切换、原生位置匹配、iOS 宽度修正，以及两端离线纹理和归位前后角色图片的一致性。
4. `git diff --check -- apps/mobile-client` 通过。APK 内的渲染脚本、HTML 和素材清单与生成目录一致。
5. Android 最终包安装并启动于 Pixel 8 / API 36 模拟器，使用已有本地测试登录态。实际查看了日间启动画面和恢复后的真实首页。运行日志先收到真实 `ready=true` 与角色边界，再依次记录 `assetsReady`、`paintStarted`、`rendered`、`landed`，完成后原生首页保持可见。
6. iOS 包已安装并启动于 iPhone 18 Pro Max / iOS 27 模拟器。该项证明安装和启动，不记作登录后页面及手势的窗口验收。

两套材质使用同一份着色器程序和配准资料；原画与清除底图均已打包并校验。前期实际运行发现的本地纹理跨域问题已通过内嵌 data URI 修复。

Android 完成归位后的[真实原生首页截图](mobile-launch-motion-native-home-2026-10-18.jpg)。截图只证明交接后的页面状态，动态过程以运行日志和窗口观察为依据。

## 验证边界

最终夜间开屏没有完成单独的模拟器窗口复核；本轮后段部分镜像窗口鼠标操作未可靠生效，未将这些点击记为交互通过。iOS 登录后归位、原生 Live2D 已就绪时的交接、实体设备的帧率、功耗、内存与无障碍路径仍需复核。不能用编译、脚本测试或单帧截图代替这些结果。

本次未提交、发布或部署应用，未修改服务端 API。工作区原有的移动页面与其他功能改动已保留。
