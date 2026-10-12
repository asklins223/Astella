# 方案 51 · 连贯前端 Demo

当前版本：2026-10-12，Demo 08。用户本轮确认保留角色优先，打开见到 Live2D，切换查看记录。本次按后续决定统一为蓝色主题，最终使用蓝白柔和渐变顶部背景，底部流光随音波强弱调整亮度与厚度，已移除边框光效。延续无色玻璃、白色阅读纸面、衬线正文与小屏适配；最新证据见[蓝色渐变复核](../../../../../apps/mobile-client/prototype/mobile-companion-blue-review-2026-10-12.md)，此前布局与字号证据见[样式复核](../../../../../apps/mobile-client/prototype/mobile-companion-style-review-2026-10-11.md)。这仍是方案 51 §19.4 范围内的浏览器视觉探索。46–49 记录此前 Demo 06 的 Live2D 与粒子语音，37–45 记录 Demo 05 的无色玻璃与账号页；21–35 属于已被否定的旧视觉，15–19 保留动效追溯。

## 打开与体验

[打开本轮本机 Demo](http://127.0.0.1:4198/apps/mobile-client/prototype/mobile-companion-layout.html)。原型在 `apps/mobile-client/prototype/`，Live2D 模型与字体仍在桌面工程下，所以从仓库根启动一个静态服务，页面与 `../../desktop-client/...` 资源才同时可解析（4196 若已占用，可用本轮的 4198）：

```sh
python3 -m http.server 4198 --bind 127.0.0.1 --directory .
```

- 登录页：伴星居中、一块无色玻璃表单；邮箱密码、显示密码、保持登录、创建账号和示例体验均可用。示例账号为 `demo@astella.local` / `Astella123`。请使用演示数据。
- 注册页：称呼、邮箱、密码、确认密码；选填邀请码默认收起，本机示例为 `ASTELLA`。新账号从空书房开始。
- 菜单 → 个人中心：编辑称呼与头像、进入伴星中心、切空间、设置、退出。退出后隐藏私有聊天和桌面预览。
- 伴星中心：接着当前交流、留想法、读图、找笔记；表达、记忆与日记都有完整页面和来源返回，继续使用同一条聊天。
- 对话：默认大幅真实 Live2D 与最新短气泡；顶部伴星／记录切换共用当前交流和草稿。语音演示提供粒子音波、播报口型、暂停、打断、结束和转文字；不会自动记成笔记。
- 设置：对话默认视图、阅读字号、朗读速度、AI 使用与数据、已有记忆。没有新增动效调整项。
- 手记 → 阅读 → 问一段／改一段 → 修改前后：保留同一对象、实际原文和来源位置。创建、修改和保存核对接回右侧同一份演示数据。

左侧“屏幕与体验条件”默认收起，仍可检查尺寸、大字、断网、只读、未同意、键盘占位、Off、模糊降级和任务失败。动效引擎、触发来源、进退方向和手势沿用此前实现。

## 材质与边界

一张 [窗光底图](../../../../../apps/mobile-client/prototype/mobile-companion-toplight.png) 固定在应用顶部，通过遮罩淡出到暖白底，不占内容高度。当前页、退出副本与阅读滚动容器透明；切页不切换背景。玻璃只使用白色透明反光、亮边、模糊和中性阴影，不加蓝紫／绿色填充。长正文使用稳定纸面，关闭模糊及不支持时使用中性实底。CSS 效果不代表原生物理折射。底图由内置 imagegen 生成，[提示词与保存记录](../../../../../apps/mobile-client/prototype/mobile-companion-toplight.prompt.md) 单独保存。

手机和桌面预览订阅同一份本机 Store；账号、凭据散列、偏好、记忆和日记同样是本机原型。已加载项目批准的本机 Live2D 模型与 Cubism runtime；没有连接真实认证、统一 Agent、AI 模型、实时同步、ASR 或正式移动宿主。选图真实解码但不上传，示例图使用预写讲解；语音输入是转写样例，不采集麦克风；回复由浏览器本机中文声音播报，口型按实际播报时序估计，粒子不是实际录音振幅。原生键盘、真机性能、声音听感和实际跨设备仍需接入后验证。

## 验证

本轮 35 项已有测试通过，真实几何另见样式复核，不据此宣称原生客户端验收。以下保留此前 Demo 06 的记录：34 项测试通过，新增 7 项默认布局、偏好、取消与迟到回调、同一交流、草稿、权限和粒子生命周期检查；原有 27 项覆盖7 项业务数据／回执／权限／恢复，12 项动效／节点／来源／焦点／手势，8 项账号／身份隔离／偏好与来源。9 个脚本通过语法检查。

```sh
node --test apps/mobile-client/prototype/__tests__/mobile-companion-data.test.cjs apps/mobile-client/prototype/__tests__/mobile-companion-motion.test.cjs apps/mobile-client/prototype/__tests__/mobile-companion-account.test.cjs apps/mobile-client/prototype/__tests__/mobile-companion-scene.test.cjs
```

Demo 05 真实窗口检查了登录失败及成功、注册确认密码错误和保留字段、退出隐私展示、320×640 注册与 205px 键盘占位、焦点自动进入可读区域，以及对话／手记／阅读／伴星中心／个人中心／设置的实际材质。横向溢出为 0。切页退出副本在场时，前后共用同一张背景、同一遮罩和同一根底色，两个内容层均透明；玻璃的计算样式只有白色 RGBA 色阶。控制台未报告错误。

此前全流程的创建、同一对象修改、来源与版本恢复、头像更新、表达与记忆，以及日记来源检查分别由已有走查和当前回归测试提供证据，不冒充本轮重新走查全部流程。Demo 06 的实际模型、粒子、口型、记录恢复、小屏键盘与 Off／玻璃降级见 [语音场景复核](../../../../../apps/mobile-client/prototype/mobile-companion-voice-scene-review-2026-10-11.md) 和 [检查记录](voice-scene-verification-2026-10-11.json)。此前账号验证见 [Demo 05 复核](../../../../../apps/mobile-client/prototype/mobile-companion-centers-review-2026-10-11.md) 和 [本轮检查记录](centers-demo-verification-2026-10-11.json)。旧 [动效记录](motion-demo-verification-2026-10-11.json) 与 [10 月 10 日记录](complete-demo-verification-2026-10-10.json) 保留追溯。可复现 capture 脚本本轮仅做语法检查，实际窗口证据通过 CUA 获得。

## 当前截图

| 页面 | 截图 |
| --- | --- |
| 默认 Live2D 场景 | [46](46-live2d-default-scene.png) |
| 粒子语音／播报口型 | [47](47-particle-voice-speaking.png) |
| 保留的聊天记录 | [48](48-preserved-chat-history.png) |
| 场景转文字／小屏键盘 | [49](49-scene-small-keyboard.png) |
| 伴星中心 | [37](37-toplight-companion.jpg) |
| 对话／无色底栏 | [38](38-toplight-conversation.jpg) |
| 手记 | [39](39-toplight-notes.jpg) |
| 阅读 | [40](40-toplight-reading.jpg) |
| 居中伴星的新登录页 | [41](41-toplight-login.jpg) |
| 设置 | [42](42-toplight-settings.jpg) |
| 个人中心 | [43](43-toplight-profile.jpg) |
| 注册 | [44](44-toplight-registration.jpg) |
| 小屏注册／键盘 | [45](45-clear-glass-small-keyboard.jpg) |

源码：[页面](../../../../../apps/mobile-client/prototype/mobile-companion-layout.html)、[布局](../../../../../apps/mobile-client/prototype/mobile-companion-layout.css)、[材质](../../../../../apps/mobile-client/prototype/mobile-companion-theme.css)、[账号与中心](../../../../../apps/mobile-client/prototype/mobile-companion-centers.js)、[账号模拟](../../../../../apps/mobile-client/prototype/mobile-companion-account.js)、[业务数据](../../../../../apps/mobile-client/prototype/mobile-companion-data.js)、[现有动效](../../../../../apps/mobile-client/prototype/mobile-companion-motion.js)。

场景新增源码：[场景与语音状态](../../../../../apps/mobile-client/prototype/mobile-companion-scene.js)、[真实 Live2D](../../../../../apps/mobile-client/prototype/mobile-companion-live2d.js)、[场景布局](../../../../../apps/mobile-client/prototype/mobile-companion-scene.css)。
