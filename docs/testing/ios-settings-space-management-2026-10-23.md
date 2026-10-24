# iOS 设置：书房管理与邀请管理 — 2026-10-23

## 本轮范围与设计决定

设置栈新增「书房管理」与「邀请管理」两页，承接桌面端「我的空间 / 成员与邀请」的同一组服务端能力：新建协作书房、改名、退出、解散、用邀请码加入，以及当前书房的邀请码、邀请记录、成员名册、移除成员与转让所有权。Android 本轮不改界面。

| 决定 | 做法 | 原因 |
| --- | --- | --- |
| 只能管理「当前会话所在」的书房 | 邀请与成员只读当前书房；要管理另一间，先在书房管理里切换过去 | 服务端 `/members`、`/invites`、`requireOwner` 都从会话取 `workspace_id`，不伪造跨空间接口 |
| 个人书房与协作书房分开说话 | 个人书房可改名；不出现邀请表单与成员名册，改为一条边界说明 +「返回书房管理」 | 服务端对个人书房发邀请恒为 403；先摆一个点了才报错的按钮比没有更糟 |
| 成员看不到管理层 | 成员进入邀请管理只看到「只有所有者可以管理邀请与成员」与本轮能做什么；成员在协作书房可退出 | 与 `requireOwner` 判据一致，提前问一次只会把清楚的边界换成一句报错 |
| 邀请码只显示一次 | `POST /invites` 的明文只放在页面回执里，离开页面即清除；列表只有 `tokenHint` | 服务端只在创建响应返回明文，客户端不落盘、不重显 |
| 解散前先说清代价 | 点「解散书房」先读 `dissolve-preview` 的 notes/sources，再在行内展开确认 | 用户点的不该是盲盒；读不到计数时说「数量暂时数不出来」，不拿 0 冒充空书房 |
| 解散当前书房先切回个人书房 | 切回个人书房拿到新凭据后，再按 id `DELETE /workspaces/:id` | 服务端解散会删掉该 `workspace_id` 下的 sessions，旧凭据当场失效；反过来做后续刷新与切换都会 401 |
| 退出当前书房后换凭据 | `POST /auth/leave-workspace` 返回新 token 时保存、整块重置会话再恢复 | 退出会重签个人书房凭据；不重置会留着上一个书房的成员与邀请读数 |
| 破坏性动作必须确认 | 退出/解散在书房行内展开确认；撤销邀请、移除成员、交出所有权用带后果说明的确认弹窗 | 动作不可撤销或立即失效，文案写清对方与自己的后果 |
| 换空间、退出、解散、登出后清空书房读数 | `spaceGeneration` 递增 + `clearSpaceManagementState()`；在途请求回来时用 generation + token 双重校验丢弃 | 成员与邀请属于当前书房，换空间后屏幕上留着上一个书房的名单是错的数据 |
| 与设置栈同一套纸面语言 | 平涂白纸卡、极细冷灰边、钴蓝主色、无渐变；`SpaceCard`/`SpaceSection`/`SpaceTag` 与既有设置页一致 | 设置栈已经收敛为中性纸面 + 一档钴蓝；新页不引入第二套卡片语法 |

## 实际调用链

### 文件与路由

| 层 | 文件 | 内容 |
| --- | --- | --- |
| DTO | `apps/mobile-client/ios/Astella/App/DTO/SpaceManagementModels.swift` | `WorkspaceMemberSummary`、`WorkspaceInviteSummary`、`CreatedWorkspaceInvite`、`WorkspaceDissolveCounts`；角色/类型/状态/有效期中文标签与日期截取；邀请角色与有效期选项 |
| 状态 | `apps/mobile-client/ios/Astella/App/AppStore.swift:95-119` | 成员、邀请、一次性回执、读 flag/total/error、`isSpaceLoading`/`isSpaceBusy`、`spaceError`/`spaceNotice`、`spaceGeneration`、解散计数与失败集合 |
| 派生值 | `apps/mobile-client/ios/Astella/App/AppStore.swift:175-193` | `currentWorkspace`（以 `profile.workspaceId` 为准）、`currentWorkspaceRole`（个人书房恒 owner）、`canManageCurrentWorkspace`、`isCurrentWorkspacePersonal` |
| Store 方法 | `apps/mobile-client/ios/Astella/App/Store/SpaceMethods.swift` | `refreshWorkspaces`/`loadSpaceManagement`/`createWorkspace`/`renameWorkspace`/`loadDissolvePreview`/`dissolveWorkspace`/`leaveWorkspace`/`joinWorkspace`/`loadInviteManagement`/`refreshWorkspaceMembers`/`refreshWorkspaceInvites`/`createWorkspaceInvite`/`revokeInvite`/`removeMember`/`transferOwnership`；错误码→中文、generation 防回写、边界清理 |
| 换空间 | `apps/mobile-client/ios/Astella/App/Store/AccountMethods.swift` | `switchWorkspace(_:notice:stayOnCurrentTab:)`；`beginWorkspaceBoundaryReset()` 统一清空笔记、会话、账户与书房读数 |
| 界面 | `apps/mobile-client/ios/Astella/Screens/SpaceManagementScreens.swift` | `WorkspaceManagementScreen`（邀请入口、我的书房、新建与加入、行内确认）；`InviteManagementScreen`（上下文卡、作用域说明、所有者区/成员边界/个人边界、一次性回执、邀请记录、成员名册、权限说明） |
| 入口 | `apps/mobile-client/ios/Astella/Screens/HandAndAccountScreens.swift:1717` | 设置页「书房」分组 →「书房管理」行 |
| 导航 | `apps/mobile-client/ios/Astella/Shell/MainTabShell.swift:267-298, 356-357, 681-682` | `AccountScreenRoute.workspaceManagement/.inviteManagement`、`navigationDestination`、Debug 直达路由与 `--open-account=` 真实账号入口 |
| 直达调试 | `apps/mobile-client/scripts/ios-dev.py` | `workspace-management(-dissolve)`、`invite-management(-member/-personal/-members/-receipt)`、`settings`、`cache-management`、`about` 路由 |
| 大字号开关 | `apps/mobile-client/ios/Astella/App/AstellaApp.swift:100-112` | `--ui-large-type` 对本轮新增直达路由同样生效 |
| 真实账号调试凭据 | `apps/mobile-client/ios/Astella/App/MobileAPI.swift:43-50` | 仅 Debug 读取 `ASTELLA_API_TOKEN`（未签名模拟器 Keychain 不可用的替代） |
| 详情页标题 | `apps/mobile-client/ios/Astella/Design/Components.swift` | `AstellaDetailHeader` 本轮补了不透明 canvas 底色，滚动内容不再透到标题与状态栏（全设置栈共用） |

### 服务端接口

| 动作 | 接口 |
| --- | --- |
| 可进入的书房 | `GET /auth/workspaces` |
| 新建 / 改名 / 解散 | `POST /workspaces`、`PATCH /workspaces/:id/name`、`DELETE /workspaces/:id` |
| 解散计数 | `GET /workspaces/:id/dissolve-preview` |
| 切换 / 退出 / 加入 | `POST /auth/switch-workspace`、`POST /auth/leave-workspace`、`POST /auth/join-workspace` |
| 邀请 | `GET /invites?limit=100`、`POST /invites`、`DELETE /invites/:id`（204） |
| 成员与所有权 | `GET /members`、`DELETE /members/:userId`（204）、`POST /workspaces/:id/transfer-ownership` |

### 状态与错误边界

- 新建协作书房沿用桌面端「建完就进入」：`POST /workspaces` 成功后 `switchWorkspace` 到新书房，可以直接在邀请管理里发邀请；切换失败则刷新列表并提示「可以在列表里切换进入」。
- 加入邀请码只写成员行、不换会话：成功后刷新列表并提示「在上面的列表里切换进入」；`already_member` 当作成功（刷新后提示已是成员）。
- 邀请角色只发 `role`（member/owner）；有效期只发 `expiresInHours`（1–168），「长期有效」不传该字段。
- 领取不到 `workspaceId`/`token`/`id` 视为失败并提示，不拿本地拼的名字冒充服务端结果。
- 错误码统一翻成这一步该说的话：`workspace_limit_reached`、`personal_workspace_not_shareable`、`not_owner`、`owner_cannot_leave`、`personal_workspace_cannot_leave`、`cannot_dissolve_personal_workspace`、`actor_is_not_active_owner`、`last_owner`、`self_remove_owner`、`target_is_owner`、`target_not_member`、`personal_workspace_not_transferable`、`invalid_name`/`empty_name`、`not_found`、`already_member`、`already_consumed`、`already_revoked`、`expired`、`revoked`；认不出的码优先用服务端 message，网络层失败单独给网络句。
- 所有读写都用 `generation + api.token` 双重校验，旧响应不能回写新书房；`clearSpaceManagementState()` 在 `beginWorkspaceBoundaryReset()` 内被调用，登出同路径。
- 移交所有权成功后主动清空成员与邀请读数、清掉一次性回执，页面按新的 `canManageCurrentWorkspace` 切到成员边界说明。

## 验证方式与证据

构建与设备：修复后模拟器 Debug 构建（产物 10:33:19，随后 10:40:41 对同一份源码重编一次；本轮源码 mtime 均 ≤10:31），设备 `Astella Companion QA`（iPhone 17 / iOS 27，UDID `BDD1F0A5-BF5F-4B89-9284-D4DCA511058F`），全程 headless `simctl` 截图，未 clean/archive，未改源码。原始截图在 `tmp/space-qa/shots/`，入档截图在 `docs/testing/assets/ios-settings-space-management-2026-10-23/`。

### Debug 直达路由（示例数据，网络被 `api.isUIReview` 阻断）

| 路由 | 核对内容 | 截图 |
| --- | --- | --- |
| `workspace-management` | 邀请入口当前书房说明、当前徽标（当前行保持正常墨色，不再被 disabled 压暗）、三行角色·类型、新建/加入、底部限制说明 | [列表](assets/ios-settings-space-management-2026-10-23/01-workspace-management-owner.png) |
| `workspace-management-dissolve` | 行内展开解散说明（12 篇手记 / 4 份来源）+ 确认解散 / 取消，不跳页 | [解散确认](assets/ios-settings-space-management-2026-10-23/02-workspace-management-dissolve.png) |
| `invite-management` | 所有者上下文、作用域说明、角色分段与解释、有效期菜单、生成按钮、邀请记录三态 | [所有者邀请页](assets/ios-settings-space-management-2026-10-23/03-invite-management-owner.png) |
| `invite-management-members` | 成员名册（所有者徽标、成员 more 菜单）、权限说明；标题栏不再透出滚动内容 | [成员名册](assets/ios-settings-space-management-2026-10-23/04-invite-management-members.png) |
| `invite-management-receipt` | 一次性邀请码回执：tokenHint·角色·有效期、复制、等宽 token、可选中 | [邀请码回执](assets/ios-settings-space-management-2026-10-23/05-invite-management-receipt.png) |
| `invite-management-member` | 成员边界：只有所有者能管理，无表单无名单；补了「返回书房管理」 | [成员边界](assets/ios-settings-space-management-2026-10-23/06-invite-management-member-boundary.png) |
| `invite-management-personal` | 个人书房边界：不邀请别人 +「返回书房管理」（`dismiss()`，不再压入重复页） | [个人边界](assets/ios-settings-space-management-2026-10-23/07-invite-management-personal-boundary.png) |

外观：`invite-management --dark`、`workspace-management --dark` 均按自适应色板渲染（纸卡 `#1C1F26`、主色变浅蓝 `8AB2FF`、语义 danger 低饱和），无渐变；见 [暗色邀请页](assets/ios-settings-space-management-2026-10-23/08-invite-management-dark.png)、[暗色书房页](assets/ios-settings-space-management-2026-10-23/09-workspace-management-dark.png)。

详情页标题栏：`AstellaDetailHeader` 加了不透明 canvas 底色（共用改动），本轮补查 `cache-management`、`about`、`ai-authorization`、`device-permissions` 四页，标题与内容布局均正常、滚动内容不再与标题/状态栏重叠；见 [缓存管理](assets/ios-settings-space-management-2026-10-23/19-header-cache-management.png)、[关于](assets/ios-settings-space-management-2026-10-23/20-header-about.png)、[AI 授权](assets/ios-settings-space-management-2026-10-23/21-header-ai-authorization.png)、[设备权限](assets/ios-settings-space-management-2026-10-23/22-header-device-permissions.png)。

大字号：`--ui-large-type` 已接到本轮直达路由，但设置栈字号全部是固定 `.system(size:)`，加 `--ui-large-type` 与设备级 `content_size accessibility-large` 都**完全没有放大**（两张截图字号逐像素一致）；见 [大字号开关](assets/ios-settings-space-management-2026-10-23/10-large-type-no-growth.png)、[系统 accessibility-large](assets/ios-settings-space-management-2026-10-23/23-system-accessibility-large.png)。这是设置栈的既有实现方式，本轮未引入回归，但「大字号可读」在本轮不能算已验证（见验证限制）。

### 真实接口：所有者 A

以 `SIMCTL_CHILD_ASTELLA_API_TOKEN=<A token> xcrun simctl launch --open-account=...` 进入真实会话（A 的会话在「QA 协作书房」，owner）。

| 场景 | 已确认 | 截图 |
| --- | --- | --- |
| 书房列表 | 个人书房 + QA 资料室 + QA 协作书房三间、角色正确、当前徽标在 QA 协作书房且该行保持正常墨色、邀请入口显示「当前「QA 协作书房」· 邀请码、成员与权限」 | [真实书房列表](assets/ios-settings-space-management-2026-10-23/11-real-owner-workspace-management.png) |
| 邀请页 | 上下文卡「QA 协作书房 / 所有者 / 协作书房」；未点生成时没有 token 回执；邀请记录按服务端状态渲染：`732a4225` 已撤销（本轮 curl 写测试产生）、`00895dfc` 可用 + 撤销、`ed3d4c86` 已撤销（创建/撤销日期）、`e3f7c002` 已使用 + 使用人 `qa.space.member@example.com` | [真实邀请页](assets/ios-settings-space-management-2026-10-23/12-real-owner-invite-management.png) |

邀请页在 curl 写入/撤销一条邀请后重开，首行变为新邀请「已撤销」——界面读的是服务端最新状态，不是本地缓存。

成员名册在首屏以下，headless 无法滚动，故未拍到真实成员行；替代证据：`GET /members` 真实返回 2 人（A owner、B member），API 访问日志确认 App 实际发出 `GET /members`（A 200 / B 403），名册行渲染由示例直达路由同视图核对。

### 真实接口：成员 B

B 的会话同样在 QA 协作书房，role=member。

| 场景 | 已确认 | 截图 |
| --- | --- | --- |
| 邀请页 | 只有成员边界：上下文卡「QA 协作书房 / 成员 / 成员徽标」+「只有所有者可以管理邀请与成员」+「返回书房管理」，没有邀请表单与名单 | [真实成员边界](assets/ios-settings-space-management-2026-10-23/14-real-member-invite-management.png) |
| 书房列表 | QA Member的工作区（个人）+ QA 协作书房（成员、当前徽标，当前行正常墨色）；行内操作只剩「退出书房」（菜单展开需点按，以代码判据核对） | [真实成员书房列表](assets/ios-settings-space-management-2026-10-23/15-real-member-workspace-management.png) |

### 写流程与守卫（curl，未点按 UI）

全部回执见 [real-api-receipts.json](assets/ios-settings-space-management-2026-10-23/real-api-receipts.json)（只记录状态与字段，不包含 token）。

| 用例 | 结果 |
| --- | --- |
| `POST /invites` role=member, 24h | 200，返回 id/tokenHint/role/expiresAt（明文不写入文档） |
| `DELETE /invites/:id` 新建的那条 | 204；再删同一条 409 `already_revoked`；删原本已撤销的那条 409 `already_revoked` |
| `POST /workspaces` | 200 返回 workspaceId/workspaceName |
| `GET /workspaces/:id/dissolve-preview` | 200 `{notes:0,sources:0}` |
| `PATCH /workspaces/24a31039…/name` 改名 → 改回 | 均 200，`name` 精确回显；列表恢复「QA 资料室」 |
| `POST /workspaces/24a31039…/transfer-ownership` 给非成员 B | 409 `target_not_member` |
| `POST /workspaces/12c49f51…/transfer-ownership`（个人书房） | 409 `personal_workspace_not_transferable` |
| `DELETE /members/<A 自己>` | 409 `self_remove_owner` |
| `DELETE /members/<陌生 uuid>` | 404 `not_found` |
| `DELETE /workspaces/<本轮的临时书房>` | 200 `{dissolved:true, counts}` |
| B 用已有邀请码 `join-workspace` | 409 `already_member`（邀请未被消耗） |
| B `GET /members`、`GET /invites` | 均 403 `owner role required` |

收尾核对：A 仍有 3 间书房（个人 + QA 资料室 + QA 协作书房），协作书房与资料室都**没有**被解散或改名；成员仍 2 人；A 仍是 QA 协作书房 owner，B 仍是 member。唯一残留是本轮 `POST /invites` → `DELETE` 产生的已撤销邀请 `732a4225`（撤销行不会消失，属预期），其余恢复原状。

### 回归

| 场景 | 结果 | 截图 |
| --- | --- | --- |
| 设置页新增入口 | 「书房」分组位于「外观与显示」之后、「存储」之前，行标题「书房管理」、副文案「新建、改名、退出书房；邀请与成员」；既有分组未挤压 | [设置入口](assets/ios-settings-space-management-2026-10-23/16-settings-entry.png) |
| 修改密码 | 三段输入、保存按钮禁用态、说明文案正常；标题栏底色改动后无布局位移 | [修改密码](assets/ios-settings-space-management-2026-10-23/17-regression-change-password.png) |
| 我的 | 资料卡、伴星卡、设置/AI 分组、退出登录、Dock 正常 | [我的](assets/ios-settings-space-management-2026-10-23/18-regression-me.png) |
| `cache-management` / `about` 直达路由 | 补入 review-mode 白名单后可正常进入（此前落到登录页） | 见上方 19、20 |
| `ai-authorization` / `device-permissions` | 两页不在 `ios-dev.py` 的 ROUTES 清单里，用 `simctl launch --ui-review=…` 直接进入核对；渲染正常 | 见上方 21、22 |

## 本轮 QA 发现并已修复的问题

| 问题 | 修复 | 复核证据 |
| --- | --- | --- |
| 当前书房行被 disabled 态按 `AstellaPressStyle` 压到 40% 透明，整行发灰像不可用，暗色下更明显 | 当前行不再走 disabled 分支，只让点按无效（`allowsHitTesting`），保持墨色 | 明/暗书房列表当前行均为正常墨色：01、09、11、15 |
| 两页顶部大标题透明，滚动内容从标题与状态栏后面透出并重叠 | `AstellaDetailHeader` 补不透明 canvas 底色（全设置栈共用） | 成员名册页滚动后标题区干净：04；另抽查 19–22 |
| 右下角常驻伴星球压住行内「撤销」/「已使用」等右侧控件 | 两页底部内容 padding 提到 120，滚到内容末尾时最后一行让开球体 | 内容末尾让开；中途滚动仍会与球重叠，属全局悬浮球行为，见验证限制 |
| 个人书房边界的「去书房管理」用 `NavigationLink` 再压入一份书房管理 | 改为 `dismiss()`，按钮文案「返回书房管理」；成员边界补同一入口 | 07、06、14 |
| `--ui-review=cache-management` / `--ui-review=about` 落到登录页（直达路由白名单缺这两项） | 补入 AppStore review-mode 白名单与选中 tab 切换 | 19、20 |

## 验证限制

- **没有点按能力**：本次只有 headless `simctl` 截图，环境里没有 `idb`/`applesimulator` 窗口自动化，也没有 Simulator GUI。所有交互后的状态（点开菜单、生成邀请码回执、复制、撤销/移除/移交确认弹窗、退出/解散执行后的回执、下拉刷新）都没有在 UI 上点出来；这些行为以**代码路径 + 真实 curl 接口回执**核对，不能算触控验收。
- **真实成员名册未直接入镜**：在首屏以下且无法滚动；只有示例直达路由的名册截图、`GET /members` 真实响应与 API 日志三条间接证据。
- **大字号在本轮不成立**：设置栈固定字号，`--ui-large-type` 与系统 `accessibility-large` 都不改变渲染；需要另立「设置栈 Dynamic Type」任务才能真正验收。
- **右下角悬浮伴星球仍会盖住中途滚动的内容**：这是全局伴星入口的既有行为，不是本页特有 bug；页面已通过底部 120pt padding 保证滚到末尾时最后一行不被盖住，但滚动中途经过球体坐标的控件（如邀请行的「撤销」）会被临时遮挡。
- **未验证服务端「协作书房最多 3 个」的触发**：会留下多余书房，未做破坏性验证；页面文案与 fixture 记录的 3 个上限一致。
- 未覆盖真机触感、VoiceOver、动态字体全组合、弱网/离线重试路径；示例直达路由里的「界面预览 · 本地示例」标记不代表真实数据。
- 本轮未改 iOS 源码；只写 `docs/testing/**` 与 `tmp/space-qa/**`。
