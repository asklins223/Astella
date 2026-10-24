# iOS 书房双列卡片与原位缩放

本轮始于 2026-10-23，窗口复核完成于 2026-10-24。范围是 iOS 书房首页及打开手记的导航；Android 与阅读正文的数据链路不在本轮改动内。

用户否定了中途的一列文字目录，明确选择「柔软双列卡片，继续阅读单独突出」，并要求使用 iOS 原生动效从点按的位置打开、返回缩回相同位置。下面记录的是最终卡片版本。

## 最终构图

| Before | After | Why |
| --- | --- | --- |
| 标题、副文案、书房胶囊各占一层 | 书房名称紧跟标题，导入与更多操作在右侧 | 减少顶部层级，给实际手记留出空间 |
| 继续阅读与普通手记都是相近的白色横卡 | 继续阅读用单独蓝色主卡；普通手记为双列圆角白卡 | 先看见可继续的内容，同时能浏览多篇 |
| 摘录、日期、学习状态挤在横排中 | 每张卡按日期、标题、摘录、底部状态排列 | 长标题可换行，状态不与标题争夺空间 |
| 继续阅读和列表里的同篇手记共用缩放标识 | `LibraryNoteRoute` 同时保存手记 ID 与来源，两个入口分别注册原生缩放源 | 从实际点开的对象展开，返回对应卡片 |
| 加载骨架与实际列表形状不符 | 主卡与双列手记的同形呼吸骨架 | 加载前后保持位置与结构的连续性 |

普通卡片保留长按「重命名／删除」，预览可读完整标题；权限继续由 `canManageNotes` 和原服务端接口控制。顶部加号直接打开材料导入；资料处理状态和书房备份收进更多菜单。搜索仍使用真实全文搜索与游标分页，刷新时保留现有内容，搜索等待时显示对应骨架。

无障碍字号自动改成单列，书房切换移到标题下，卡片随内容增高。缩放、按压与骨架同时遵守系统减少动态及应用内减弱动效；后台暂停骨架时间线。未增加常驻装饰动画。

## 原生缩放调用链

`LibraryResumeCard / LibraryNoteCard` → `NavigationLink(value: LibraryNoteRoute)` → `NotesScreen.navigationDestination` → `NoteDetailScreen`。

卡片标签注册 `matchedTransitionSource`，正文目的页注册 `navigationTransition(.zoom)`；来源分别是 `library-resume-<id>` 与 `library-card-<id>`，共用页面持有的 Namespace。字符串 ID 的外部跳转仍有自己的目的页，不冒用一个用户没有点过的缩放源。减少动态时不注册缩放，交给普通导航。

同时修正 Debug 场景优先级：明确传入的 `--ui-review=` 高于宿主遗留的 `ASTELLA_UI_REVIEW`，SwiftUI Preview 显式传入的 `reviewMode` 优先级最高。此前环境中固定的 `library` 会让加载／空态验收实际落在正常页。

## 验证

- 增量 Debug 构建成功：双列布局批次 26.43 秒，预览参数修复批次 10.06 秒；未 clean、archive 或重编译 Cubism。一轮构建曾遇共享编译数据库被其他进程锁定，释放后重试成功。
- iPhone 17 / iOS 27 的 `Astella Library QA 2026-10-23` 模拟器：正常双列、长标题、继续阅读、加载、空态、失败及重试入口、深夜、大字号和应用内减弱动效均检查了实际窗口。
- 普通卡片实际打开正文并返回；原生录屏逐帧确认缩回普通卡片，而不是同篇手记上方的继续阅读入口。继续阅读主卡也实际打开并返回。
- 触屏键盘输入「笔记」后得到一张匹配卡；点开并返回仍保留关键词、结果数量和该卡位置。无结果和清除搜索恢复全列表也已操作。
- 长按普通卡片显示完整预览与「重命名／删除」菜单；更多菜单能打开资料处理状态面板。
- `git diff --check` 对本轮 Swift 与 Xcode 项目文件通过。没有为纯布局新增镜像测试；本轮不改变 API 契约，未重复跑跨包回归。

这些窗口使用阻断真实 API 的 Debug 示例；它们证明界面、输入与导航行为，不证明服务端读写或真机帧率。模拟器侧滑已触发原生返回；工具无法稳定保持中间手势再反向拖回，因此手势中途取消和真机 60/120 fps 仍未确认。系统减少动态的代码门控保留，窗口检查使用应用内减弱动效开关。

## 证据

- [最终卡片构图](assets/ios-library-redesign-2026-10-23/library-cards.png)
- [普通卡片返回的原生录屏帧](assets/ios-library-redesign-2026-10-23/library-return-frames.png)
- [加载骨架](assets/ios-library-redesign-2026-10-23/library-loading.png)、[空态](assets/ios-library-redesign-2026-10-23/library-empty.png)、[失败状态](assets/ios-library-redesign-2026-10-23/library-error.png)
- [深夜与无障碍字号](assets/ios-library-redesign-2026-10-23/library-dark-large-reduced.png)
- [中文搜索](assets/ios-library-redesign-2026-10-23/library-search.png)、[搜索后打开并返回](assets/ios-library-redesign-2026-10-23/library-search-return.png)、[长按菜单](assets/ios-library-redesign-2026-10-23/library-context-menu.png)

原始状态截图保存在 `library-before.png`；`library-rejected-text-list.png` 是被否定的中途方案，不是交付效果。
