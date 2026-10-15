# 伴星主动交流实施与验证 · 2026-10-13

对应[方案 56](../plans/learning-companion/56-companion-initiative-and-natural-exchange-2026-10-13.md)。本轮把自由相处偏好、实际情境、关注安排、同一 Agent 的自主执行和多发言接到现役桌面／手机浏览器链路。自然分句与答后补充、相关页面／难题帮助、真实启动问候和久学休息是所有账号自带的默认行为；个人偏好用于调整，不是启用前提。

## 使用入口与实际结果

用户可直接对伴星说“以后每次启动应用都跟我问好；学久了提醒我起来走走”。Agent 可读取已有约定，依据当前用户原话保存或修订自由文本，并安排相关观察或稍后重评。遇到当前宿主无法观察或执行的条件，应说明具体限制。

桌面入口是 **伴星中心 → 人格 → 我们怎样相处**，支持编辑、保存、暂停和版本冲突后的重读，草稿保留。手机浏览器设置页读取和修改同一账号约定。暂停这份约定不会伪造用户新话语。本轮没有替真实使用账号保存问候、休息或其他偏好。

一次回答可由 `companion_publish_utterance` 发布几个完整意思，每条有实际消息 ID。原始用户回复完成后默认提供一次有限的补充考虑；内容已经完整时允许保持安静，内部补充完成不会再次自动触发补充。页面帮助依据实际已加载材料、失败或结果，不根据页面停留猜测用户遇到困难。

## 真实调用链

| 环节 | 实施内容 |
| --- | --- |
| [共享合同](../../packages/shared/src/contracts/companion-initiative-contracts.ts) | 账号自由偏好、CAS 版本、真实情境、领域事实、事件订阅、自由意图和下次重评；不是封闭的规则种类 |
| [宿主存取](../../packages/agent-host/src/participation.ts) | 本人作用域、原话来源、版本历史、观察幂等、学习区间并集、有限关注和撤回 |
| [迁移 0423](../../apps/api/src/db/migrations/0423_companion_initiative.sql) | 偏好／观察／关注／发言关系表、RLS、到期入队、内部运行输入身份与真实消息关系 |
| [API](../../apps/api/src/modules/companion-shell/participation-routes.ts) | 鉴权读取／修改约定与记录观察，偏好修改唤起理解；新用户提交接替内部考虑 |
| [主动准备](../../workers/ai-worker/src/handlers/companion-initiative.ts) | 有效租约、来源版本、同意、勿扰、正式作答、输入／播放与累计预算核对，然后使用现役 `companion_agent` |
| [工具与发布](../../workers/ai-worker/src/handlers/companion-participation-tools.ts) | 同一 Agent 读取／保存约定、安排关注和发布真实 assistant 消息；内部执行不能替用户改偏好或写业务数据 |
| [桌面观察](../../apps/desktop-client/src/renderer/src/app/use-companion-awareness.ts) | 主进程提供真实启动与锁屏／窗口状态；渲染层提供已就绪页面、学习、输入和声音状态，相关资料／学习结果提供有版本的事实 |
| [桌面消息](../../apps/desktop-client/src/renderer/src/app/companion-chat-session.tsx) | 首条主动消息通过现役收件箱引用接入 SSE，后续同一运行接续；真实消息去重、历史和整段交流回听 |
| [手机消息与观察](../../apps/mobile-client/src/state/companion.ts) | 可见文档及已加载笔记观察、现役鉴权 WS、多发言与静默终态；输入、拍照或语音起步接替内部运行 |

到点只重新给 Agent 一次判断机会。

内部输入保留 `user_message_id=NULL`，实际接受的观察以 `system`／`hostObservation` 输入；之前的交流作为历史数据提供，没有编造用户请求、工具回执或隐藏推理句柄。每次发布再次核对最新来源。选择工具发言后，最终正文只结束执行，不再重复发一条；短的“安静结束／本轮不发言”等执行收尾也不会成为聊天记录。

偏好或关注的版本写错属于已知未执行结果，返回实际版本供 Agent 修正。用户纠正、暂停、清除相关记忆、页面变化或输入接替会使旧来源失效；自己的记事更新只承认实际成功工具回执，不修改接受时的来源快照。

## 类型与定向测试

基线及实施后的 shared、agent-host、agent-core、API、worker、desktop-client、mobile-client 各包 `npm run typecheck` 通过；最后增加执行收尾保护后再次检查 worker 通过。桌面使用包自身检查入口，不使用只有 references 的根 tsconfig 推定结果。

| 范围 | 通过项数 | 本轮检查重点 |
| --- | ---: | --- |
| shared 合同与能力目录 | 47 | 新工具、内部输入身份、真实多发言／完成事件、宿主观察标记 |
| agent-host 时长单测 | 2 | 重叠学习区间只计一次、离开间隔与近期时间口径 |
| worker 定向单测 | 160 | 原生 Provider 观察边界、Agent 循环、来源核对、证据／明确数值、工具意图与安静结束 |
| API 定向单测 | 21 | 主动收件箱引用、真实运行历史回放、记忆清除撤回 |
| 桌面定向测试 | 54 | 页面就绪及版本水位、自由约定 UI、多条消息、历史状态和重连身份 |
| 手机状态测试 | 3 | 内部考虑不显示空回复、静默完成、输入接替和迟到事件、消息重连去重 |
| PostgreSQL 集成 | 48 | 主动链及现役对话／预算／恢复回归；其中主动专项 15 项 |
| 严格 RLS／权限目录 | 1 | 实际 API／worker 受限角色、策略与函数／表授权目录 |

上述共 336 项定向测试通过，没有运行全项目回归，也不是全场景自然度验收。日志归档索引见本机 `outputs/audits/2026-10-13-initiative/verification.json`。

### 实库与权限口径

集成用隔离库 `astella_initiative_20261013`，角色权限目录用没有测试积压任务的独立库 `astella_initiative_rls_20261013`。夹具准备使用实际 migrator，产品事务使用实际 worker；权限套件同时使用实际 API 和 worker。仓库隔离库脚本末尾的通用 `DATABASE_URL*` 是管理员示例，不能证明受限角色；本轮显式从 `RLS_TEST_*` 连接映射运行角色。

最终 0423 在空隔离库按事务重新应用，并重新执行权限目录检查。开发库只应用该迁移及最终必要权限差量，不在真实用户库运行清理夹具或破坏性回归。实际 API／worker 可以读取偏好历史，不能改写历史；可插入真实发言关系，不能 UPDATE 改写它。

现役长历史对话夹具原先断言整段大历史都进入提示词；基线工作区已有 2048 token 的交互历史预算。该测试同步为验证近期预算及真实原文读取，保留时间／来源证明，没有为了测试放开生产预算。

## 真实模型检查

入口是 [companion-initiative-semantic-probe.ts](../../workers/ai-worker/src/live-tests/companion-initiative-semantic-probe.ts)。它显式要求 `REAL_MODEL_BATCH=1` 和 `astella_initiative_*` 隔离库；使用合成用户原话、材料与学习事实，现役模型、治理、生产工具和持久化，没有替换模型回答。结果保存在本机 `outputs/audits/2026-10-13-initiative/companion-initiative-semantic-probe.json`，带时刻的 attempt 文件保留排障轮次，不把早期失败当作最终通过。

自然语言样本包括：

1. “每次启动问好；学久了提醒走走，不用先定分钟数”：验证两项原意都保存，并形成实际启动与学习观察／重评安排。
2. “重新打开同一篇笔记接上上次问题；答完若遗漏关键条件再补一句”：验证新增组合能用已有页面／续答能力，保存原话来源并形成订阅，没有新增专属规则类型。
3. “连续前台学习五十分钟提醒起身”：验证明确数值和前台条件保留，没有改成系统固定时长。

生产内部执行分别检查启动问候、刚开始学习的安静结束及稍后实际重评、51 分钟学习事实下的起身提醒；内部执行没有增加用户消息。51 分钟通过 68 个受限的 45 秒合成区间提供，没有让真实用户等待 51 分钟，也不是实体设备计时验收。

最终完整批次时刻为 `2026-10-13T10:06:03.151Z`，使用现役 `deepseek-v4.1-flash`：3 项自然语言约定全部通过，25 次实际 Provider 请求没有传输错误，其中三个生产内部运行合计 7 次模型调用。

| 生产内部执行 | 实际结果 | 模型调用 |
| --- | --- | ---: |
| 启动应用 | 发布实际问候消息 | 3 |
| 刚开始学习，已有问候历史 | 无 assistant 消息，保留实际稍后重评 | 2 |
| 明确五十分钟约定，提供 51 分钟前台学习事实 | 发布起身走走提醒，保留五十分钟原意 | 2 |

回执、原始正文和安排见本机 JSON 与归档索引。首轮排障发现了跨运行推理回放错误、关注 CAS 拒绝被归为不确定结果、以及模型将安静决定写成对白；修复对应输入边界、已知未执行结果与发布边界后重新执行。模型通过这些场景只能证明当次理解、持久化和执行，不能证明任意约定、所有页面或长期拟人体验。

## 真实窗口检查

使用独立的本机 Electron 预览进程、独立 profile 和新增 preload，打开已有 probe 账号的书房，进入“休息角 → 伴星中心 → 人格 → 我们怎样相处”。实际检查了显示、进入编辑、粘贴中文、键盘 Tab 到保存以及 Escape 取消后恢复编辑入口焦点；约定保持未保存状态，未修改真实账号数据。

保存、冲突重读、暂停由定向 UI 测试及隔离库工具存取覆盖；没有在真实账号窗口提交偏好或新用户回合。多发言语音段的消息身份与顺序由集成测试覆盖，没有实际听取本轮新主动消息的音频。浏览器状态测试不替代实体手机及后台验收。

桌面主进程／preload 需要重启加载新增 IPC；API 与 worker 需与共享合同同版并应用 0423。当前开发库已应用。独立预览进程已结束，其他在用开发进程保留。

## 当前边界

- 学习时长是最近四小时的实际前台学习区间估计：十五秒续租、单段最多四十五秒、跨端重叠合并、离开五分钟重置连续段。没有推断身体疲劳，也没有独立的物理休息计时器。
- 默认答后考虑每次原始用户回答最多产生一次；后续关注有来源、版本、次数、时间和成本边界，不持续空转模型。它仍增加实际调用成本，不承诺每次补充。
- 首批困难／结果事实来自资料页与学习运行；其他领域需要提供真实观察或读取工具。通用自由偏好不等于宿主可以观察任意外部环境。
- 多发言工具提交完整语义消息，尚未实现消息内部的专用增量解析器。现役单条回答的 delta／final 继续存在。
- 手机是可见浏览器能力，不能探测系统锁屏或保证关页／后台执行；原生推送、流式 TTS、实体手机软键盘及两端同时在线实际出声尚未验收。
- 没有本机固定问候降级；模型或网络不可用时不能据定时器假称已经实践用户偏好。跨日自然度、错误帮助率、不同新偏好的泛化和实际声音体验仍需持续体验验证。

## 2026-10-13 用户澄清后的默认行为复验

用户明确指出自然分句与答后补充考虑、相关页面／真实难题帮助、每次启动问候和久学休息都是新账号自带的产品行为，个人偏好只用于细化，不是启用前提。共享默认策略同时约束启动问候不推测用户的作息、饭点、专注／疲劳或环境。

- shared 默认策略测试 2 项通过；agent-host 时长测试 2 项通过；桌面空白偏好组件测试 4 项通过。
- 隔离 PostgreSQL 上主动参与集成 17 项通过，覆盖无偏好账户的启动问候、内容页机会、学习开始和答后 `reply.finished` 入队，以及真实多发言、静默、打断与去重。
- 真实模型探针专测 `built-in-defaults-without-preference`，个人偏好修订号为 0，启动观察实际经过生产 Agent／发布工具完成问候；2 次模型调用，探针通过。该单个样本不能证明各类问候都自然，也不替代长期体验验证。
- shared、agent-host、ai-worker 与 mobile-client 类型检查通过；桌面 `npm run build` 和手机 `npm run build` 通过。桌面完整 `npm run typecheck` 当前仍报 4 处现有测试类型错误，位于 `companion-chat-routing.turn-error.test.ts` 和 `companion-chat-session.history-status.test.tsx`，本次修改文件无相应报错。
- 本次只构建 workspace 产物，没有替换或安装正在使用的 App。现有 Electron 开发窗口目前显示“暂时无法打开学习空间／学习服务暂时不可用”，因此无法从真实窗口进入偏好页核对这次列表；普通浏览器直接访问 renderer dev 地址也无法注入 Electron 宿主 API。安装版当时未运行，独立的开发进程没有被重启或打断。要在安装版看到改动，还需后续打包安装；当前工作区运行需先恢复学习服务并重启桌面宿主。

## 2026-10-13 晚间复核与重做（用户判定第一版「不太行」之后）

用户复核第一版后指出：这版把「主动」做成了「事件响应」，她还是不像会自己找人说话的人。按新决定重做了开口时机、语域、输入装配、额度与可见性，八项范围一次改到底。

| 问题 | 改动 | 落点 |
| --- | --- | --- |
| 没有非事件的开口时机 | 「陪着的时候」进账号默认：人还在前台、这一阵安静下来时她可以自己想起点什么说一句、也可以问近况；到点的关注只在**真的有设备在前台**时才被消费，不在场时重新安排而不是吃掉水位 | `companion-default-participation.ts`、`0427_companion_wakes_only_when_she_is_here.sql`、`companion-initiative.ts` |
| 主动发言一律讲课腔 | 按参与依据分语域：招呼/前台/学习开始/偏好改动=陪聊（casual、温度 0.9，沿用现役「闲聊关思考」判据），页面与难题/答后看一眼=讲解，自己的关注=办事。不再为主动通道另开一档思考 | `companion-default-participation.ts` 的 `companionParticipationRegister`、`companion-initiative-observation.ts`、`companion-agent-runtime.ts` |
| 她读到的是关于聊天的报表 | 历史按真实 user/assistant 回合回放，宿主观察压成一句人话的 system 观察消息排在末尾；`initiative_input` 那份 JSON 整包、重复的禁止条款从提示里删掉 | `companion-agent-runtime.ts`、`companion-dialogue-content.ts` |
| 写死的次数与字数闸门 | 去掉主动运行 maxSteps≤8、本轮 8 次/关联链 24 次、一轮 40 条发言、同时 20 条关注、重评最早 15 秒、intent 截 4000 字符。留下的都是失控收敛形状：重复发布同一句按重复拦、活跃关注必须有唤起条件、执行政策声明的 `maxModelCalls` 继续生效 | `companion-agent-runtime.ts`、`companion-agent-events.ts`、`companion-participation-tools.ts`、`agent-host/participation.ts` |
| 成本密度反了 | 同一篇笔记在这次启动里只有一次帮忙机会（去重身份不再含正文版本与 deviceSession，版本仍在 prep 核对）；她自己新起的话题在**起运行之前**过账号声明的介入档位间隔，招呼与答后接续不受这条闸 | `agent-host/participation.ts`、`companion-initiative.ts` |
| 她说了话可能看不见 | 过了 90 秒展示窗口的主动发言仍可从「动态」跳到那句话（跳转不等于补播声音）；首条发言超过 200 字不再被挡在认领之外；目标设备为空时两台都不出声 | `companion-activity-panel.tsx`、`companion-activity-page.tsx`、`home-projection-service.ts`、`CompanionPresence.tsx` |
| 旧链路半退休 | 本轮未清理，见下方遗留 | — |

### 本轮验证

- 类型检查：shared、agent-host、ai-worker、api、desktop-client 各自 `npm run typecheck` 通过。
- 单元测试：agent-host 39/39；shared 931/932（唯一红是聊天面工具说明总量 4309 > 预算 4000，见遗留）；ai-worker 1704/1706；api 2934/2941；desktop 3604/3622。
- 新增测试：`companion-initiative-observation.test.ts`（语域与观察装配 6 项）、`companion-participation-tool-guards.test.ts`、`companion-annotation-authoring-guards.test.ts`（这两条同时把 handler 覆盖棘轮从 2 项缺口降到 0）；集测新增「到点的关注要在场」「一篇笔记一次机会」「例行机会让位于档位节奏」3 项，并把原来钉 JSON 报表形状的两条改成钉真实回放。
- PostgreSQL 集测在隔离库 `astella_initiative_fix_20261013`（全部 0427 迁移重放）上主动链 21/22 通过。

### 仍然存在的限制与红

1. **旧念想链路已摘除，数据清理已执行**：handler、调度器、API、桌面 IPC、专页、thought 语音缓存和历史重放分支已删除；0428 删除旧 jobs、送达事件与 `assistant_thoughts` 表。本机开发库曾有 192 条候选、980 条旧 job 和 64 条旧投递；已只应用 0428，复查确认旧表、调度函数、job 和投递都为零／不存在。其他部署执行 0428 前仍会保留旧数据；当前构建没有只读查看入口。该次没有连带应用待执行的 0427、0429。
2. **聊天面工具说明预算红**：新增 5 个参与工具后合计 4309 字符，超 方案52 的 4000。本轮已把三条超限说明压回单条 150 以内并消除与字段 describe 的重复，剩下的缺口要么继续压既有说明，要么按能力增长调整预算——不该由我悄悄改数字。
3. **这份集测只在超户串下跑得动**：以真实 `astella_worker` 角色跑同一文件时 `companion_stream_events` 插入被拒，12 项全红；因此「另一个用户读不到本人偏好」那条断言在超户配置下是假红（超户绕过 RLS）。主动链的真实角色权限口径目前没有覆盖。
4. **api 的两条结构红已顺手收掉**：模块环守卫点名 `companion-shell/participation-routes.ts` 直接 import `companion-conversation/turn/companion-account-epoch.ts`（第二条 shell→conversation 边）。按守卫自己的提示把账户 epoch 助手搬进中立层 `apps/api/src/companion-contracts/companion-account-epoch.ts`，重接 6 处引用与 1 处文档链接。语音档位那条散开的 `process.env` 读数改回 `config/learning-companion-flags.ts` 的函数。神文件清单：`companion-agent-runtime.ts` 从 1559 行降到 1470 行，搬出两块内聚策略——`companion-agent-step-assembly.ts`（这一步的工具面、执行政策与请求装配）与 `companion-answer-repair.ts`（退化回复的降级阶梯），判据与文案一字未改，并补了 15 条用例（那条修复阶梯此前一条测试都没有）。输出闸棘轮要求的「`looksTruncatedReply(` 仍留在运行时侧」由注入 `isTruncated` 保住，没有出现第二份判据。
5. **自然度只有机械证据**：本轮没有重跑真实模型探针，也没有真实窗口与听感验收。语域、回放装配和「陪着的时候」这条默认能不能让她说得像人，需要在 `companion-initiative-semantic-probe` 上加一个招呼/闲聊样本并在真实书房里连用一天才能定。节奏判据按当前书房的上一次主动发言计，跨书房合并需要一个 definer 函数，本轮没加。

## 2026-10-14 全量复核（旧链删完之后）

复核范围：这条链的七项行为改动、新加的 `presence.quiet` 在场闲时机会、旧念想链的删除面、三支新迁移、以及权限目录与守卫。

### 复核确认没问题的

- 七项改动都还在原位：语域分档、真实历史回放、在场才唤起、节奏拦在起运行之前、写死额度已拆、同一篇笔记一次机会、主动发言可见性。`recentDialogue` 与 `initiative_input` 那份 JSON 整包没有被改回来。
- 补上的 `presence.quiet` 接得干净：进观察合同与 `COMPANION_AWARENESS_TOPICS`、默认机会（不要求先订阅）、语域是陪聊档、节奏归 routine、单调时钟的闲时追踪（后台时间不攒机会、每次输入起新的一集）、观察 id 按集固定所以一次机会只排一次队。手机端也发同一件事。
- 旧链删除面在代码里是齐的：生成器与调度、API 两条 route、桌面手记入口与页、IPC/preload/网关、`assistant_thoughts` 与入队函数、roles.sql 五处清单同步改；`db-migrations` 那条现在把「退役表与退役函数」当真在验。聊天面工具说明预算回到 4000 内。
- 迁移日志 426 条 idx/文件名双向对齐；`0428` 的 DROP 与 `0427` 的函数替换都可重放。

### 本次修掉的

| # | 问题 | 处置 |
| --- | --- | --- |
| 1 | `.github/scripts/verify-companion-capability-config.mjs` 还要求 compose 里有 `COMPANION_THOUGHTS_V1`，而两个 compose 都已删掉它——CI 每次构建都会红 | 删表格那行与 `.env.example` 的键，连同两行讲旧开关的注释（它们当时正压在 `AUTH_RATE_LIMIT_STORE` 头上，会被读成那行的说明） |
| 2 | `0427` 的在场判据按**用户**算，prep 与读侧都按**书房**算：她在 A 房间，B 房间的关注照样被唤起，然后 prep 在本房间找不到人 → 每 60 秒空转一次自己重排 | 两个唤醒函数都加 `workspace_id` 同域条件，注释说明为什么必须同域 |
| 3 | `0427` 只在真的插入成功时清水位；一旦撞幂等键就不清，而键里带着同一个 `next_review_at` epoch → 每拍都撞同一个键，且这条永远卡在 `ORDER BY next_review_at LIMIT 50` 的队首，把新关注挤掉 | 冲突时把水位往前挪一分钟（换一个新键，下一拍必然推进） |
| 4 | 人不在场期间，过期的 active 关注永远不会被消费，也永远不会结束——正是 `0423` 要求「必须唤得起」想避免的僵尸行 | 每拍的清理段把过期 active 安排收成 `completed` |
| 5 | `0429` 四处裸 DDL 不可重放：这份文件以后再被编辑一次就会在已迁库上重跑并死在「列已存在」，`migrate` 挂 → role-grants → api 容器起不来 | 改 `IF NOT EXISTS` / 先 `DROP CONSTRAINT|TRIGGER IF EXISTS`；并在同一库上把文件重跑一遍验证（现在只发 NOTICE） |
| 6 | `0428` 两处删除有风险：`agent_operations.job_id` 对 `jobs` 是 ON DELETE RESTRICT（真被引用时迁移整体中止）；删掉某人最大的 `assistant_deliveries` 序号会让下一条送达复用序号，而客户端按序号判新旧 | jobs 删除加 `NOT EXISTS` 守卫；气泡只删已过展示窗口的行，并写明原因 |
| 7 | 节奏闸只按「她说出口的那一句」计：她安静结束时不计时，于是每闲满三分钟就再付一整轮模型——用户看到的是她隔一会儿想起一次、却什么都没说出来 | 改成按「上一次例行起意」计（含安静结束的那些次）；新增一条隔离库集测钉住（同窗口第二次不再起轮，招呼不受这条管） |
| 8 | api 的「持久唤醒消费一次」用例前提停在 `0423` 之前：还在查 `companion_reflection` job，而且没有在场租约 | 先记一条真实在场（走 `recordCompanionAwareness`，不手插 JSON），再按现合同断言唤醒进主动道；真实角色下该文件 33/33 |
| 9 | 空转守卫与死码：`0341`/`0356` 还在遍历已删除的 `assistant_thoughts`（对不存在的表永远为真）；日记素材联合里没人生产的 `"thought"`；`visibleHomeCue` 成了纯别名而注释还在说两条气泡共用头顶通道；三处注释还在讲 thought 角色 | 摘掉条目并写明理由、删死联合分支、内联别名并改注释、 roles.sql「thought worker」改指主动处理器、音频缓存与静默时段的过期行号引用改成指向实现本身 |

### 复核没解决、要单独处理的

1. **worker 的 `test:*postgres` 跑不了真实 `astella_worker` 角色**：`companion_stream_events` 第一条 `assistant.status` 插入就被拒（该表 RLS 要 `app.workspace_id/app.user_id` 对上）。这不是本条链的问题——一条老的对话集测在同一角色下同样红。`make test-postgres` 的 worker 腿因此是红的，而主 CI 只跑 `*.test.ts`，所以没人看见。上面所有集测都是用超户串跑的（跨用户 RLS 那条断言在这种情况下会假红，已改成没设受限角色时明说跳过）。
2. **`0428` 毁掉了旧念想说过的最后一份原文**：那条链只写 `assistant_thoughts.text` 与一条投递引用，从不写 `companion_messages`。按「删净，连入口一起」这是接受的代价，但对已有账号不可恢复，发布说明里要写明白。
3. `0429` 里对 `assistant_memory_item_revisions` 的 UPDATE 只有表主能跑（api/worker 被禁），挪到任何授权面后面都会坏；同一张表上现在有两个 BEFORE UPDATE 触发器，先后顺序没有写下来。属记忆那条链，留给它自己的收口。
4. 伴星落点的「语义四区」现在没有生产写入者：`setCompanionHomePlacement` 在 `CompanionPresence.tsx` 里解构后没人调用（旧调用者随念想生命周期一起删了），`room-store` 的 `companionHomeZone/companionPlacementOwner` 只能停在开机的 `rest`，`COMPANION_HOME_ANCHORS` 四区等于没用。要么接回主动发言的落点选择，要么整条收掉。
5. 还活着但没人用的导出：`companion-proactive-quota.ts` 的 `evaluateLearningSuggestion`/`LEARNING_NUDGE_KINDS` 与 `ProactiveKindV1` 的多数取值、`companion-cue-delivery.ts` 的 `opened`（唯一调用者随旧念想页一起删了，`acted` 仍从「动态」可达）。
6. 文档还有把旧闸门当现成能力写的：方案 40/40b/42/50/51；`docs/guide/zh/companion-experience.md:13` 用了 DESIGN.md 明令不再写的「我们的对话手记」，en 那侧 `agent-runtime.md:138` 夹着没翻译的中文。
7. 被节奏挡下的多条例行安排会约在同一个瞬间再醒（成本有界，不会成风暴，但也不摊开）。

### 08:45 追的两处红

- 「决定窗口的地方只有一处」：摘要器改走 `selectCompanionInteractiveReplayWindow`。看了实现，那层只是把本轮声明的容量夹成 `min(路由预算, 2048)` 再转给**同一个** `selectCompanionReplayWindow`，不是第二个按条数切尾部的口子；守卫只是把那一条 `doesNotMatch`（禁第二个切点）原样留着，加了一个名字。改法成立。
- 两份新集测的注册面：都进了 `apps/api` 的 `test:companion:postgres`，棘轮绿。
- 同一层追出的一条新红：embedding 调度把 consent 判据搬进了库内函数 `astella_enqueue_companion_memory_embedding_repair`（`0431:37-38` 有 `consent_at`/`consent_version` 两条），而守卫只读 TS 源码。已把断言搬到判据真正住的地方，并按函数名找迁移文件（不写死迁移号）；现在 2/2，worker 全量 1707/1707、shared 916/916、api 与 worker typecheck 0 错。

## 2026-10-14（下午）：主动交流"看不见"的四处收口

判据来源是库里的真实读数，不是推断：

| 读数 | 修前 | 修后 |
| --- | --- | --- |
| `assistant_deliveries` 里 `initiative:*` 的归宿 | 16 条中 **11 条停在 `queued` 直到过期** | 认领窗口 90 秒 → 2 小时（一处声明） |
| 派给别的设备的那一句 | 10 条派给 browser，桌面按严格相等静音 → 两台都不念 | 谁在小屋谁说一次，回执与跨设备租约兜住重复 |
| 她的主动成稿内容 | 17 条里 **16 条是「我不吵你／先在这儿待着」** | 政策与观察渲染点名这一类：没实事就安静收尾 |
| `study.started` | 免闸 → 13:49–13:52 四分钟连开四次 | 回到账号档位间隔 |
| 「闲下来」这道门 | 要求前台连续 3 分钟零输入，两天只报 **1 次** | 停止输入＋页面稳定（90 秒），裸移鼠标不清零 |

回归：shared 920/920、worker 1742/1742、desktop 3605/3607（剩 2 条红属于并行那一支正在加的
`learning_artifact` 路由，与本次无关；同一次 `packages/shared` typecheck 的
`AgentArtifactRefV1` 未使用报错也在那支改的文件里）。桌面与 worker 的 typecheck 干净。

**未验**：真实窗口里"回小屋补念一次"这条还没用眼睛和耳朵核过——需要跑 dev 渲染层（`make desktop` 那侧），
打包好的 App 不含今天这两处界面改动；认领窗口拉长后的堆积表现也只按读数推断。

## 2026-10-14（晚）：她从来不说，是"门开了她不开口"

用户复核仍是"做的还是不太行"。这一轮先读真实库，再在实链路上复现，最后按复现结果改。

### 真实读数（开发库 `astella`，主用账号 da64bbce）

| 读数 | 事实 |
| --- | --- |
| `presence.quiet` 运行数 | 2 条观察、**0 次运行** |
| 那 2 条观察的 `quietForMs` | 212,763 / 240,126 毫秒（契约地板 180 秒，客户端常量 90 秒） |
| 主动运行产出的 assistant 消息 | 23 条：22 条 `kind='text'`、1 条 `proactive` |
| `study.started` 成稿 | 8 条里 6 条是「我不打扰，就露个面」这一类 |
| 启动问候 | 夹着"上回那条改笔记的事我这边还卡着"；有一次直接输出了一整段笔记修改答案 |
| `initiative:*` 投递 | 22 条：9 条 `displayed`，13 条 `queued` 直到过期（那 13 条创建时桌面确实没开） |
| `companion_attention_plans` | 全库 0 条：她从来没给自己排过"回头再看一眼" |

### 实链路复现（关键证据）

手工投一条合格的 `presence.quiet` 观察（复制真实 session 的 context，前台、安静 200 秒、可参与），
用现役 worker 与现役模型跑：prep 通过、运行创建（job 80 毫秒内 `RUN-CREATED`），
她 **6.3 秒内**调用 `companion_finish_participation`，`turn.completed.silent=true`，**一句话都没说**。

所以「她从来不主动」不是链路断了，是门开之后她被告知"没有值得说的就安静结束"——
而旧观察消息的末尾正是这一句，还把她前几天的失败原话（「我先不打扰你」「我就在旁边待着」）当反面例子压在那里。

### 改了什么（详见方案 56 文末同名修正）

1. 契约地板 180 秒 → 90 秒，与客户端常量对齐；档位门槛搬到服务端 `COMPANION_QUIET_PRESENCE_MIN_MS`
   （安静 10 分／适中 3 分／活跃 90 秒）。
2. 例行间隔只按**真的产出了消息**的主动运行算；`attention.due`／`self_note.due` 不进这条闸；
   三档间隔 90 分／30 分／10 分。
3. 陪聊档默认反过来：开口是常态、安静是例外；同时点名不许把推测说成知道、不许汇报待办、
   不许编造屏幕外的生活。需要依据的场合保持原口径。
4. 启动问候不许变成接着办事。
5. 主动运行由最终正文交付的那一支也写 `kind='proactive'`。

### 修后实测（同一开发栈、同一模型、同一账号）

同一条 `presence.quiet` 观察，她发出的是一句：

> 那我先不念叨那篇笔记了。今天过得咋样？

——不再报进度，也不再自编生活。修前同一条件她说的是「我去吃饭了，你先忙你的」那一类。

同一次启动问候（`app.started`）修后是：

> 嗨，回来啦。今晚过得咋样？

### 顺带查出来的"假回执"（她说了没人接的另一半）

桌面认领主动投递时，只有运行落在当前会话里才真的把正文送进气泡；落在别的 `dialogue`
会话里时旧代码直接 `return`，**回执照发**。投影只认 `queued`/`delivered`，所以这一句
对谁都永久消失，而库里记着 `displayed`。真库实证：3 条投递的 `initiative.conversationId`
指向 `dialogue` 会话，其中 2 条在创建后 0.5–0.7 秒被写成 `displayed`——认领了，却不可能显示过。

三处修掉（`apps/desktop-client`）：回执只在正文真的进了气泡时才发（没接住的留 `queued`
等下次投影刷新）；落在别的会话里的正文用现役跨会话历史读回来；过了展示窗口仍没被接住的，
在通知中心留一枚「有几句话你还没听过 → 打开动态」的路标（不发原话、不抢焦点、一次只一枚）。

另外确认过的两件事（不改）：主动发言不经过通知中心是既定设计（`cue.origin==="initiative"`
直接 return）；过了 2 小时投递窗口的正文仍在普通对话与「伴星中心 → 对话」里读得到，
动态卡片在 `expired` 时也仍给「查看」，跳转对没有用户消息的运行有效。

### 本轮验证范围

- `packages/shared`：`companion-proactive-policy` / `companion-default-participation` /
  `companion-awareness-idle` / `companion-initiative-contracts` 四份定向测试 15/15 通过；typecheck 干净。
- `workers/ai-worker`：`companion-initiative-observation` 12/12；typecheck 干净。
- 隔离库 `astella_initiative_20261014b`（`scripts/dev-disposable-db.sh` 全量迁移）上
  `test:companion-initiative:postgres` **24/24 通过**，其中新增两条钉住新口径：
  「门槛之下的安静不算时机，且沉默不吃间隔」「她自己排的到点关注不被自己的节奏推走」，
  另一条按新间隔重写。
- `apps/desktop-client`：`companion-account-presence` 7/7、`companion-center-copy-guard` 3/3
  （三档文案的数字从 `PROACTIVE_CADENCE_MS` 现算，改映射即跟着走）；
  伴星相关定向 69 个文件 / **634 项通过**，`npm run typecheck` 干净（含上面那三处回执修复）。
- `apps/api`：本轮未改它的源码；工作区里同时有另一条锁序工作流在改
  `learning-action-bridge.ts` 等文件，与本轮无关，未触碰。
- 实链路：见上（真实模型、真实 worker、真实库；测试用的观察与运行已清理，账号状态已还原）。

**未验**：真实桌面窗口里"她说一句、气泡在她身边出现"这条仍没有用眼睛核过（桌面进程当前没在跑，
最后一个租约是 09:27 UTC）；假回执修复后的观感（跨会话读回、没有服务端语音片段时的逐字显现）
只有代码与测试证据。跨日自然度、不同档位的体感差异、以及"她主动开口"在长会话里的重复感
需要连用几天才能定。

**另外记两件本轮核对到的边界**：①「陪着的时候」现在只有桌面一个宿主在报——工作区里手机端的
浏览器原型已随原生端改造删除，`apps/mobile-client` 下（含 android/）已没有 `presence.quiet`
的生产者，方案 56 §7／§12.4 里"手机端也发同一件事"的说法相对当前工作区已过期；
②真实库里的 `browser:*` 租约是那个已删除的原型留下的，不是现役客户端。

