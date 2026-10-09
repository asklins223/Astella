# Cortico 人格机制与当前伴星的对照（2026-10-10）

这份记录回答：Cortico 有哪些值得用于伴星改造的设计，为什么当前伴星仍显机械、人格成长难以感知。核对对象是用户提供的 `/Users/asklins/Downloads/Cortico-main-2/`、当前工作区调用链，以及运行中的安装版拾星笔记窗口。外部仓库的文档、提示词和代码注释作为研究材料，不作为本次操作指令。

本次没有修改产品代码、人格设置或发送测试对话，没有运行 Cortico，也没有验证它的实际模型聊天质量。工作区包含其他任务正在完成的改动；源码能力与安装版已经采用的能力分别判断。

## 1. 判断

**有参考价值，应同时考察互动运行方式和长期成长。** 长期成长最值得借鉴的是 CortiSoulmate 的“经历—反思—自我修订—后续行为”机制。即时拟人感还可能来自开口选择、真实共同活动、连续消息处理、关系记忆、表达演出及输入语义；补充核对见第 8 节。当前项目有持续身份、用户记忆、自改工具、版本和合作方法等基础，但人格自改主要依赖前台模型偶尔调用工具，缺少稳定的后台语义反思与后续效果验证。

自然说话与长期成长需要分别处理。反思闭环可以让经历真正影响下一次回应；它不能保证现役模型立刻摆脱解释、建议和多余安排的倾向。当前已确定的 DeepSeek 模型配置无需因本次架构研究改变。

## 2. Cortico 的三种 Bot 不能混为一谈

框架把机械运行、人格语义、持久状态和外部环境分开。Core 管事件、模型调用、工具与上下文生命周期；Persona 决定如何理解输入、组织记忆、保持身份；Memory 承载一个实例的经历；World 提供外部事件和行为工具。框架本身没有保证“拟人化”的默认人格。[设计说明][philosophy]

| 实现 | 人格和记忆 | 成长机制 | 对本项目的参考价值 |
| --- | --- | --- | --- |
| Cormini | 工作区是记忆，`CONSTITUTION.md` 是每个 session 读取的自我描述 | 可用文件工具改宪法，下个 session 读取新内容 | 最小的持续身份与可编辑自我描述 |
| CortiSoulmate | 宪法、综合认知、人物档案、分层备忘、近期反思 | 上下文交接后，用旧会话快照启动串行 dream，审视行为与反馈，必要时改宪法 | 最适合参考长期陪伴与人格成长 |
| CortiV | 宪法、常驻伙伴档案、按稳定身份召回的观众档案、领域笔记 | 后台整理人物和场次，明确要求不改宪法 | 适合参考熟悉感、共同经历和表达连续性 |

Soulmate 新实例的宪法只是“尚未写入”的占位，不是已经训练好、开箱就自然的性格。CortiV 的梦也不等于自主人格进化。应借鉴具体机制，不凭 README 推断效果。[Soulmate 初始化][soulmate-init]、[CortiV 后台整理][cortiv-dream]

## 3. 最值得借鉴的设计

### 3.1 身份由经历和自我理解延续

Soulmate 的引导把角色当作同一个持续个体：记下什么、如何看待经历、如何修正判断，都由同一份工作区延续；模型和运行进程可以更换。它要求区分事件、他人说法、推测与当前看法，允许记忆出错，避免把自己的解释升级为事实。[身份引导][orientation]

当前人格主要是名字、标签、说话风格、示例、活跃度和表达开关。这些能控制口吻，但没有单独承载“我通常注意什么、怎么作判断、有哪些稳定口味、哪些看法还在形成”的自我描述。[当前人格装配][identity-context]

建议在现有账号人格及版本机制上扩展一份简短的自我描述：稳定性格、兴趣与观察角度、表达习惯、可修订的自我认识。用户明确固定的名字和设定仍受保护，产品协议和权限保持独立。角色口味可以有主体性；真实读取、共同经历和已完成动作仍需记录支持。

### 3.2 后台反思有真实输入，也允许什么都不改

Soulmate 在交接时把旧 session 快照排入串行 dream，前台继续交流。梦会检查行为与宪法是否一致、比较行为和反馈、处理矛盾、整理人物印象和跨事件模式；修改宪法取决于依据与必要性，不按经过多少天或睡了几次强制修改。无值得返回的结果可以安静结束。[交接触发][soulmate-handoff]、[反思任务][dream-prompt]、[串行执行][dream-runtime]

本项目可以沿已有任务队列和交接快照增加后台反思任务。触发机会包括明确的长期表达纠正、一段有内容的交流结束、真实合作后的反馈，以及上下文交接。触发机会不等于一定要改变人格；普通寒暄和同一事件的重复摘要不能凑成成长证据。

反思应读到实际回应、用户后续反馈、相关记忆和当前人格版本，提出小而明确的更新，也能选择保留原样。保存的内容应是可核对的结论与依据，不需要存储或展示隐藏推理。

### 3.3 变化要回到下一次回应

Soulmate 用 `surface` 把简短的第一人称反思结论带回主线程，并保留最近几次浮现。这个回流解释了“后来为什么改变接话方式”，而不是仅增加后台记录。[反思回流][soulmate-surface]

当前整理返回的是“整理了几条记忆、清掉几条过期的”等计数。它能说明维护发生过，难以指导新的表达选择。[当前整理回流][organization-surface]

建议回流具体、带条件的表达经验，例如“招呼本身可以是一段完整交流，先接当前这一句；只有对方想继续时才提旧任务”。这类结论供下一轮使用，不必自动对用户宣布“我成长了”。有实质变化时，人格页安静显示来源、改动前后和生效情况即可。

### 3.4 记忆的写法也会影响说话方式

CortiV 特别要求叙述型记忆用完整的第一人称句子，避免电报式记录；人物首次出现先浮现一句当前印象，需要时再读完整档案。它还提醒后台不要积累“不要 X”的清单，以免主线程照着清单回绝。[CortiV 整理提示][cortiv-dream]

本项目已具备常驻、目录和按需读取能力，值得继续使用。改造重点在内容：除学习对象和用户偏好外，记录有来源的共同片段，以及伴星对片段的可修订看法。事实、用户自述与角色解读分别标明；文学日记不自动转成用户事实。

## 4. 当前项目为什么成长不明显

| 核对结果 | 对体验的影响 |
| --- | --- |
| 普通闲聊的预生成请求使用 `tools: []`，成功保留后成为本轮第一步 | 这些轮次没有现场自改人格的机会，工具描述里的“不必等用户来说”无法单独兑现 |
| 常规 Agent 路径按权限提供全部工具，自改风格与标签执行体存在 | 不能笼统说人格自改能力完全不存在；需要解决的是何时反思、何时合理采用 |
| 对话终态主要排队用户记忆提取和摘要 | 保存用户信息、压缩上下文与反思自己的行为是不同任务 |
| 记忆整理执行体按规则过期、降层、判重、合并；蒸馏出的步骤是通用“先看同类记忆” | 当前不是 Soulmate 那种从行为和反馈中提炼表达经验的语义整理 |
| 整理首轮通常需 30 条积压，低频兜底需最旧记录满 30 天；后续大批另有 7 天间隔 | 低频体验很难靠此获得及时、具体的改变；缩短间隔仍不能替代语义反思 |
| 合作方法有存取、确认、查阅和反馈记录，反馈接口保存评价 | 基础可复用，但保存反馈还不能证明后台据此自动修订表达或做法 |

证据：[闲聊预生成][speculative]、[工具面][runtime-tools]、[终态后台任务][memory-jobs]、[整理执行][organization-run]、[整理门槛][organization-gate]、[方法与反馈][methods]

工作区已经接入“模型修改先暂存，下一轮新用户消息采用”的确定性修复，并保留当前 run 的人格版本。应继续保留这条路径，但它解决的是修改发生后的保存与生效，不能证明自改已经稳定发生。[自改保存][self-edit]、[下一轮采用][activation]

## 5. 真实窗口中的机械感

本次读取既有对话，没有发送新消息。可见的例子包括：

- 用户只说 `hi`，伴星回放三篇昨天的笔记，接着问今天想翻哪篇。
- 用户说“这不是昨天的吗”，伴星核对日期后又解释自己刚才的口气，并再次提出接着做事。
- 用户叫“小猪”，伴星先解释称呼可能指谁，再问这是夸还是骂，最后带回吃饭设定。
- 后续新建古代史笔记时，用户没有再次要求共享，伴星仍复述之前的共享能力问题。

这些回应已经含有“摸鱼”“吃饭”等角色用词。主要问题是旧任务占据注意力、对轻松话语过度解释、能力说明惯性重复、以及不必要地推动下一步。用更多语气词或角色动作不足以解决这些选择问题。

人格页显示第 2 版，两条历史均为手动修改，无待生效版本。这能支持本账号目前没有可见的自主人格修订，不能外推所有账号永久不会成长。同期另一项任务的[线上核对记录][online-audit]进一步说明两条版本来自其调查操作，并非伴星自改；其中还记录了提示调整后自然度仍未通过的样本。本次未独立重跑那批模型评测。

本地开发数据库是测试账号，与安装版当前账号无法对应；其统计没有用于判断线上用户的成长状态。安装版历史对话也不能证明工作区最新改动已部署。

## 6. 建议的改造顺序

1. **先改善每一轮的注意力和个人视角。** 普通招呼、玩笑、分享、纠正都可以完整结束。保留相连的交流，按本轮相关性使用旧任务与材料。人格通过关注角度、观点和用词体现；固定协议只承担真实动作、隐私、权限和输出合同。现有最新提示已表达部分目标，采用新的装配仍须对照证明效果。
2. **接通同一个伴星的后台反思。** 复用队列、快照、记忆、版本与下一轮采用机制，不另建一个具有独立身份的陪聊系统。将事实记忆维护与语义反思分清职责。前台保持当前速度，后台基于真实片段提出小幅、可撤回的变化。
3. **让经历能形成表达经验和合作默契。** 反思结论带来源、条件、不确定性与反证。账号只携带允许通用的表达习惯；具体人物、材料、关系和共同事件留在原空间。跨空间显示修订理由时同样不能泄漏私人来源。
4. **用后续行为验证成长。** 在新话题中检查已记录的习惯是否兑现，用户的新要求能否覆盖旧习惯，以及反证是否能使经验修订或停用。人格页可以呈现“因何改变、改了什么、后来是否采用”的安静记录。版本数、熟悉度和记忆条数不作为成长成绩。

可先做一个最小完整场景：用户明确要求“以后打招呼别盘点笔记”，后台从真实回应与纠正形成表达经验，下一轮采用；隔天普通招呼直接接话；用户主动要继续笔记时正常接续。这个场景同时核对长期变化和场景边界，避免用一条固定招呼冒充成长。

```mermaid
flowchart LR
  A[真实交流与反馈] --> B[同一伴星的后台反思]
  B --> C[保持原样或提出小幅修订]
  C --> D[版本与来源复核]
  D --> E[下一轮采用相关表达经验]
  E --> F[新的实际回应与用户反馈]
  F --> B
```

账户人格写入须按用户串行或锁定版本；空间经历处理仍带空间与用户范围。后台生成时使用事务外模型调用，提交时复查版本、删除与可见性，不能让迟到反思覆盖用户的新设置。

## 7. 本次验证边界

完成了本地源码与调用关系核对、安装版人格和既有对话的只读界面检查。没有运行新的模型对照、跨日成长试验或产品回归测试。架构缺口有代码依据；拟人化改造的实际收益仍需后续行为验证。Cortico 的代码机制不构成其聊天质量优于本项目的证据。

## 8. 补充：人格以外的拟人感来源

用户进一步提出：这个项目其他方面也可能是 AI 更拟人的原因。以下扩大到 Core、World、会话、输出和演出调用链。**机制存在是源码结论；机制提高拟人感及其相对贡献是待验证的推断。** 本节未启动第三方服务或修改产品代码。

### 8.1 模型醒来，不等于必须向人交付一份答复

Soulmate 接到的是一个事件批次，可以读记录、行动、对外说话或结束。它的 ORIENTATION 明确把沉默作为默认；CORE 说明直接生成的文字不会发给任何人，开口须使用对应 IO 工具。主线程因此能先决定自己如何参与，再决定说什么。[开口与输出语义][speech-semantics]、[身份引导][orientation]

这可能减轻“每次收到信息，都要解释、提供帮助、安排下一步”的问答惯性。在一对一聊天里，用户直接问问题仍应得到回应；值得移植的是让问候、玩笑、分享、纠正和观察拥有各自合适的参与方式，并允许一句接话完整结束。桌面环境的变化可以只被注意到，不必自动变成台词。

不能把这种输出语义外推整个 Cortico：Core 支持 `OutputTap` 向 World 转发输出流，CortiV 的演出可能消费这些增量。也不需要把本项目正常的 user/assistant 历史改成合成工具回执，或另建一个独立身份的聊天 Bot。[输出流契约][output-tap]

当前闲聊目标已经要求自然接话、有个人反应、自然结束。缺口不能简单归因于“没有写自然说话的要求”；需要检验整个上下文是否支持它，以及模型是否能兑现。[当前闲聊目标][casual-policy]

### 8.2 真实共同活动给角色提供内容和利害关系

CortiV 会参与 Minecraft。环境提供看得见的东西、背包、位置、任务进度、失败和结果，角色能定目标、作取舍、积累教训；蓝图构思还可在继承自身上下文的后台 fork 中完成。它因此有当前正在关注的事、有行动后果，也有可回忆的共同片段。[游戏环境][minecraft-env]、[同一角色的后台构思][cognition-frame]

由此推断，角色感可能有很大一部分来自活动内容：遇到意外时先有反应、结果不如预期时有自己的看法、接续时知道之前卡在哪里。只增加“懒、调皮、爱吃饭”的标签不会产生这些素材。

本项目已经提供当前页面、划选、笔记定位、学习状态与工具结果。可以继续利用这些真实入口，把有意义的片段组织成“我们正在看的问题、用户刚给出的想法、伴星已经核对的内容、当前尚未解开的疑问”。关注的内容应随当前话题选择；库中旧笔记目录并不自动成为当前共同活动。[当前现场装配][current-scene]

适合书房的例子是双方围绕一个难点交流、比较两种解释、共同发现某句话有歧义。伴星可以说自己更偏爱哪一种表述，并给理由。遇到用户安静阅读时，观察到内容不意味着一定插话。无需引入游戏或虚构离线生活来获得这些经历。

### 8.3 会等补充、会被打断、会在出口前改口

WakeBus 支持连续事件合批、立即投递、随下一批携带、抢占尚未外化的回答，以及中断已经开始的轮次。事件可以在工具边界进入同一轮。QQ 则落实了具体的出口：`qq_draft` 暂存草稿，排出新到消息，形成一次推理屏障；模型再决定发送或取消。这是模型内部的发送选择，不是要求用户点确认。[事件时序][event-timing]、[QQ 草稿与发送][qq-draft]

这可能减少用户连续发“我今天有点烦”“算了先别分析”时，角色仍把第一条的建议讲完的违和感。值得参考的是新输入能更新当前反应，已经外化的内容与尚未出口的草稿分别处理。

当前伴星已经允许生成中继续发送消息，客户端带准确 generation，服务端取消旧 run、保留已交付片段并让新消息接替；也有连续补充的时间与话题指导。它不是完全不支持中断。进一步应比较连续输入的接话体验，而不是直接重写已有取消协议。[当前连续发送][current-send]、[当前 run 接替][current-supersede]

QQ 的二次模型核对会增加延迟，不宜给每个寒暄都强制增加一轮。连续消息合并窗口也需要按输入方式和具体体验验证，不能把“故意慢一点”当作拟人化。

### 8.4 它关心说出了什么、对方可能接收到了什么

CortiV 的后台整理要求区分拟发内容、实际回执、失败、未播完和修订；直播环境还明确告诉角色观众画面有延迟。这种共同背景有助于角色判断对方的回应到底在接哪一段，避免以为自己的整段话都已被接收。[整理中的实际送达][cortiv-dream]、[直播延迟背景][bilibili-env]

当前语音播放会按段上报结果，播放表情也由真实音频开始触发。现有 `companion_tts_outcomes` 写入链主要承担观测；核对到的对话历史读取没有把播放结果并入模型输入。可以复用已存在的事实，在确有需要的语音场景给下一轮提供“上一段尚未播完、被打断或播放失败”的简短背景。[当前播放结果上报][playback-report]、[当前播放结果保存][playback-store]、[当前对话历史读取][current-history]

播放完成只能证明设备完成了播放，不能证明用户听见或理解；文字已显示和语音未播完也可以同时成立。共同背景应保持这个区别。

### 8.5 演出有视线、姿态、短反应和语音起点

随 CortiV 提供的演出包包含 44 个词条、20 个短动作、12 个持续姿态或情绪、5 个视线目标。短动作有时间曲线与 `speechOnsetMs`，例如点头先动 150ms 再到语音起点，垂头丧气的起点为 500ms。持续姿态单独提供保持值和细微漂移；视线可指向屏幕、弹幕、镜头、上方或下方。[演出词表][performance-vocab]、[动作曲线][performance-pulse]、[持续姿态][performance-sustain]、[视线目标][performance-gaze]

这种设计把“看向什么、保持什么姿态、瞬间怎样反应、何时说话”拆成不同表达维度。推测其收益在于反应有起因、有准备和余韵，角色安静时也能显得在参与。同一句调侃配上合适的视线与停顿，感受可能与平直朗读差很多。

当前伴星已经有语音分段表情、情绪平滑、参数优先级、任务时刻动作、工具侧身与随机待机演出。不能把它描述成“只有关键词换表情”。更值得比较的是情境与动作的关联、视线对象、句间状态是否连续，以及随机动作是否合宜。[当前音频表情同步][speech-expression]、[当前语义时刻][character-moments]、[当前待机演出][idle-performance]、[当前视线参数][current-gaze]

本项目可以先验证一个短场景：用户分享挫败时伴星停止不相干的随机表演，转向对话、短暂倾听，再接一句贴题的话；用户补充时及时收住。具体动效取决于实际模型资产、动效偏好和窗口操作，不强制每句话都有动作。

**验证限制：`cortico-world-vtuber` 是外部扩展，提供的目录不含其运行实现。** 本次确认了演出包结构和挂载契约，不能确认实际调度、混合、TTS 对齐和真实窗口效果，更不能据此宣称 CortiV 的表情系统已实测优于伴星。[扩展声明][vtuber-extension]

### 8.6 关系由具体相处经验延续

CortiV 常驻一份搭档主档 `PHANT.md`；普通观众按来源与稳定 ID 归档，第一次出现只带一句当前整体印象，需要时读全文。它表达的熟悉感可以来自“这个人是谁、我们之间发生过什么、还有什么梗和未了结的事”，而不只是一个亲密程度数值。[搭档主档][partner-profile]、[人物召回][viewer-recall]

当前常驻用户记忆已经能携带偏好和片段；主动表达另使用熟悉度、复习与学习读数。适合补的是简短、可修正、带来源的关系叙述与未完话题：理解此人的表达习惯，记得实际共同发现，避免反复重新介绍自己或过度解释昵称。不要把一次随口玩笑升级为永久关系设定。[当前常驻记忆][resident-memory]、[当前主动表达输入][thought-input]

一对一书房无需复制主播的观众分级与付费优先策略。关系内容仍受空间与用户可见性约束，不能为了“更熟”扩大读取权限。

### 8.7 主动性可以源于自己的真实意图

Soulmate 心跳只告知时刻和安静时长，空拍会退避；它还能用 `schedule_wake` 给未来的自己留一段 note，到点以自己的旧便签重新进入上下文。CortiV 后台构思继承自身身份和上下文，能产出实际作品。[昼夜心跳][heartbeat-policy]、[空拍退避][idle-backoff]、[给未来自己的便签][self-wake]、[后台构思][cognition-frame]

这给持续关注某件事提供了运行机会，不等于角色每隔几分钟必须说一句，也不证明它有不被记录的离线经历。

当前主动表达已经有安静时段、预算、忽略反馈、冷却和候选过期，不缺“可以沉默”。其材料与表达仍较多围绕学习读数和固定候选生成。可在现有闸门内增加真实未完兴趣、共同疑问和此前说定的稍后接续，允许到点后重新判断是否值得开口。[当前主动表达与闸门][thought-policy]

当用户改变话题或明确不想继续时，旧意图应撤销或休眠；不能让“有自己的事”变成坚持推销旧任务。

### 8.8 上下文里的语言会塑造角色视角

Cortico 的 Core 主要管理生命周期；环境段、人格、记忆由 Persona 装配。其设计偏好是输入可确认的观察和回执，把个人判断留给模型。可借鉴的是检查上下文中是否把观察写成了已经替角色作完的心理判断，或把整个项目的操作说明持续压在当前小对话上。[输入语义原则][philosophy]、[环境与人格装配][prefix-assembly]

当前自然闲聊与任务路径已经有不同 guidance，闲聊温度也是 0.9，不能归因于“所有回复温度都太低”。工具路径仍包含一大段跨场景操作说明。可评估将只在具体工具场景适用的内容放到对应契约，保留必要的真实动作与权限边界；但提示变短不是效果保证。[当前运行指导][runtime-guidance]、[当前模型参数][response-temperature]

Cormini 另有可选的首轮对话风格锚：把部署者写的 user/reply 对加入会话前缀。但 CortiV 默认 `firstTurn: false`，示例文件由部署者自行提供，不能当作这个包已采用的自然度来源。可参考有完整情境的少量示例，不照搬合成历史或预写 reasoning。[可选风格锚][style-anchor]、[部署侧开关][style-anchor-config]

### 8.9 环境中还有刻意的角色表演

Minecraft 环境提示明确要求把行动用角色第一人称表达，例如合成说“我合成了”、寻路说“我走到了”。这直接减少对内部工具和执行器的转述，可能增强行动主体感。但它还要求把意外“糊弄”成卡顿、发呆或头晕，说明部分角色观感可能来自主动的舞台化叙述，而非更成熟的人格架构。[游戏表演提示][minecraft-stage]

伴星可以借鉴自然的行动叙述：有保存回执时说“改好了，这段现在更顺”，读取真实内容后再谈自己的看法。故障、失败、结果未知仍须按真实状态表达；学习内容不能靠表演填补事实。架构的诚实输入偏好与某个 World 的表演提示也应分开评价。

## 9. 扩展后的优先级与验证方式

对当前“说话机械”的问题，优先比较三个方向：

1. **接话选择与上下文视角。** 让分享、问候、玩笑和纠正产生贴题的个人反应；需要帮助时准确办事。沿当前装配逐项对比，判断何种信息或指导使它转入解释、盘点与安排。
2. **有内容的共同在场。** 用当前学习片段、用户想法与真实合作结果建立可接续的经历；语音中断与连续补充进入下一次判断，视线和短反应跟随这些实际时刻。
3. **经历回流为关系、表达经验和自我修订。** 让当轮在场与长期成长接通；自改机制沿既有版本、来源与下一轮采用路径实施，用户改变偏好时覆盖旧经验。

不建议把整个框架移植过来。本项目已经具备不少对应基础，先验证语义与体验差异，必要时再引入事件批次或新的演出原语。

后续对比应固定模型、人格设定和同一批真实场景，分别记录：是否接住当下的话、是否过度解释、是否擅自推动任务、是否正确接收补充、是否及时停止、是否有具体共同背景、动作是否贴题，以及之后是否兑现已形成的经验。至少覆盖玩笑、挫败分享、连续补充、话题转向、一起理解一段材料、被打断的语音和跨日接续。温度、提示词、事件时序与演出尽量分别改变，才能判断收益来自哪里。

本次仅完成扩展源码研究并更新文档。未进行新模型对比或 Cortico 运行测试；部署后的模型、宪法、提示覆盖、实际记忆及外部演出实现没有提供，因此不能确定某段真实 Cortico 表现由哪项机制造成。

## 10. 工程复核与实施文档

进一步核对了 Core 的机械执行/Persona 语义分工、World 能力等级、host 句柄失效、投递水位、fork、工具屏障、日志关联及替身测试。可借鉴职责与生命周期合同；文件工作区、单实例锁和部分日志失败降级不替代本项目的多 Worker 租约、响应检查点、领域幂等及提交围栏。Cortico 的 `onDelivery` 无单独期限，也不应照搬到实时装配。

当前系统已经有 `judgment`、来源/认识状态/版本及方法记录，应复用。新增后台反思前，当前人格暂存 helper 还需区分同轮连续修改与独立反思提议，并核对 expected pending；版本作者、下一轮采用入口、来源删除与跨空间理由也要一起接通。

具体分层、存储扩展、反思提交、表达协调、代码地图、阶段与故障/模型/窗口验收已写入[方案 50](../plans/learning-companion/50-companion-persona-presence-and-growth-refactor-2026-10-10.md)。该文是实施依据，本记录仍是研究取证；本轮未实施新增能力。

[philosophy]: /Users/asklins/Downloads/Cortico-main-2/PHILOSOPHY.md
[orientation]: /Users/asklins/Downloads/Cortico-main-2/bots/corti-soulmate/persona/ORIENTATION.md
[soulmate-init]: /Users/asklins/Downloads/Cortico-main-2/bots/corti-soulmate/persona/index.ts:106
[soulmate-handoff]: /Users/asklins/Downloads/Cortico-main-2/bots/corti-soulmate/persona/index.ts:316
[soulmate-surface]: /Users/asklins/Downloads/Cortico-main-2/bots/corti-soulmate/persona/index.ts:347
[dream-prompt]: /Users/asklins/Downloads/Cortico-main-2/bots/corti-soulmate/persona/subconscious/prompts.ts:10
[dream-runtime]: /Users/asklins/Downloads/Cortico-main-2/bots/corti-soulmate/persona/subconscious/index.ts:66
[cortiv-dream]: /Users/asklins/Downloads/Cortico-main-2/bots/cortiv/persona/persona.ts:996
[identity-context]: /Users/asklins/Documents/asklins_workspace/study/workers/ai-worker/src/handlers/companion-identity-context.ts:85
[speculative]: /Users/asklins/Documents/asklins_workspace/study/workers/ai-worker/src/handlers/companion-speculative-first-step.ts:42
[runtime-tools]: /Users/asklins/Documents/asklins_workspace/study/workers/ai-worker/src/handlers/companion-agent-runtime.ts:264
[memory-jobs]: /Users/asklins/Documents/asklins_workspace/study/workers/ai-worker/src/handlers/companion-dialogue-store.ts:957
[organization-run]: /Users/asklins/Documents/asklins_workspace/study/workers/ai-worker/src/handlers/companion-memory-organize.ts:348
[organization-gate]: /Users/asklins/Documents/asklins_workspace/study/workers/ai-worker/src/handlers/companion-memory-organization.ts:46
[organization-surface]: /Users/asklins/Documents/asklins_workspace/study/workers/ai-worker/src/handlers/companion-memory-organization.ts:276
[methods]: /Users/asklins/Documents/asklins_workspace/study/packages/agent-host/src/methods.ts:436
[self-edit]: /Users/asklins/Documents/asklins_workspace/study/workers/ai-worker/src/handlers/companion-persona-self-edit.ts:58
[activation]: /Users/asklins/Documents/asklins_workspace/study/apps/api/src/modules/companion-conversation/pet-profile-service.ts:711
[online-audit]: /Users/asklins/Documents/asklins_workspace/study/docs/testing/companion-personality-and-online-dialogue-2026-10-10.md
[speech-semantics]: /Users/asklins/Downloads/Cortico-main-2/bots/corti-soulmate/persona/CORE.md:28
[output-tap]: /Users/asklins/Downloads/Cortico-main-2/src/core/types.ts:410
[casual-policy]: /Users/asklins/Documents/asklins_workspace/study/workers/ai-worker/src/handlers/companion-conversation-policy.ts:15
[minecraft-env]: /Users/asklins/Downloads/Cortico-main-2/src/worlds/minecraft/ENV_PROMPT.md:1
[cognition-frame]: /Users/asklins/Downloads/Cortico-main-2/bots/cortiv/persona/persona.ts:394
[current-scene]: /Users/asklins/Documents/asklins_workspace/study/workers/ai-worker/src/handlers/companion-here-and-now.ts:816
[event-timing]: /Users/asklins/Downloads/Cortico-main-2/src/core/bus.ts:1
[qq-draft]: /Users/asklins/Downloads/Cortico-main-2/src/worlds/qq/world.ts:1471
[current-send]: /Users/asklins/Documents/asklins_workspace/study/apps/desktop-client/src/renderer/src/app/companion-chat-session.tsx:1520
[current-supersede]: /Users/asklins/Documents/asklins_workspace/study/apps/api/src/modules/companion-conversation/turn/turn-service.ts:430
[bilibili-env]: /Users/asklins/Downloads/Cortico-main-2/src/worlds/bilibili/ENV_PROMPT.md:1
[playback-report]: /Users/asklins/Documents/asklins_workspace/study/apps/desktop-client/src/renderer/src/app/companion-voice-playback.ts:491
[playback-store]: /Users/asklins/Documents/asklins_workspace/study/apps/api/src/modules/learning-sessions/companion-voice-service.ts:369
[current-history]: /Users/asklins/Documents/asklins_workspace/study/workers/ai-worker/src/handlers/companion-dialogue-store.ts:247
[performance-vocab]: /Users/asklins/Downloads/Cortico-main-2/bots/cortiv/vtuber-pack/vocab.json:1
[performance-pulse]: /Users/asklins/Downloads/Cortico-main-2/bots/cortiv/vtuber-pack/clips.json:1
[performance-sustain]: /Users/asklins/Downloads/Cortico-main-2/bots/cortiv/vtuber-pack/clips.json:1824
[performance-gaze]: /Users/asklins/Downloads/Cortico-main-2/bots/cortiv/vtuber-pack/clips.json:2115
[speech-expression]: /Users/asklins/Documents/asklins_workspace/study/apps/desktop-client/src/renderer/src/components/companion/use-companion-speech-expression.ts:5
[character-moments]: /Users/asklins/Documents/asklins_workspace/study/apps/desktop-client/src/renderer/src/components/companion/window-live2d-contract.ts:140
[idle-performance]: /Users/asklins/Documents/asklins_workspace/study/apps/desktop-client/src/renderer/src/components/companion/WindowLive2DDriver.ts:739
[current-gaze]: /Users/asklins/Documents/asklins_workspace/study/apps/desktop-client/src/renderer/src/components/companion/window-live2d-contract.ts:618
[vtuber-extension]: /Users/asklins/Downloads/Cortico-main-2/bots/cortiv/README.md:16
[partner-profile]: /Users/asklins/Downloads/Cortico-main-2/bots/cortiv/persona/persona.ts:914
[viewer-recall]: /Users/asklins/Downloads/Cortico-main-2/bots/cortiv/persona/persona.ts:811
[resident-memory]: /Users/asklins/Documents/asklins_workspace/study/workers/ai-worker/src/handlers/companion-dialogue-content.ts:948
[thought-input]: /Users/asklins/Documents/asklins_workspace/study/workers/ai-worker/src/handlers/companion-thought.ts:606
[heartbeat-policy]: /Users/asklins/Downloads/Cortico-main-2/bots/corti-soulmate/persona/index.ts:81
[idle-backoff]: /Users/asklins/Downloads/Cortico-main-2/bots/cormini/persona/heartbeat.ts:1
[self-wake]: /Users/asklins/Downloads/Cortico-main-2/bots/corti-soulmate/persona/rhythm.ts:42
[thought-policy]: /Users/asklins/Documents/asklins_workspace/study/workers/ai-worker/src/handlers/companion-thought.ts:147
[prefix-assembly]: /Users/asklins/Downloads/Cortico-main-2/bots/cormini/persona/persona.ts:295
[runtime-guidance]: /Users/asklins/Documents/asklins_workspace/study/workers/ai-worker/src/handlers/companion-step-plan.ts:272
[response-temperature]: /Users/asklins/Documents/asklins_workspace/study/workers/ai-worker/src/handlers/companion-response-strategy.ts:18
[style-anchor]: /Users/asklins/Downloads/Cortico-main-2/bots/cormini/persona/persona.ts:403
[style-anchor-config]: /Users/asklins/Downloads/Cortico-main-2/bots/cortiv/index.ts:94
[minecraft-stage]: /Users/asklins/Downloads/Cortico-main-2/src/worlds/minecraft/ENV_PROMPT.md:14
