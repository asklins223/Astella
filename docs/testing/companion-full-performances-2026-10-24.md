# 桌面与 iOS 伴星完整动作接入（2026-10-24）

## 用户决定与范围

用户要求两端补齐现有模型未使用的动作，参考图包括蛋包饭挤番茄酱、点菜板、桌面鲸鱼、头顶鲸鱼、闭眼笑、眼镜与另一种发型。本轮决定覆盖模型资产 README 里排除桌面道具与发型的旧限制。模型默认本来就有桌面与点菜板；旧说明中“伴星没有这张桌子”的判断不成立。

原包位置为 `~/Downloads/DS鲸鱼娘/DS鼠控版/`。当前资产包含原包全部 **44 个表情／道具、7 段动作**，增加 3 段使用既有手部控制参数的记笔记组合，共 **10 段动作**。除 Idle 外的 9 段动作加 44 个表情／道具，构成两端相同的 **53 项洗牌池**。

本轮没有生成新人物图像、修改模型二进制或替换纹理。已有模型许可登记保持原样。改动前相关文件与工作区差异备份于 `/var/folders/jb/rc_045wd47b8js3j00x28lz00000gn/T/astella-companion-performances-68qfrb37/`；保留工作区既有的 iOS、笔记、API 与 Agent 改动。

## 实际调用链

- **共用资产**：`expressions/` 保留原包 44 个文件；model3 登记 ASCII 别名。`PhoneOpen` 和 `Ketchup` 保留原作者曲线；只将非 Idle 动作的 `Meta.Loop` 设为 false。
- **物件依赖**：`presets/` 的 4 个普通 Cubism 表情组合原始参数，确保挤酱同时出现蛋包饭、换色时显示手机或饮料、鲸鱼上桌之前先显示鲸鱼。不在两端分别手写另一套道具状态。
- **记笔记**：`TakingNotes` 有桌面鲸鱼、闭眼笑＋头顶鲸鱼、眼镜＋头顶鲸鱼三种 6 秒组合。复用 `pointX / pointY / pointZ` 手部参数与已有发型、眼镜、鲸鱼参数。
- **桌面**：model3 → `loadWindowLive2DCatalog` → `WindowLive2DPerformanceRotation` → `playInviteOnce`／待机轮播 → 正式 `WindowLive2DDriver`。任务开始的 `task_started` 使用眼镜记笔记，`working` 使用同款方眼镜，避免两副眼镜叠加。
- **iOS**：同版本下载缓存 → `LAppModel.SetupPerformance` 自动读取全部动作与表情 → 点击 `Poke`／待机轮播。真实回合的 `.thinking` → `CompanionEventMap` → 共享宿主 → `startMotionGroup("TakingNotes")`，由 Native 选择其中一种记笔记组合。舞台、头像与迷你对话继续共用一个模型。

资产生成入口是桌面 `scripts/sync-companion-performances.mjs`。运行脚本重建依赖组合、记笔记动作、model3 注册和 SHA-256 清单；`--check` 检查提交的生成结果，不依赖用户 Downloads 目录。

## 播放与归位修复

1. 桌面旧归位层在 motion、表情和物理之后执行，会抹掉蛋包饭、发型或动作中的表情。现在在随包 SDK 的 `beforeMotionUpdate` 事件归位，之后才执行作者动作、表情和物理，与 Native 的帧顺序相同。非 Idle 的脸部曲线也回到基线，不再留下动作末尾的张嘴姿势。
2. 自动眨眼、FACS 和道具清零让位于正在播放的动作参数；真实语音电平仍优先控制口型。iOS 的零电平不再无条件覆盖作者动作的嘴部曲线。
3. 直接点击停止旧表演并取下一项。iOS 使用强制优先级，不再因动作忙碌而丢弃洗牌袋里的动作；桌面清理旧表情、贴纸和动作占用窗口。点击表情结束后恢复期间最新的语义表情。
4. 桌面清单读取改为重新验证缓存，避免新版 SDK 模型配上旧版 30 项表情清单。
5. 桌面自动节奏对齐已确认的 iOS 节奏：首次 24 秒后开始，每条表演结束后安静待机 20–40 秒；点击立即切换。
6. iOS 减弱动效冷启动时，MTKView 的尺寸回调早于 `drawableSize` 写回，旧代码又要求模型已加载才手动绘制，导致暂停状态下没有下一帧来完成加载。现在在尺寸提交后的主线程队列补一帧；只绘制仍归宿主所有的视图，不恢复动画循环。

## 检查结果

改动前基线：桌面清单、参数策略与驱动 35 项测试通过，Native 运动检查 3 项通过。

完成后：

- 桌面清单、参数策略、驱动与交互测试 **45 项通过**，覆盖完整资产池、前置道具、动作不循环、手／眼镜／鲸鱼参数所有权、限时归位、快速切换、最新语义表情恢复、道具保留当前语义表情，以及旧异步动作完成后不抢占新动作。
- 资产打包一致性、情绪、参数仲裁测试另外 **16 项通过**。模型注册、所有引用文件及构建输出一致。
- `npm run typecheck`、`npm run build` 通过。
- `node scripts/sync-companion-performances.mjs --check` 通过；与用户原目录比对，44 个表达式文件逐字节相同，7 段原作者动作的全部曲线保持一致。
- `node --test scripts/__tests__/companion-motion.test.cjs` **3 项通过**，包括实际编译运行的 C++ 短暂回应、连续点按状态归位、暂停与间隔检查，以及 Native 帧顺序、自然输入与桌面 SDK 配置一致性。
- iOS 最终增量构建通过，7.83 秒，覆盖安装 1.84 秒、启动 0.39 秒。未 clean、未 archive、未重编 Cubism Framework。首次构建遇共享 `build.db` 占用；等待后复用缓存。后续为模拟器定点验收补充启动后播放入口，并修复实际发现的减弱动效静帧加载问题；完整计时见 `/tmp/astella-ios-performances-build/timings.jsonl`。

## 实际窗口与录屏

桌面在本地验收窗口使用正式 `WindowLive2DDriver` 与本轮共用资产，不是人物图片替代。实看挤酱、记笔记与闭眼笑，检查多次切换及键盘按钮触发。验收页位于 `apps/desktop-client/demos/companion-performances.html`；它不属于产品导航。

- [桌面蛋包饭挤酱](assets/companion-full-performances-2026-10-24/desktop-ketchup.png)
- [桌面闭眼笑与头顶鲸鱼](assets/companion-full-performances-2026-10-24/desktop-notes-happy.png)

iOS 使用独立 `Astella Actions QA 2026-10-24` 模拟器（iPhone 17／iOS 27，`A1D60633-1D9D-4756-BB60-77CF9B5F1CE2`）。只放入本轮校验过的模型缓存，没有复制账号或凭据。Debug 示例阻断真实 API。模拟器专用 `ASTELLA_LIVE2D_REVIEW=Ketchup_0|TakingNotes_1|TakingNotes_2` 在启动遮罩结束后，经同一个生产洗牌播放函数点播一次；实体设备不编译此入口。

- [手机蛋包饭挤酱](assets/companion-full-performances-2026-10-24/ios-ketchup.png)：运行日志为 `12:57:07 Ketchup_0 → 12:57:12 Idle_0`，完整原作者动作只播一次。
- [手机闭眼笑记笔记](assets/companion-full-performances-2026-10-24/ios-notes-happy.png)：`12:57:34 TakingNotes_1 → 12:57:40 Idle_0`。
- [手机眼镜与头顶鲸鱼](assets/companion-full-performances-2026-10-24/ios-notes-glasses.png)：确认眼镜、临时发型、头顶鲸鱼、手和点菜板同时出现。
- [手机记笔记与桌面鲸鱼](assets/companion-full-performances-2026-10-24/ios-notes-desk-whale.png)：`13:10:23 TakingNotes_0 → 13:10:29 Idle_0`，确认小鲸鱼在桌面右侧而非头顶。通过逐秒接触表核对完整视频，避免用未进入表演或已经结束的帧误判道具缺失。
- [动作结束恢复待机](assets/companion-full-performances-2026-10-24/ios-return-idle.png)。
- **减弱动效冷启动**：修复后日志 `paused=1 / reduce=1 / time=0 / motions=0`，模型实际可见。两张相隔 2 秒的截图在角色区域 `(120,700)–(1180,2050)` 逐像素一致；确认没有用空白画面误判静止。[第一帧](assets/companion-full-performances-2026-10-24/ios-reduced-1.png)／[第二帧](assets/companion-full-performances-2026-10-24/ios-reduced-2.png)。系统设置里的“减少动态效果”开关未单独操作，两种偏好在舞台汇合为同一个 `motionDisabled` 条件。

原始视频、截帧与采集日志保留在 `/tmp/astella-native-actions-qa/`。Native 日志确认 53 项表演池与 55 项基线归位参数，动作结束后继续 Idle、自然身体摆动和发丝物理。

## 分发与尚未覆盖的范围

本轮已将 **64 个资产** 发布到本地开发环境 MinIO 的 `companion/live2d/`，清单版本为 **`d6b10de2d350`**。发布后重新读取清单，并下载 model3、挤酱动作、眼镜记笔记动作与鲸鱼上桌预设，逐一验证其 SHA-256 与清单一致。发布前清单备份于 `/tmp/astella-companion-model-manifest-before-actions.json`。没有发布生产环境服务、App Store 或安装包。

iOS 窗口验收使用同版本的已校验本地缓存；本轮未通过真实账号重跑模型下载与 TTS 回合。Device Hub 的全局选择受到其他验收操作影响，坐标点按误打开场景设置后已关闭，不能把该批操作记作连续点按通过；连续输入由上述回归测试覆盖。实体 iPhone 未连接，真机触感、功耗和帧率没有验收。Native 点菜板前的蓝色网格遮挡在改动前记录中已存在，本轮未改模型、纹理或 Metal 遮罩实现。
