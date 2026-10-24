# iOS 液态玻璃控件验收（2026-10-23）

## 用户决定

2026-10-23，用户截图圈出下列位置，要求把这批 **switch、按钮、输入框** 换成苹果的液态玻璃，并明确 iOS 端处理、Android 本轮不动：

1. 星轨：日记／伴星记忆／手边分段，月份导航（`< 2026 年 10 月 >`）
2. 星轨·伴星记忆：关于你的／她的记事／目标与方法分段，正在使用／待确认／固定／有争议／已归档筛选
3. 相伴页底部输入条（说给伴星听…），书房随行面板共用同一条输入器
4. 设置：外观与显示（银白／深夜／随系统）
5. 阅读页：返回书房、目录、字、更多；底部速览／学习卡／脑图；更多菜单与目录 popover

第一次实现后用户指出两个问题：分段按钮变成三颗互相融合的玻璃胶囊，接缝处挤出窄颈，"你这做的啥破按钮啊"；选中项又被系统染色玻璃带偏，和页面里钴蓝行动按钮颜色不一致（"颜色不对"）。据此定稿：

- **一条玻璃轨道 + 一枚选中的品牌蓝透镜**。不让每段各自上玻璃——相邻玻璃形状在同一个容器里会互相融合，三颗胶囊只剩窄颈相连。
- **透镜直接使用品牌钴蓝 `#2F6BFF`**（深夜为 `#8AB2FF`），不经 `Glass.tint` 染色；只叠一道很轻的顶部边光与投影，保留"陷在玻璃轨道里"的体积感。
- **玻璃只铺在交互控件本身**。把玻璃画在 `.background { }` 里会拿不到页面底色采样，退成一枚灰面（筛选胶囊第一版即如此）。

## 实现

统一原语在 [apps/mobile-client/ios/Astella/Design/LiquidGlass.swift](../../../apps/mobile-client/ios/Astella/Design/LiquidGlass.swift)：

- `LiquidGlassSurface` + `View.liquidGlassSurface(radius:tint:interactive:)`：iOS 26 及以上用系统 `glassEffect`，更早系统或开启「减少透明度」时退回纸面（纸白填充 + 0.8pt 细边 + 轻阴影）；`radius` 为 nil 即胶囊。
- `AstellaGlassSegmented<Item>`：一条 `glassEffect` 轨道，选中段内画 `AstellaGlassLens`，用 `matchedGeometryEffect` 让透镜滑动；旧系统 / 减少透明度保留原纸白轨道 + 实色蓝透镜。分段内的触感与选择动画由组件统一发出，避免调用点重复触发。
- `AstellaGlassLens`：品牌蓝胶囊 + 顶部白色边光 + 极轻投影。
- `AstellaGlassChipLabel`：胶囊玻璃标签；选中用品牌蓝透镜，未选中直接把玻璃铺在标签上。

改动位置：

| 界面 | 文件 | 控件 |
| --- | --- | --- |
| 星轨 | `Screens/HandAndAccountScreens.swift` | 日记／伴星记忆／手边分段、月份导航与两枚圆形箭头、记忆分组分段、筛选胶囊 |
| 设置 / 阅读设置 | `Screens/HandAndAccountScreens.swift` | 银白／深夜／随系统分段（两处，删除旧 `appearanceButton` 与动画命名空间） |
| 相伴页头 | `Conversation/ConversationScreen.swift` | 伴星／记录分段（朗读开关保留在同一玻璃轨道内） |
| 输入条 | `Conversation/CompanionComposer.swift` | 输入条容器改系统玻璃；`+`、语音／发送按钮保留原钴蓝与浅蓝填充（它们嵌在玻璃输入条内部，再叠玻璃会发闷） |
| 阅读页头 | `Screens/Notes/NoteReader.swift` | 返回书房胶囊、目录／字／更多圆钮、加载占位返回钮 |
| 阅读工具 | `Screens/Notes/NoteReader.swift` | 更多菜单面板、底部速览／学习卡／脑图胶囊；目录 popover 去掉强制纸面 `presentationBackground`，交给系统玻璃 |
| 目录 popover | `Screens/Notes/NoteOutline.swift` | 关闭圆钮改玻璃 |

## 验证

环境：Xcode 27（27A266a），iPhone 17 / iOS 27.0 模拟器 `Study Speech 5c3656b8`（`912953CC-9AD5-4BF3-A81C-A506D8CC6F36`），Debug。用 `python3 scripts/ios-dev.py build` 增量构建，`ios-dev.py open <route> --simulator <udid>` 安装并用 `--ui-review` 直达页面，`simctl io screenshot` 截图。示例数据仅来自 Debug 预览，没有调用真实 AI、上传或写入接口。

证据（`docs/testing/assets/ios-liquid-glass-controls-2026-10-23/`）：

- `orbit-diary.png`：星轨分段 + 月份导航。分段为一条玻璃轨道，选中透镜取样 `(47,107,255)`，与页面行动按钮完全一致。
- `orbit-memory.png`：记忆分组分段与筛选胶囊；选中胶囊同为 `(47,107,255)`，未选中为玻璃白面。
- `conversation.png`：相伴页头分段 + 底部输入条玻璃。
- `conversation-dark.png`：深夜外观下的同一组控件，玻璃转深、选中透镜为深夜蓝 `#8AB2FF`。
- `reader.png`：阅读页头四枚玻璃控件与底部三枚玻璃胶囊（正文从胶囊下穿过，玻璃对文字做真实模糊）。
- `reader-outline.png`：目录 popover 使用系统玻璃，关闭圆钮为玻璃圆钮。
- `settings.png`：外观三档分段。

构建记录：`/tmp/astella-ios-dev/simulator-build.log`，最后一次增量构建 105.3s 成功。

## 未验证与限制

- 阅读页「更多」展开的五项工具面板没有在本轮截图里打开：`--ui-review` 路由不能模拟点击，且没有可靠的无障碍注入通道。面板本身只调用同一个 `liquidGlassSurface(radius: 24)`，与已验证的月份导航 / 输入条同一条渲染路径。
- iOS 18 与「减少透明度」的纸面回退没有实际运行（本机只有 iOS 27 运行时）。两条路径的代码是同一分支，回退时不等同于液态玻璃，仍按原纸面样式呈现。
- 未在真机复核；模拟器能证明构图、材质与深浅色，不能证明 120Hz 手感、真机玻璃采样性能或触感。
- 目录 popover 的系统玻璃相当透（能看到正文的模糊影像）。本轮按用户"换成液态玻璃"的要求保留系统材质；如果阅读长文时觉得干扰，可以再给 popover 加一层很轻的纸面纱或提高材质不透明度。
- 大字号下新分段的固定高度（46/40/31pt）没有重测；文字使用 `minimumScaleFactor(0.8)`，但超出时仍可能压缩。
- 工作区里同时有另一个会话在改书房列表（`NotesScreen.swift`、`Screens/Notes/LibraryComponents.swift`、`App/AstellaApp.swift`，并启动了自己的 QA 模拟器），本轮构建与安装会和它交叉。上面证据均在 `Study Speech 5c3656b8` 上用本轮安装的构建截取，没有改动对方文件。
- 所有改动仍在未提交的工作区里；没有提交、没有打标签。
