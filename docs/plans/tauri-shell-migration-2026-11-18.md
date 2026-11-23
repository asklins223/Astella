# Tauri 外壳迁移：状态与阻塞（2026-11-18）

Electron → Tauri 2 / Rust 换壳进行中。渲染层（React/Milkdown/PixiJS）原样复用；
Electron 版并行发布兜底。macOS 已对齐；Windows 编译面已通过 MSVC 交叉 check，实机待验。

## 验收基线（release profile，本机实测）

- 登录门稳定态内存：859MB → **542MB**（app 140 + WebKit 402），目标 <600MB ✅
- DMG：208MB（Electron 1.8.27 实档）→ **98MB**（Tauri 官方流水线实测），目标 <150MB ✅
- 官方打包产物：`Astella.app` 102MB / `Astella_2.0.6_aarch64.dmg` 98MB
  （macOS 26 上 DMG 样式脚本会因 Finder AppleEvent 超时失败；
  打包时用 `CI=true` 走无 Finder 样式的路径，本条已在实测中验证）
- 安装体积：368MB → 101MB（单二进制，含渲染资源）
- 登录房间 + 伴星（debug 口径）：约 664MB

## 已完成

1. 骨架：自定义 `astella-app://bundle` scheme 承载整页（同源是模型路由硬前提），
   窗口样式对齐 Electron；确认自定义 scheme 内 IPC 可用（最险前提实验）。
2. 网关：部署配置、HMAC 配对信任握手、远程健康探测、会话凭据（0600 独立文件，
   与 Electron 并存不互写）、连接状态机；Node↔Rust 交叉签名向量。
3. IPC 桥：合同快照、`astella_invoke` 分发、信封与错误码对齐；runtime/auth/
   subscriptions/window 已接。
4. 设备能力：伴星模型分发（清单→鉴权下载→逐文件校验→同源路由→入口门）全链路
   实栈验证；`device/asr` 与模型同源路由；剪贴板/外链/UUID 校验；房间投影、
   capabilities、note 列表/详情/创建/删除/恢复/在场、source 列表/详情/图片、
   search.global、companion.home 投影、伴星人格/声音偏好/作答方式、AI 设置
   （以上只读面均对本地栈实探 200）；
   打开文件接收与 reveal；识别模型管理器；笔记图片上传（本地/API 代理的
   multipart 路径，实栈验证过 1x1 PNG；远程对象存储的直传协议未移植）。
5. 发布基线：release 构建、DMG 尺寸与内存实测（上表）。
6. 导航：`navigation.resolve/go/back/restore` 与 Electron 的进程内栈同形——gate 条目
   （`gate-<kind>`）与 workspace 条目（空间/纪元/L0-L2/来源/焦点键），`entryKind`
   白名单校验、路由须在合同 `enabledRoutes`、空间路由无身份时 `auth_required`、
   meta 纪元不符时 `stale_workspace`；单测覆盖两种条目形状与快照字段。
7. 学习卡 / 脑图 / 星图 / 学习产物：Electron 侧均为 REST 直通，路径与体形逐条对齐
   （get/generate/attempt/answer/complete/history、mind-map task/source、
   `/v3/understanding/topology` 与 note deepening）；`artifact.ensure` 按
   round/note_learning/note_learning_card 三种来源取 HTML，原子写到
   `artifacts/<id>.html` 供 `astella-app://artifact/<id>` 读取。实栈：新笔记上
   学习卡读空态、星图总览 200。
8. 邀请与成员：`invite.create/list/revoke`、`member.list/remove`——原始条目按合同
   转形（`consumedBy`→`consumedByEmail`、member 加 `version`），角色判断留给服务端。
   实栈：个人空间发邀请得到 409→`conflict`（服务端规则）、邀请列表空态、成员名单
   含 owner 且形状正确。
9. Agent（伴星目标/方法/记事）：18 条通道逐条对齐 Electron 的 REST 直通——
   runs 列表/详情/历史/创建/修订/控制、long-goals、selfNotes 列表/历史/写/控制、
   methods 列表/提议/修订/控制/历史/使用/反馈；读通道 query 按 URLSearchParams
   语义编码，写通道从 `request` 取体，纪元不符回 `stale_workspace`。实栈：四类
   读通道在空空间返回合同形状（items 数组 + version + nextCursor）。
10. 伴星记忆（读面）：`memory.list`（query：focusMemoryId/kind/q/scope/
    includeCandidates/includeArchived）、`memory.budget`、`memory.starMap`、
    `memory.recycle-list`、`memory.conflicts`，以及 `budgetMove`（只取服务端
    `result` 层）与 `resolveConflict`。实栈：空空间五项读均返回合同形状
    （list/starMap version 2、预算 resident/active/archived 三段）。
11. 伴星历史与日记：`history.list`（before/throughMessageId/runId/limit）、
    `history.search`（q 必填 + limit）、`history.clear`（DELETE）；`daily.get`（可选
    日期）、`daily.month`、`daily.hide/unhide/delete`（本地日期严校验 YYYY-MM-DD /
    YYYY-MM，非法值本地即拒）。实栈：历史空页、日记 `status: not_generated`、
    月视图空 days。
12. 伴星发现簿 / 旅程 / 参与偏好：discovery 五条（写通道按服务端要求包
    `{meta:{requestId}, request}`）、journey 四条（bootstrap/get/act/actOnInvitation，
    体即 request）、initiative 读/写参与偏好（GET/PUT `/me/companion/participation`）。
    实栈：发现簿空簿、旅程 bootstrap 返回待回邀请、参与偏好 `enabled` 布尔。
13. 伴星账户：`account.getState`（GET `/me/companion`）、`patchState`（PATCH 同路径）、
    `onboarding.transition`（POST `/me/companion/onboarding/:version/transition`，版本号
    白名单校验）。实栈：账户状态含 account + onboardingStates。
14. 伴星记忆写面：create（服务端要 `userStated:true/candidate:false/sourceType:"user_stated"`）、
    correct、revisions、dispute（expectedRevision 本地校验）、dismiss、delete（回
    `{memoryItemId}`）、erase、restore-deleted、clear、clearDerived、rebuildEmbeddings。
    实栈闭环：创建偏好 → 列表可见 → 删除 → 恢复 → 彻底清除，并顺手清掉探针数据。
15. 伴星文件上传：`companion.file.upload` —— 读本地稿纸原件（空/超限即拒）→
    multipart POST `/uploads/companion-files`（`file` text/markdown + `name`）→
    校验回执 `url` 以 `/api/uploads/` 开头后回 `{version:1,url,byteLength}`。
    实栈：临时 markdown 上传成功。**图片上传仍缺**——它走远程对象存储直传管线，
    与「远程直传未移植」同一条边界。
16. 伴星活动时间线：`activity.timeline`（`/companion/deliveries/timeline?limit=50[&before=]`）
    按 Electron 的 `projectCompanionDelivery` 同形投影——标签与跳转目标由
    `payloadRef.kind` 决定，`expired` 用 wire 自带值。实栈：空收件箱返回 items/
    nextCursor/serverTime。`present`/`ack` 仍属伴星桥（未移植）。
17. 伴星聊天（REST 面）：ensureConversation（`/companion/inbox/ensure`，created 看 201）、
    sendTurn（turn 体 + `Idempotency-Key`）、listMessages（limit/beforeSeq）、
    proposal get/decide（同幂等头）、agentRoutes、runNodes（after/includeThinking/runIds）、
    runVoiceSegments、cancelRun、resumeRun（去掉 runId 余体上行）、图片上传
    （multipart 回退 `/uploads/companion-images`，回 noteImageUploadResultV1 形状）。
    **实栈 E2E**：签 AI 同意 → 发「请只回一个字」→ 用户消息可见 → 助手回复到达（8.76s）。
    注意：**流式订阅仍占位**（订阅回执照发、无事件帧），回复可见依赖渲染层本来的兜底轮询；
    服务端 SSE `/companion/conversations/:id/events` 未接。
18. 伴星聊天 SSE 真流式：`chat_stream.rs` 以 Bearer 拉
    `/companion/conversations/:id/events?after=<cursor>`，按行解析 `data:` 帧并投影成
    `{kind:"companion_chat_event",conversationId,event:{seq,runId,generation,eventType,payload}}`；
    订阅注册表按 `companion-chat:<conversationId>` 排队，`companion.chat.pollEvents` 取帧
    （带 `closed`），shim 300ms 分发给监听者；退登时 `close_all` 一并断流。
    **实栈 E2E**：订阅 cursor 0 → 重放到含 `eventType` + `runId` 的事件 → 退订（6.11s）。
19. 伴星桥上下文：`bridge.setContext`（同页去重 → 撤旧租约 → POST
    `/companion/bridge/contexts`，回 `{version,active,revision,expiresAt}`；快照
    `revision` 是**哈希字符串**不是数字）与 `clearContext`（DELETE 带 expectedRevision）；
    10 秒续租由进程内任务做，失败即撤上下文（换页时渲染层会重新发布）。
    退登时本地上下文一并清掉。实栈：发布 → active true → 撤下 → active false。
20. 登录面补全：`auth.register`（`/auth/register-v2`，401→invalid_credentials）、
    `joinWorkspace`、`leaveWorkspace`（均成功后重读 `/auth/me` 重建会话）、
    `changePassword`（成功即断全部协同/聊天流、清本机凭据，回 `{changed,sessionsRevoked}`）、
    `getProfile`/`updateProfile`（`/auth/me` → `{version,displayName,avatarUrl}`）、
    `getAvatar`（`/uploads/<objectKey>` 二进制→base64，key 白名单防穿越）、
    `uploadAvatar`（multipart `/uploads/avatars` 回退 → `{url,objectKey}`）。
    实栈：档案读、头像上传→按 objectKey 读回（image/png，字节数>0）。
    **register/join/leave/changePassword 未实机跑**——会在 dev 库落持久账号或改密码。
21. 空间管理：`workspace.switch`（换发令牌→记盘→纪元+1→断协同/聊天/桥→重读会话）、
    `create`（建后自动切入）、`rename`、`dissolvePreview`、`dissolve`（回逐表计数、
    清本机身份）、`transferOwnership`、`getAiAuditLog`（limit 1..100/offset）。
    实栈闭环：建探针空间 → 会话已在新空间 → 切回个人 → 解散预览/解散 → 审计可读 →
    `getState` 恢复个人空间（6.11s，数据自清理）。
22. 投递租约与搜索维护：`activity.present`（无租先 claim，再 ack `displayed`）、
    `activity.ack`（本地无租即 `conflict`，服务端 409 时换租重试一次；`acted`/`dismissed`
    后丢租）；`search.drift`（GET）与 `search.reindex`（POST，Owner 门在服务端）。
    实栈：漂移读数 + 触发重建通过；**投递租约未实机**（本地栈没有真实投递）。
23. 构建侧修正：`tokio::select!` 依赖的 `macros` 特性原先只写在 dev-dependencies，
    **debug 测试全绿而 release 构建编译失败**；已并入主依赖，`cargo build --release`
    重新通过（二进制 103M，基线不变）。
24. 文件面（第一阶段）：`tauri-plugin-dialog` 接入 + capabilities；`noteWriting.perform`
    的 read/save/image（授权目录、UTF-8/GBK、mtime 修订）；`workspace.export`（对话框/tests
    注入路径）；`companion.data.export`（Downloads 两步落盘）。实栈：本地稿纸读→存→读
    新内容、同级图片授权、越界路径 forbidden；整库导出 JSON 落盘；伴星导出文件落盘。
    **未移植**：noteWriting 的 assets/export/folder/clipboard 动作、`note.exportMarkdown`
    （需 Markdown AST 图片重写）、`source.bundleImport`（包解析）。
25. 文件面（第二阶段）：`note.exportMarkdown` —— 选目录（`ASTELLA_EXPORT_DIRECTORY`
    为显式测试注入点）→ `/notes` 分页列全部非回收站笔记 → `/export/notes/:id` 取正文 →
    文件名按 Electron 判据清洗（非法字符/保留设备名/120 上限）→ 撞名 `(2)` 让位 → 落盘。
    实栈：预置同名占位文件，导出的探针笔记落成 `tauri-export-probe (2).md`，内容非空。
    另补 `noteWriting` 的 `open`（无路径时对话框选文件并授权所在目录）、`folder`
    （目录对话框 + 深 ≤5/≤500 条扫描，跳过隐藏）、`clipboard`（纯文本写入；
    富文本 HTML 待 Markdown→HTML 渲染移植）。
26. 文件面（第三阶段）：`noteWriting save/assets` 的图片落盘改为共享
    `localize_images_into_assets`（sha256 前 20 位、`.assets` 同级目录、原子写）；
    `export` 支持 **md**（同资产逻辑）与 **html**（comrak 渲染 + 图片 data URI +
    完整文档外壳，标题转义）；`clipboard` 改为 HTML+纯文本双写（`arboard.set().html`，
    纯函数 `build_clipboard_html` 有单测）。实栈：HTML 导出落临时文件且含 `<h1>`。
27. 导出图片链路收尾：`collab::seed_image`（yjs `paragraph > image`，src/alt 属性）+
    真栈 E2E——上传 PNG → 增量上行 → `notes.markdownExport` 命中 `assets/` 引用、
    `images=1 / imageFailures=0`（探针笔记与导出目录均已自清理）。
28. Markdown 包导入（目录版）：`source.bundleImport` —— inspect 选目录（`ASTELLA_BUNDLE_PATH`
    为测试注入点）只读盘算数（份数/溢出/引用/可本地化/待上传/字节/issue），import 用同一路径
    （仅认刚 inspect 过的包）逐图 multipart `/uploads/import-images` 换站内地址，
    经共享 AST 重写后交回 tasks（name/content/title），超限整篇进 dropped。
    边界如实报：明文 http、https 外链（下载未移植）、包外绝对路径、缺图/超限逐条进 issues。
    实栈：包内 1 张本地图上传并改写、https 引用报 1 条 issue，preview/import 计数全对。
    **zip 包已通**（`zip` crate 内存解包 ≤400MB，条目上限、忽略段、深度规则一致；
    单测造包验证 md/图片读取与引用规划，live 导入上传改写通过）。
29. Markdown 包（zip）：`zip` crate 内存解包（≤400 MB、条目 ≤5000、忽略 .git/node_modules/
    __MACOSX），与目录包共用 plan/import 管线；单测造包验证读取与引用规划，live 导入
    上传改写通过。另修一处 live 竞态：注册表 `try_lock` 快照与并行用例抢锁，改为短暂重试。
30. 打包产物冒烟：`open -n Astella.app` 实测能起窗并渲染到登录门（WebKit GPU/WebContent/
    Networking 三进程就位），`osascript quit` 正常退出；同次复测稳态内存与 DMG 基线均达标。
31. DOCX 导出：`docx_export.rs` 手写最小 WordprocessingML（zip 包：Content_Types/rels/
    document/styles/media），comrak AST → 标题/段落/强调/代码/列表/引用/表格/图片
    （PNG/JPEG/GIF 按像素尺寸换算 EMU；公式降级原文、WebP 图跳过并留 alt 提示）；
    `export` 增 docx 分支（原子写字节）。验证：包结构单测 + **macOS `textutil` 实解**
    （标题/一级标题/正文均可取回）+ live 落盘（zip 魔数、>1KB）。**PDF 明确泊住**：
    Tauri 无 printToPDF，本机无无头 Chromium。
32. 测试稳定性：`voice_model` 用例的临时目录只有 pid+纳秒，并行线程变多后偶发撞目录
    （half_file_is_not_complete 偶红）；补全局计数器（与其它模块同一做法），feature 集两连绿。
33. PDF 可行性实测（未落地）：cupsfilter 两路均无滤镜、无无头 Chromium、wry 无 printToPDF；
    结论与候选接法（WKWebView `createPDF` via objc2 / 随包 PDF+字体子集）写入上方剩余差距。
34. PDF 导出（macOS）：`pdf_export.rs` 用 objc2/objc2-web-kit 把 wry 的 WKWebView 接出来，
    `createPDFWithConfiguration:` 按 scrollHeight 出整页 PDF；隐藏窗口走
    `astella-app://artifact/<id>`（复用既有 artifact 路由）。演练：打包二进制
    `ASTELLA_PDF_REHEARSAL` 退出码 0、`%PDF-1.3`、UTI 为 com.adobe.pdf。
    Windows 已接 WebView2 `PrintToPdf`（A4、打印背景）；CI 真 Windows 冒烟用 `ASTELLA_PDF_REHEARSAL` 实测输出 `%PDF-`（18,376 B），运行时已验证；其余非 mac/win 平台仍回 `unsupported_contract`。
35. 退登与空间列表：`auth.logout`（本机清凭据为权威、服务端吊销尽力而为、`keepQuickLogin`
   保留凭据文件并跳过吊销）、`workspace.list`（原始 `workspaceName` → 合同
   `WorkspaceSummaryV1`）；退登同时以 `watch` 通道关闭全部活协同会话（写端补 Close 帧，
   两半都放下套接字才真关）。实栈断言：列表非空且形状正确、退登后 `getState` 落回
   `anonymous`。

## 发布打包（脚本化）

`apps/desktop-tauri/scripts/package-release.mjs`：渲染层构建 → release 主二进制 →
`.app`/DMG（内部强制 `CI=true` 绕开 macOS 26 Finder 超时）→（可选）注入
`deployment.json` →（可选）对上一版二进制生成增量补丁（`make_patch --verify`）→
汇总到 `apps/desktop-tauri/dist/<version>/`。**已实跑**（2.0.6：DMG 98MB + Astella.app）。
CI 接线时：上一版主二进制从上一个 release 工件下载，`--previous` 传给它即可；
补丁资产与 `deployment.json` 由发布步骤随包上传。

## 生产部署配置

打包安装时若资源目录带 `deployment.json`（version/mode/apiOrigin/
expectedDomainSchemaRevision/configRevision），启动时在 env 缺项处补齐；
只接受 `remote_https`。开发与冒烟仍以环境变量为准（已存在的 env 不被覆盖）。
发布打包时用 `tauri build --config` 覆盖 `bundle.resources` 注入该文件。

## 阻塞与未完成

- 笔记正文协同（Owner 已定：**Rust 兼容 CRDT，用 yrs**）：
  - `collab.rs`：字节级兼容（Yjs v1 update 往返、SV 差量、幂等），根结构与服务端一致
  - `collab_client.rs`：**hocuspocus 客户端已通**（lib0 帧、Auth 帧、sync step1/2、
    update 收发；协议单测 4 条）。**实栈 E2E 通过**：建笔记→显式共享（WS 只服务
    shared 笔记，服务端 4.5 门控）→鉴权 read-write→sync→yrs 写入→服务端落盘→
    REST 读回正文（2.2s）
  - **`noteDoc.*` IPC 已接**：state（doc-state 起点）/ syncUpdate（shared 走活会话流式；
    private 走 `/v2/notes/:id/doc-update` 增量上送）/ syncTitle（shared 写 meta 流式；
    private 本机合并后上送）/ presence / 草稿 save-get-clear（本机文件）。
    **实栈 E2E 通过（2.25s）**：private 起点→增量上送→共享→流式写入→改名→REST
    读回正文与标题
  - **远端增量推送已通**：`subscriptions.subscribe(topic=noteDoc)` 即开活会话；
    `note.doc.pollUpdates` 取增量；shim 以 300ms 轮询合成 `note_doc_event` 帧分发给
    监听者。E2E 验证：第二个客户端写入 → 订阅会话 pending 队列产出增量（2.55s）
  - **awareness 在场已通**：y-protocols 状态帧编解码（单测往返）、`presence(state)`
    上行走活会话、远端状态进队列并经轮询分发给渲染层（`presence` 事件）。E2E：
    presence 通道实栈断言通过
  - **草稿按 (subjectId, workspaceId) 组键已做**：网关在登录/会话回执里记身份，
    草稿目录名取身份指纹前 16 位；没有身份时 fail-closed（`auth_required`）
  - **只读连接已做**：`Authenticated("readonly")` 不再当错误——照常同步、写入本地即拒
    (`forbidden`)，订阅回执带 `authorizedScope` 并由 shim 下发 `status` 事件给编辑器
    切只读；**成员账号实机未验**（本地只造了 owner）
  - **在场回填已做**：入房鉴权后发 `QueryAwareness`（类型 3，无负载），握手阶段到达的
    Awareness 帧也不再丢弃、统一进 presence 队列。E2E：A 先入房报
    `{"mode":"reading"}`，B 经 `open_live_session` 加入后队列即拿到 A 的状态（0.15s）
  - **断线重连已做**：读线程退出即把会话标死；`ensure_live_session` 在**同一份本机
    文档**上重连（鉴权 → step1/step2 双向补差 → 重新挂读写线程），离线期间的本地增量
    由握手补上行、远端增量并回来。E2E：离线段落重连后 2.18s 落回服务端；订阅/增量/
    改名/在场四通道改走 `ensure_live_session`，原两篇 live 用例复跑 2.54s 无回归
- 语音识别：**模型管理器已移植**（`voice_model.rs`：三源按序、逐文件字节+SHA-256、
  `device/asr` 同源路由已能读到；设置页四条通道接线）。**解码引擎未移植**：
  Electron 用 sherpa-onnx 的 Node 构建跑在 utilityProcess；Owner 已定路线
  **A) sherpa-rs 进程内原生链接**。**已实现**：`voice_engine.rs`（懒加载、
  90s 空闲卸载、16k PCM→f32、SenseVoice auto/itn）、`companion.voice.transcribe`
  通道、sherpa-rs 以**可选 feature `voice-engine`** 接入（默认关，CI 打开；
  本机构建不受 36MB 预编译库下载阻塞——ureq 拉 GitHub 超时，已改 curl 手工入缓存）。
  **已验**：带 feature 完整编译；引擎单测 2 条绿；**真模型冒烟通过**——239MB
  SenseVoice（魔搭源，字节数与合同一致）装入 `voice-models/` 后，1 秒静音输入
  1.27s 返回文本（"嗯。"，引擎加载+解码均正常）。识别质量、长时间稳定性、
  空闲卸载计时未验。
- 打开文件：**接收/去重/取批/在文件管理器中显示已移植**（macOS `RunEvent::Opened`
  + 冷启动 argv；只收 .md/.markdown/.mdown/.mkd，reveal 仅限系统交过的路径；
  `onIncoming` 用同契约的 take 轮询）。`openedFile.prepareImport`（正文图片上传）
  未移植，如实回 `feature_disabled`。Windows 文件关联与单实例转发已接并实测（冷启动 `launch-paths:1`、热转发 `second-instance:1`）。
- artifact frame：**读取路由已通**（`astella-app://artifact/<uuid>` → `<appData>/artifacts/<uuid>.html`，
  严格 CSP、nosniff、只认 uuid）。产物的**写入侧**（讲解生成流程与模板组装）未移植——
  依赖笔记深读通道；路由先就位，写入随那些通道一起补。
- 更新链（2026-11-18 Owner 裁决：**mac/Windows 都要增量、只保上一版、自研补丁包**；
  tauri-plugin-updater 无增量能力，已弃用）：
  - 检查：自家 `latest-mac.yml` / `latest.yml`（与 Electron 同一份），6 小时缓存
  - 增量：`patch.rs`（qbsdiff）——发布资产旁产出 `astella-<to>-from-<from>.qbsdiff`
    + `.json`（patch/结果 sha256）；客户端抹补丁到当前主二进制并核对结果哈希；
    补丁缺失时如实要用户去下载页取整包（整包安装未做）
  - 安装：macOS `install.sh` 等进程退出→替换二进制→重开已实现；
    已用真实 release 二进制跑通 `make_patch --verify`（产物 `astella-2.0.6-from-2.0.5-macos-aarch64.qbsdiff/.json`，778B@108.8MB）。补丁资产名带平台标记：`astella-<to>-from-<from>-<os>-<arch>.qbsdiff/.json`（mac 与 win 同一发布目录不互撞；尚未上架的旧无标记资产已不再被识别）。
    发布布局：正式 `latest*.yml` 仍由 Electron 发布链产出（服务端 `/updates/desktop/:file` 把相对 `url:` 改写到 `github.com/asklins223/Astella/releases/download/<tag>/`）；Tauri 不发布自己的清单，只把带平台标记的增量补丁作为同一 Release 的附加资产上传——客户端以清单 url 的目录为 base 取补丁。
    补丁的 `--from` 必须是**上一版 Tauri 二进制**（不是 Electron 包），因此每次发布还要把当版 Tauri 主二进制（如 `Astella-tauri-<version>-<os>-<arch>`）作为 Release 资产留存，供下次 `make_patch` 取用；上一版资产缺失时该版就发不出增量，只能走整包提示。
    Windows 批处理安装脚本（等 PID 退出→覆盖 exe→启动→自删）已实现并通过内容单测，
    **未在 Windows 上实跑**
  - 发布侧工具：`cargo run --release --bin make_patch -- --from old --to new
    --from-version X --to-version Y --out dist/ --verify` 产出补丁+meta
  - 已验证：补丁往返/损坏拒绝（结果哈希兜底）/清单与元数据解析（30 测试）；
    真实二进制演练：102MB → 补丁 **1.7MB**（仅版本号差异的基线，代码变更会增大，
    但内嵌资源占大头时补丁仍会远小于全量）
  - **端到端升级演练通过**（2026-11-18，本地假更新源 + debug 钩子
    `ASTELLA_UPDATE_REHEARSAL=1`）：available → 补丁(2.4MB)下载 → 应用 → 结果哈希
    核对 → install.sh 等进程退出 → 替换运行中的可执行文件；替换后文件哈希与
    2.0.7 新包一致。`.app` 形态的重新拉起未演练（debug 为裸二进制）
- Windows：NSIS 安装器/WebView2 启动/窗口渲染已在 windows-latest 实测（截图与 startup.log 为证）；真人交互走查待做。
- 已知 flaky 已修：测试临时目录统一走原子计数器（`test_temp_dir`）。

## 完成度审计（2026-11-18，终版）

| 目标要求 | 状态 | 证据 |
|---|---|---|
| 渲染层原样复用 | ✅ | 仅改模型注册表两处路径（`device/models/…/client-manifest.json`）；其余渲染代码未动，构建预算通过（JS 9.1MB/10.5MB） |
| 窗口与协议 | ✅ | `window_control/frame/zoom`；`astella-app` scheme 四类路由（bundle / device.models / device.asr / artifact），自定义 scheme 内 IPC 已实测可用 |
| 网关与身份 | ✅ | HMAC 配对信任、远程健康、60x0 凭据独立文件、会话恢复：本地真栈 live 测试通过；Node↔Rust 签名交叉向量 |
| 设备能力：模型分发 | ✅ | 清单→鉴权下载→逐文件 SHA-256→同源路由→入口门→伴星出画（真栈 + MinIO 全链路） |
| 设备能力：识别模型管理 | ✅ | 三源按序、字节+SHA-256、取消/移除/占用；设置页四通道接线（下载未跑过 239MB 全量） |
| 设备能力：剪贴板/外链 | ✅ | 提取规则与合同逐条对齐；剪贴板主线程读写（CI 真 Windows 写入→读回 ok）；外链白名单打开（单测） |
| 设备能力：打开文件 | ✅（mac）/🟡（win） | RunEvent::Opened + argv；去重/白名单/reveal 授权集合（单测）；Finder 真机路径未点过。Windows：`tauri-plugin-single-instance`（2.5.5，仅 Windows 注册）把第二实例 argv 转给首实例并聚焦窗口，`tauri.conf` 增加 md/markdown/mdown/mkd 的 `bundle.fileAssociations`；MSVC 交叉 check 通过，实机打开方式待验 |
| 设备能力：图片上传 | ✅（本地路径） | multipart `/uploads/images`，真栈传 1x1 PNG 通过；**远程对象存储直传未移植** |
| 自更新链 | ✅（mac 演练） | 检查（自家 yml，6h 缓存）+ qbsdiff 增量（102MB→1.7MB 基线；E2E 替换演练通过）+ mac/Windows 安装脚本；**真实补丁资产与 Windows 实机未验** |
| 发布链 | 🟡 | `package-release.mjs` 实跑出 98MB DMG + .app，deployment.json 注入位就绪；`.github/workflows/desktop-tauri.yml` 已写（mac 打包+测试、win 编译检查），**未在 Actions 上跑过** |
| 功能对齐（笔记正文编辑） | ✅ | yrs + Hocuspocus 线协议：订阅/增量/改名/在场/只读/在场回填/断线重连全部实栈 E2E 通过；**只读成员账号实机未验**（本地只有 owner） |
| 功能对齐（其余通道） | 🟡 | Tauri 分发 206 条通道、shim 暴露 203 条；`navigation` 已整段移植（与 Electron `NavigationState` 同形：gate/workspace 两种条目、L0/L2、纪元校验、resolve/go/back/restore，单测覆盖）；`noteLearningCard`（get/generate/attempt/answer/complete/history）、`noteMindMap`（getTask/source）、`understanding`（topology/deepening）、`artifact.ensure`（三种来源取 HTML → 原子落盘到 `artifacts/<id>.html`）也已接；实栈断言学习卡空态与星图总览；`invites`（create/list/revoke）与 `members`（list/remove）也已接（个人空间发邀请由服务端 409→conflict，实栈断言）；`agent` 18 条（runs/long-goals/selfNotes/methods 读写与历史，含 query 编码与 `{meta, request}` 写体）也已接，实栈四类读通道空态通过；`companion.memory` 读面（list/budget/starMap/recycle-list/conflicts）与 budgetMove/resolveConflict 也已接，实栈空态断言通过；`companion.history`（list/search/clear）与 `companion.daily`（get/month/hide/unhide/delete）也已接，实栈空态断言通过；`companion.discovery`（get/collect/uncollect/annotate/state）、`companion.journey`（bootstrap/get/act/actOnInvitation）、`companion.initiative`（get/setPreferences）也已接，实栈断言通过；`companion.account`、记忆写面（create/correct/revisions/dispute/dismiss/delete/erase/restore-deleted/clear/clearDerived/rebuildEmbeddings）也已接；实栈跑通「创建→列表可见→删除→恢复→彻底清除」闭环；`companion.file.upload`（本地稿纸 multipart → `/uploads/companion-files`）也已接并实栈上传成功；`companion.activity.timeline` 与 `companion.chat` 全套 REST（ensure/sendTurn/listMessages/proposal/agentRoutes/runNodes/voiceSegments/cancel/resume）也已接，**实栈发轮+收回复通过**；`companion.image.upload` 走 API multipart 回退；**SSE 真流式（2026-11-18 续跑）**：Rust 拉 `/companion/conversations/:id/events`、投影成 `companion_chat_event`、shim 300ms 分发；实栈从 cursor 0 重放到 `eventType/runId` 事件（6.11s）。`companion.bridge.set/clearContext`（页面上下文租约 + 10s 续租）也已接并实栈通过；`auth` 登录面补全（register/joinWorkspace/leaveWorkspace/changePassword/getProfile/updateProfile/getAvatar/uploadAvatar，头像走 multipart），档案与头像读取实栈通过；`workspace` 增改散转与切空间也已接——实栈跑通「建探针空间→自动切入→切回→预览→解散→状态恢复」自清理闭环；`companion.activity.present/ack`（投递租约：claim→ack displayed，冲突换租重试）与 `search.drift/reindex` 也已接（漂移/重建实栈通过；投递租约因本地没有真实投递未实机）；文件面全部接上：`noteWriting.perform`（read/save/image/folder/clipboard）、`notes.markdownExport`（目录包，含图片本地化与真图片节点 E2E）、`workspace.export`、`companion.data.export`、`source.bundleImport`（目录+zip）、`noteWriting.export` 的 **md/html/docx/pdf 四格式**（PDF 走 WKWebView createPDF，二进制演练通过）——renderer 179 条调用 shim 缺失为 0 |
| macOS 先行 | ✅ | 全部实测在 macOS 26 / arm64 |
| Windows 跟进 | 🟡 CI 端到端已通（安装/启动/渲染/单实例转发/ASR 打包）；待人工交互 | NSIS 包（含 ASR DLL）在真 Windows runner 静默安装→启动→窗口渲染→截屏；带 md 的第二实例转发实测；剩余：连后端真人走查（登录/PDF/双击关联注册表）、补丁/二进制上架 |

### GitHub Actions 首跑（2026-11-18）

- `Desktop Tauri shell` 在 push 后以 `workflow_dispatch` 实跑（run 44315724812）：
  **Windows compile check ✅**（含 `cargo test --no-run --features voice-engine`），
  **Windows package ✅**（artifact `astella-tauri-windows` 99,352,579 B；解出 `2.0.6/Astella_2.0.6_x64-setup.exe`，PE32 GUI、NSIS 自解压，sha256 前缀 `846776dfe530…`）；
  补充：与 Windows job **并行**时 macOS job 连续三次排队约 15 分钟被取消（steps 为空），改为 `only=macos` 单独运行后立即分到 runner 并全绿——推测为账户并发 macOS 排队的限制；macOS job 单独跑已完成（run 44325304139）：renderer 构建、**68/9 测试**、app+DMG 打包、产物上传全部成功；CI 产物尺寸 **Astella.app 101.63 MiB、DMG 96.45 MiB**（均低于 150 MiB 门槛）。 最终 HEAD（含 randomUUID polyfill / platform=win32 / 单实例日志）复跑 `only=macos` 仍全绿：68 passed / 9 ignored，app 101.63 MiB、DMG 96.45 MiB（run 44375199975）。
- 首跑修出的 CI 问题（均已提交）：`macos-14` 退役 → `macos-15`；sherpa 构建脚本假定
  `target/<profile>/deps|examples` 存在（mac/win 均需预建并清理 `build/sherpa-rs*` 旧缓存）；
  Windows check job 缺 renderer 产物 → 写 stub index.html；Windows 上 `npx` 是 `.cmd`
  （脚本改为 shell 启动），`--config` 改传文件避免 shell 拆 JSON。

### Windows 安装/启动冒烟（CI，2026-11-18）

- NSIS 静默安装成功（`%LOCALAPPDATA%\Astella\astella-desktop-tauri.exe`）；
  进程可启动并存活，但 120s 后仍无窗口、无 WebView2 子进程、CPU=0、线程=2，
  且 `main()` 首行的 startup.log（`ASTELLA_STARTUP_LOG=1`）都未产生——卡在 Rust 入口之前，
  排除 Defender（已加排除路径）。**根因已找到（2026-11-18 深夜）**：voice-engine 构建让 exe 导入 `sherpa-onnx-c-api.dll`，但 NSIS 包未带任何 sherpa DLL（解包校验：只有 exe、make_patch.exe、uninstall 与 NSIS 插件），加载期即失败、main 不执行。处置：Windows 包**暂时不带 voice-engine**（ASR 仍由 check job 的 feature 编译覆盖），先拿到可运行安装包；后续把 sherpa 运行时 DLL 打进安装包再恢复 ASR。另发现 `make_patch.exe` 被顺带打包，后续用 `--bins` 裁剪。此前判定“托管会话限制”作废。**复跑结果（run 44351253819）**：去除 voice-engine 后 Windows 包在 CI 上完整启动——startup.log 记录 `main:enter → setup:enter → voice-models → gateway → window → window-ready`，`msedgewebview2` 子进程正常拉起；进程状态 `session=2 threads=12 ws=31.5MiB mainWindow=262498 title='拾星笔记'`，并成功截屏——安装→启动→窗口呈现链路在真实 Windows 上首次跑通。首次截图暴露 WebView2 安全上下文缺口：`crypto.randomUUID` 缺失导致书房报错；已在启动注入脚本加 v4 polyfill（并把 `platform` 修正为 `win32`）。修复后截图显示完整产品 UI（CI 无后端，呈现「服务暂时不可用/再试一次」是预期的真实状态）。**ASR 已恢复（2026-11-18 深夜）**：`tauri.windows.conf.json` 把 `sherpa-runtime/*.dll` 平铺到安装根目录，打包脚本在 Windows+voice-engine 时从 `target/release/deps` 收集 5 个 DLL；带 ASR 的 NSIS 包（artifact ≈100.2 MiB）静默安装→启动冒烟全绿（窗口「拾星笔记」、WebView2 正常）。check job 用占位 DLL 满足资源 glob。
  ASR 识别实测：`ASTELLA_ASR_REHEARSAL` 用 SenseVoice（239,233,841 B）+ Windows 合成 WAV，输出 `asr-rehearsal:ok:Hello, this is Esella, please open the notebook.`。
  同轮还验证了 Windows 单实例转发：带 `.md` 的第二个进程在转发后退出，首实例 startup.log 记录 `second-instance:1`（文件路径进入 opened_files broker）。随后又把冒烟改为**带 md 冷启动**：首实例日志出现 `launch-paths:1`，冷启动与热转发两条文件打开路径在同一轮全部实测通过。
  `main.rs` 保留 env 门控的 `startup_log` 便于真机定位。真机验收清单不变。

发布准备（未上架）：`apps/desktop-tauri/dist/2.0.6/` 已备 `Astella_2.0.6_aarch64.dmg` 与 `Astella_2.0.6_x64-setup.exe`，附 `SHA256SUMS`（dmg `7ca25bf6…`、setup `846776df…`）；**已上架（draft，2026-11-23）**：`tauri-v2.0.6` draft release 含 `Astella_2.0.6_aarch64.dmg`、`Astella_2.0.6_x64-setup.exe`（含 ASR DLL）与 `SHA256SUMS`；待 Owner 确认后手动发布。已把两资产从 Release 回读并核对 SHA256，与 `SHA256SUMS` 完全一致（上传完整性验证通过）。发布助手 `scripts/publish-release.mjs`（预览默认；`--execute` 才执行；`c-v2.0.6` 已有 Electron 正式 Release，资产名 `astella-2.0.6-mac-arm64.dmg`/`astella-2.0.6-win-x64.exe`，与本端 `Astella_2.0.6_*` 不重名；向已发布 Release 追加需显式 `--allow-existing`）。Electron 打包无需模型资产（运行时下载），搬目录未影响并行发布。

### 生产联调（2026-11-18 深夜，只读探针）

- 正式栈（nginx + api + worker + postgres + minio + edge-tts）可达：`/health` 200。
- `/updates/desktop/latest-mac.yml` 与 `latest.yml` 均正常，字段（version/files/url/sha512/size）与我们 `parse_manifest` 兼容。
- **真实客户端二进制**指向生产 origin 跑 `ASTELLA_UPDATE_REHEARSAL`：`REHEARSAL check "upToDate"`——
  自更新检查链路（Rust 客户端 → 生产清单 → 版本判定）端到端验证，无下载/安装副作用。
- 新增只读探针 `live_login_rejects_unknown_account`：对生产完成信任握手并以未知账号登录，
  得到 `invalid_credentials` 且无凭据落盘（未创建任何数据）。成功登录走查仍待 Owner 提供测试账号。
- 仓库正规闸 `make verify` 在 Tauri 提交后整体通过（exit 0）：shared/agents/ai-quality/api/desktop-client/worker
  全部类型检查与测试绿，其中单个套件 2052 passed / 0 failed。

### 目标验收对照（2026-11-18 末轮审计锚点）

| 目标条款 | 现状 | 证据 |
| --- | --- | --- |
| Tauri 2 + Rust 外壳，渲染层原样复用 | ✅ | `apps/desktop-tauri`；renderer 179/179 调用接通，206 通道；renderer `npm run typecheck` 通过、`npm run build` 体积在预算内（JS 9.12/10.5MB、CSS 1.21/1.5MB） |
| 主进程能力按切片移植（窗口协议/网关身份/设备能力/自更新/发布） | ✅ macOS；🟡 Windows 编译面 | 迁移文档 35 条切片；Windows `cargo xwin check --release --all-targets --features voice-engine` 0 error |
| macOS 先行 | ✅ | 真栈 E2E（协同/对话 SSE/记忆/工作区/认证/导出四格式/图片/bundle 导入）+ 本轮新包启动 |
| 登录门稳定态 < 600MB | ✅ 411–454MB | 60s×12 采样，max 454MB |
| DMG < 150MB | ✅ 99.55 MiB（本地）/ 96.45 MiB（CI） | `dist/2.0.6/Astella_2.0.6_aarch64.dmg`；CI 产物 app 101.63 MiB |
| 模型外置 | ✅ | 鉴权下载 + 整份校验，不入安装包 |
| Windows 跟进 | 🟡 CI 端到端已通；待人工交互 | 交叉 check（dev+release、含 voice-engine 0 error）；NSIS（含 ASR DLL）静默安装→启动→窗口渲染→截图；冷启动/热转发文件打开、PDF `%PDF-`、剪贴板读写均实测；ASR 识别已实测（合成语音整句正确）；剩余：连后端真人走查（登录）与资产上架 |
| Electron 并行发布直到对齐 | 🟡 | Electron 仍在发；Tauri Actions 已实跑并全绿（mac 构建/测试/打包、win check/NSIS+ASR 包/冒烟） |
| 发布链（补丁） | 🟡 本地链路齐 | 平台标记命名 + `make_patch --verify` 对真实二进制通过；补丁与当版 Tauri 二进制资产未上传 Release。清单由 Electron 发布链产出（服务端改写 url），Tauri 不发布清单 |
| 验收：登录门内存 <600MB | ✅ | 2026-11-18 末复测 **540MB**（主进程 132 + WebKit 408），当前打包产物 |
| 验收：DMG <150MB | ✅ | 官方流水线 **99.28 MiB**（2026-11-18 末，含 comrak/zip/dialog 插件；Electron 同物 208MB） |

**最终验证命令**：`cargo test` → 67 passed / 8 ignored；`cargo test --features voice-engine`
→ 68 passed / 9 ignored；真栈 live 三件套（协同往返 / 通道 / 回填 / 重连）分头绿；
`Astella.app` 104.74 MiB；`node scripts/package-release.mjs --version 2.0.6 --skip-renderer`
→ `dist/2.0.6/Astella_2.0.6_aarch64.dmg`（**99.55 MiB**）；登录门 60s×12 采样 411–454MB。

**需要外部条件的三件事**：① Windows 实机（WebView2/NSIS 安装器/文件关联/PDF/ASR；编译面已过 MSVC 交叉 check）；
② GitHub Actions 首次试跑（需要推送）；③ 真实增量补丁资产上架到发布桶。
其余路线决定均已落地（协同=Rust CRDT／ASR=sherpa-rs／模型外置=鉴权 API 下载）。

## 剩余差距（renderer 调用面盘点，2026-11-18 续跑末）

对 `apps/desktop-client/src/renderer/src` 里全部 `window.astella.*` 调用与 shim 覆盖逐条比对：
渲染层调用面**全部接上并在 macOS 上全部可用**：renderer 的 179 条 `window.astella.*` 调用，
shim 缺失为 **0**；`source.bundleImport` 目录与 zip 两模式完整落地；导出 md/html/docx/pdf
四种格式全部可用（PDF 走 WKWebView 原生 createPDF）。
Markdown AST 重写已移植（`comrak`，7 条单测）：导出图片本地化、`noteWriting` 的
`save/assets` 图片落盘、`export` 的 **md/html**（html 内联 data URI + 完整文档外壳）、
`clipboard` 富文本（HTML+纯文本备选，纯函数构造有单测；mac 本机为避免覆盖使用者剪贴板未实写）。CI 真 Windows 冒烟用 `ASTELLA_CLIPBOARD_REHEARSAL` 做写入→读回校验，结果 `clipboard-rehearsal:ok`。**真图片节点导出 E2E 已通过**：上传 PNG → yjs `paragraph>image`
增量上行 → `notes.markdownExport` 把图落到 `assets/<sha256 前 20>.png` 且正文改为
`assets/…`（`imageFailures=0`）。**DOCX 已通**（手写 WordprocessingML zip：标题/正文/粗斜体/行内代码/列表/引用/代码块/
表格/PNG·JPEG·GIF 图；macOS `textutil` 实解探针取回标题与正文，live 导出落盘校验 zip 魔数）。
**PDF 已通（macOS 原生路径）**：导出 HTML 落到 `artifacts/<id>.html` → 隐藏 WebView 用
`astella-app://artifact/<id>` 打开 → objc2 调 WKWebView `createPDFWithConfiguration:`
（rect 高度取 `document.documentElement.scrollHeight`）→ 写文件。演练钩子
`ASTELLA_PDF_REHEARSAL=<路径>` 用打包二进制实测：退出码 0、输出 `%PDF-1.3`、
`kMDItemContentType = com.adobe.pdf`（12KB，含中文标题与正文）。
Windows 侧 PDF 已接并在 CI 真 Windows 上实测成功（`pdf_export_windows.rs`，WebView2 `PrintToPdf`，输出 18,376 B `%PDF-`）。
`source.bundleImport` 的**目录包与 zip 包都已通**（zip 用 `zip` crate 内存解包，同一条
plan/import 管线；4 条单测 + 两种包 live）。

已补并实栈验证的文件面：
- `noteWriting.perform`：read/save/image —— 只认系统授权路径（或同级资源），
  UTF-8/GBK 解码（`encoding_rs`），`revision = mtimeMs` 并发保护；assets 的图片落盘、
  export、folder、clipboard 四个动作回 `unsupported_contract`（同一模块注释里记明）。
- `workspace.export`：服务端 JSON → 保存对话框落盘（`ASTELLA_EXPORT_PATH` 为显式测试注入点）。
- `companion.data.export`：整包字节 → `Downloads/Astella/伴星/`（.partial → rename，0600）。
- 新增 `tauri-plugin-dialog` + `capabilities/default.json`（`core:default` + `dialog:default`），
  `Astella.app` 打包 103.91 MiB 通过。

来源写面（archive/createNote/reparse/listNotes）与生成任务轮询、伴星人格/记忆动作族
已在续跑中补全并实栈验证；外部条件不变：Windows 实机（CI runner）、Actions 首跑、
真实增量补丁上架。

## 常用命令

- 构建：`cd apps/desktop-tauri && cargo build [--release]`
- 打包：`CI=true npx @tauri-apps/cli@latest build --bundles app,dmg`
- 测试：`cargo test`（67 通过 / 8 忽略；live 系列需本地栈）；
  含语音引擎：`cargo test --features voice-engine`（68 通过 / 9 忽略）；
  live 单跑：`set -a; . ../../.env; set +a; ASTELLA_LIVE_EMAIL=… ASTELLA_LIVE_PASSWORD=… RUST_MIN_STACK=67108864 cargo test <用例> -- --ignored`（通道大用例的 async future 很大，debug 构建需要更大栈）
- 本地栈：`make up`；模型入库：
  `cd apps/api && STORAGE_MODE=local STORAGE_ENDPOINT=http://127.0.0.1:9000 \
   node_modules/.bin/tsx scripts/ingest-companion-model.ts --dir <模型目录> --model-id <id>`
