# Cubism SDK for Native（入库裁剪版）

- 来源：Live2D 官方 https://cubism.live2d.com/sdk-native/bin/CubismSdkForNative-5-r.5.zip （下载页 https://www.live2d.com/sdk/download/native/ ，2026-10-15 下载，Cubism 5 SDK for Native R5）。
- 许可：`CubismSdkForNative-5-r.5/LICENSE.md`（Cubism SDK Release License）、`NOTICE.md` 与 `Core/LICENSE.md`（Live2D Proprietary Software License）；`Core/RedistributableFiles.txt` 明确列出 Core 静态库可再分发。商业发布（上年营收超 1000 万日元的主体）需另行取得 Release License——本项目未上线，发布前复核。
- 裁剪：只保留移动端构建所需——`Core/{include,lib/ios,lib/android}`、`Framework/src`（C++ 框架源码）、`Samples/{Metal,Common}`（Metal 渲染器参考实现）。删除了其余平台 lib/dll、OpenGL/D3D/Vulkan 样例与示例资源；完整包按上方 URL 可复取。
- 用途：`apps/mobile-client/ios`（阶段 4b）与 `android`（阶段 9）的伴星 Live2D 渲染；模型资产不在此列（模型走对象存储运行时下载，见 API_SURFACE.md）。
