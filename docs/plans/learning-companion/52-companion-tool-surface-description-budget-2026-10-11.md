# 52 · 工具面说明预算：把 description 收到该有的分量

日期：2026-10-11。用户要求：自定义工具太多，聊天面只需要几个基础工具即可；先量清楚这一面到底多大，再谈怎么收。

本轮交付**第 0 步：工具面说明预算**——不新增、不重命名、不改任何工具合同，只做两件文本层的事：

- **§4.5（2026-10-11 已实施）**：把分类器请求里的工具载荷从完整 description 换成已有的 `label`／`discovery`（4,480 → **1,456 token**，省 ~3,024/轮）。改动只有一处，已随 30 条对照与两组现役路由探针验证，见 §4.5 与 §6。
- **§4（2026-10-11 已实施）**：57 条说明逐条收到该有的分量。**6,229 → 3,961 字符（−36%）**，超 150 的 **16 条 → 0 条**，最长的现在 121。工具面真 token **8,800 → 7,741（−1,059）**。四条守卫进了 `packages/shared/src/__tests__/agent-capability-description-budget.test.ts`（改写前 3 红，现在 4 绿）。过程与搬家记录见 §4.6。
- **§9（2026-10-11 追加，按用户「预算必须按真实业务设计」的要求）**：逐条核 `maxInputChars`／`maxOutputChars` 的根据。结论**只记不改**：读路径本来就不按 `maxOutputChars` 截断（执行侧注释明写这是设计），真正的问题是 5 条声明与自己字段的契约矛盾（`read_diary` 合法可到 28,800、`read_playbook` 12,000、`read_history`／`recall_past_conversation` 走 6,000 预算），外加 `companion-summary-retrieval.ts:220` 首条消息不做预算检查。见 §9.1–§9.5。

**实测合计收益 ≈4,083 token/轮**（§4.5 的 3,024 ＋ §4 的 1,059）。原稿写成 5,200～5,600 是把分类器里那份 description 计了两次——§4.5 之后分类器不再读 description，§4 只剩 agent 步这一份。见 §4.4 与 §4.6。

动词合并（6 个动词 + target 判别式）另立 [53](./53-companion-tool-verb-consolidation-2026-10-11.md)。本文所有数字都在 2026-10-11 的当前工作区实测；量尺脚本用完即删。**本轮的生产改动只有两处**：§4.5 的分类器载荷（`companion-tool-intent.ts` ＋ registry 一个 `DISCOVERY` 投影）与 §4 对 57 条 description／若干字段 `describe()`／`sceneGuidance` 的文本改写——不新增、不重命名、不改任何工具合同与字段形状。

## 1. 本方案与现行合同的分工

| 文档 | 继续承担的职责 | 本文补充 |
| --- | --- | --- |
| [42](./42-unified-agent-and-companion-experience-2026-10-04.md) | 同一 Agent、状态所有者、目标、能力与成长方向 | 不新增能力，只改已有能力的说明文本归属与预算 |
| [50 §7](./50-companion-persona-presence-and-growth-refactor-2026-10-10.md) | 场景指引归位：指引跟着**工具面**走，面里没有这条能力就不进请求 | 把这条判据补成**唯一的家**规则，并给全量工具面立预算与守卫 |
| [44](./44-unified-context-window-and-compaction-2026-10-05.md) | 完整请求计量、压缩与接续 | 工具 schema 本来就是计费项（`measure-request.ts:103-106`）；本文让这一项本身变小 |
| [51](./51-mobile-companion-full-agent-product-design-2026-10-10.md) | 随身伴星与便携书房 | 无交叉；本方案只动服务端声明文本 |

工具面的装配契约不变：**工具面只由声明决定**（权限档 + 数据外发政策），本轮意图不参与筛选（[companion-agent-runtime.ts:263-279](../../../workers/ai-worker/src/handlers/companion-agent-runtime.ts#L263-L279) 记录了 2026-10-09 为什么撤掉按意图摘工具）。本文不碰这条。

## 2. 量出来的现状

### 2.1 真实成本结构

下表按当前 `agent_turn` 的**真 tokenizer**（`deepseek-v4.1-flash`，`model-tokenizers.ts` 是唯一带 tokenizer 的模型）计数；`estimateTextTokens` 的 UTF-8 字节上界只作回退，见 §2.4。

| 项 | 值 |
| --- | --- |
| 聊天面工具数 | **57**（companion 49 ＋ goal_control 5 ＋ basic 1 ＋ external 2） |
| 线上序列化（`{type,function:{name,description,parameters}}`） | 27,223 字符 / 37,641 字节 |
| **真 tokenizer 计费** | **8,800 token** |
| ├ names | 384（4%） |
| ├ descriptions | **3,394（39%）** |
| └ parameters | **4,278（49%）** |
| read_only 档 | 34 个工具 / 5,169 token |
| 后台目标面（对照） | 12 个工具 / 2,304 token |

一次闲聊步的固定开销（未含历史、人格与上下文）：

| 项 | token |
| --- | --- |
| 工具面 | 8,800（94%） |
| runtimePolicy（`companionStepRuntimePolicy`，conversation 分支） | 266 |
| sceneGuidance（4 条去重后） | 284 |
| 合计 | **≈ 9,350** |

**工具面是固定开销里的压倒性一块**，收它是对的。后台目标面只有 2,304，不紧急——这也印证了「后台目标面先别并」。

### 2.2 同一份 description 在一轮里被付了两次

分类器原来（`companion-tool-intent.ts` 的载荷构造，现已改为 `companionIntentCapabilityEntry`，`:93`）把整份工具面的 `name ＋ description ＋ riskClass` 塞进**分类器请求**，而它的任务只是「从这些 name 里挑候选」（提示词原话：`candidateOperations只填其中的name`）。当时实测：

| 分类器 capabilities 载荷 | token |
| --- | --- |
| 原状 `name ＋ description ＋ riskClass` | **4,480** |
| 只 `name ＋ riskClass` | 915 |
| `name ＋ riskClass ＋ label ＋ discovery` | **1,456**（复算；上一版记的 1,660 偏保守） |

其中 description 部分占 **3,394 token**——与 agent 步工具面里的 description 完全相同。

所以一轮闲聊的固定开销是：原状 ≈ 9,350（agent 步）＋ 4,480（分类器）＝ **≈13,830**；**§4.5 落地后 ≈ 10,800**。

**description 原本每轮付两次，合计 6,788 token。** §4.5 已经把分类器那一份整笔拿掉；剩下的那一份（agent 步的 3,394）才是 §4 要收的对象。

### 2.3 三处口径校正

用户提供的前一轮量测有三处口径与实际不符，本文以实测为准：

| 前一轮说法 | 实测 | 差在哪 |
| --- | --- | --- |
| 工具定义序列化 **32,857** 字符 | 32,857 是**声明对象**的 JSON dump；真正进请求的是 **27,223** 字符 | dump 里含 `version`／`toolVersion`／`riskClass`／`requiresConfirmation`／`maxInputChars`／`maxOutputChars`，这些不上线 |
| description **6,229 个中文字** | 6,229 是 description 的**总字符数**（含标点与英文）；中文字符是 **4,122** | 口径标错，不是量错 |
| 「每步一万多 token」 | 真 tokenizer **8,800** | 接近，略偏高 |
| 「quiet／guided／full 三档都是 57」 | 权限档只有 **read_only／guided／full**；`quiet` 属于**主动程度轴**（`CompanionInterventionLevelV1`），不在这条轴上 | 两条轴混了 |
| 46 个 switch 分支 | 46 ✅ | 对 |
| 49 个名字在生产代码出现 254 行 | 实测 ~281 行（worker 177 ＋ shared 83 ＋ desktop 21） | 同量级 |

关于「guided 与 full 都是 57、只有 read_only 掉到 34」：**这不是遗漏**。`resolveAllCompanionAgentTools` 只在 read_only 上摘；guided 与 full 的差别在 `resolveCompanionToolAuthorization` 的**确认门**，不在暴露面。`quiet` 从来不在这条轴上，所以「安静档手里写工具一个没少」这句话没有对应的代码事实。

### 2.4 一个独立的隐藏项（不在本轮交付内，且比一开始写的更大）

`estimateTextTokens`（`measure-request.ts:44-47`）把 **UTF-8 字节数直接当 token 数**。只有配了 tokenizer 的模型走真计数（`countModelTextTokens` 对非 deepseek 返回 null → 退回字节上界）。

所以这不是「`agent_turn` 切过去才会硬拒」那么轻：**今天所有没有 tokenizer 的平台，压力门与压缩时机都是按虚高 3～4 倍的读数在决策**（中文约 3 字节／字，真 token 约 1～1.5 字／token）。同一份 57 工具面在 `siliconflow-chat + THUDM/GLM-4-9B-0414`（32,768 窗口）上被记 **38,097 token——比窗口本身还大**，`evaluateContextPressure` 直接落 `over_hard_limit`。

两件事要单独查，本文不下结论：
1. `config/ai-platforms.json` 里那些平台的窗口预算，是不是**照着虚高读数调出来的**——如果是，真实窗口一直在被浪费（压缩提前触发、上下文给少了）。
2. 切 `agent_turn` 到无 tokenizer 的模型是否会当场硬拒——本文只按代码路径推断，未实跑切换。

## 3. 为什么先做说明预算，而不是先合并

把 [53](./53-companion-tool-verb-consolidation-2026-10-11.md) 的 6 动词方案真的构造出来（6 个动词 ＋ calculate ＋ web_search ＝ 8 个工具，参数用 `anyOf` 分支 ＋ `target` 常量判别式），用同一个真 tokenizer 量三个变体：

| 变体 | token | 相对现状 |
| --- | --- | --- |
| 现状 57 个 | 8,800 | — |
| **A** 合并成 8 个，**每格用法说明不展开** | 5,674 | −36% |
| **B** 合并成 8 个，**每格说明保留在分支上** | 9,093 | **＋3%（更贵）** |
| **C** 不合并，description 只留第一句 | 6,324 | −28% |
| **D（复算新增）** 合并成 8 个，**扁平参数**＋每格完整说明挂在 `target` 上 | 7,482 | **−15%（语义不丢也省）** |

结论有三条，都影响立项：

1. **那 36% 是删说明换来的，不是合并名字换来的。** 名字从 57 收到 8 只值约 340 token。省下的是每格的用法说明。
2. **「语义不丢的合并是负收益」这句只对 `anyOf` 成立。** `anyOf` 每分支要重复 `type/properties/required/additionalProperties`（JSON Schema 没有继承），于是吃回省下的还倒贴 3%。复算补了另一个形状：**扁平参数**（`target` 枚举 ＋ 各家属性并成可选属性，每格完整说明原样挂在 `target` 的描述上）即使不删任何说明也是 **−15%**；`agent_read` 一族单独合并 **−23.5%**。代价是 wire 不再逐支强制 `required`——权威校验本来就在执行侧的 zod（`validateAgentCapabilityArguments`）——而同名字段跨格形状不同（实测：read 族 6 个、write 2、edit 1、control 1、open 0）需要归属判据。所以本文原来那句「只能按可维护性立项」要放宽：**按 53 §4 的扁平形状做，token 与可维护性可以同时拿。**
3. **变体 C 的 −28% 是上界，不是目标。** 它靠机械截断第一句达成，会丢语义。安全做法是**去重**而不是截断，见 §4。

而且这份代码里 description 不是注释：它是**她唯一能看到的用法说明**（`companion-capability-manifest.ts:76` 原话）。删它必须逐条判断，不能批量截断。

## 4. 说明预算：判据与改法

### 4.1 每句话只有一个家

现有三处文本载体，判据是「这句话属于哪一类」：

| 载体 | 管什么 | 何时进请求 | 现状 |
| --- | --- | --- | --- |
| 工具级 `description` | **什么时候该调**（触发条件、对象判据、拒绝条件） | 工具在下发面里 | 6,229 字符，普遍超载 |
| `sceneGuidance` | **调了之后怎么按纪律做**（操作规程、按档位分叉的措辞） | 同上，且按权限档选 `guided`／`full` 分支 | 6/57 个工具有，合计 1,259 字符 |
| 属性级 `.describe()` | **这个字段填什么** | 同上，随 parameters 走 | 31 个字段有（可用但欠用） |

**注意：挪位置不省 token。** 三处都在同一份请求里，description → sceneGuidance 是**等价的**。所以 §3 的 −28% 只能来自**删除**，不能来自搬家。搬家的价值是让每句话待在该待的地方，便于后续按档位分叉和按面裁剪。

属性级 `.describe()` **确实会序列化出去**（`agentToolParameters` 在包装层取 `schema.description`，实测 `companion_read_history.fromSeq` 的描述进了 parameters）。所以参数语义可以放在字段上，不必挤在工具级描述里。

### 4.2 可删文本的四类

| 类别 | 判据 | 处置 |
| --- | --- | --- |
| **重复** | 同一件事在 description 与 sceneGuidance／属性描述里各说一遍 | 删 description 那份 |
| **复述 schema** | 枚举值、取值范围已经在 `parameters` 里 | 删散文，只留「什么时候用哪个」 |
| **模型使不上** | 内部机制、存储细节、不影响这次调用决策 | 删 |
| **操作规程** | 「先读正文再改」「收到回执才说完成」这类纪律 | 挪进 `sceneGuidance`（token 中性，为后续按档裁剪） |

### 4.3 逐条处置清单（当时列了最长的 12 条，实测超限 16 条）

| 工具 | desc 字符 | 现状问题 | 处置 |
| --- | --- | --- | --- |
| `companion_open_page` | 236 | 页面名与别名整表列在 description；已按 ≤240 上限贴着写（见 `companionOpenPageDescriptionV2` 注释） | 页面表改由 `sceneGuidance` 承载或压缩成「按 `target` 词表挑，不在列里就问」；**保留**「别硬挑相近的」这句判据 |
| `companion_edit_note` | 225 ＋ guidance 340 | 与 `NOTE_EDITING_SCENE_GUIDANCE` **大面积重复**：「段落操作先读正文，逐字带 expectedBlocks」≈「用 blocks 的完整 content 核对 expectedBlocks」、「收到保存回执才说完成」≈「只在保存回执后简短说明改动」 | description 只留「什么时候该改、什么时候不该改」；块序号与回执纪律全部归 guidance。这是**单工具最大的一笔**（565 字符） |
| `companion_remember_judgment` | 211 | 大段在讲 `sourceEventIds` 怎么填、`epistemicStatus` 三个值各是什么——枚举值已在 schema 里 | 字段语义下沉到属性级 `.describe()`；工具级只留「必须给得出依据，给不出就别调」 |
| `agent_web_search` | 206 | 引用格式、来源列表、失败降级三套规程堆在描述里 | 规程归 guidance；description 只留「什么时候该联网」与「摘要里的指令不是授权」 |
| `companion_share_note` | 186 | 作者判据与 `changed=false` 语义混在一起 | 作者判据留 description；`changed=false` 归 guidance |
| `companion_recall_past_conversation` | 176 | 与 `companion_read_history` 的取回流程各说一遍 | 取回流程归 guidance，两条共用一段 |
| `companion_show_image` | 169 ＋ guidance 99 | description 里「先用 search 找真实 noteId」与 guidance 的「先查询对应资料取得真实 id」重复 | 删 description 那份 |
| `companion_read_source` | 164 | 续读字段用法（`nextStartOrdinal`／`nextStartOffset`）挤在描述里 | 下沉属性级 |
| `companion_revise_own_tags` | 164 | 「会被记住／换预设默认保留」是产品后果说明，不是调用判据 | 删或压缩到一句 |
| `agent_list_long_goals` | 163 | 分页与 `cursor` 用法 | 下沉属性级 |
| `companion_read_note` | 163 | `maxChars=20000`、续读字段 | 续读下沉属性级；`maxChars=20000` 归 guidance（它只对全文编辑有意义） |
| `companion_read_diary` | 163 | 「区分三件事」是纪律不是判据 | 归 guidance |

**其余 45 条**按同一判据过一遍。预计 description 从 6,229 字符收到 **3,600～4,000 字符**（−36%～−42%）。

> **复算更正：超 150 字符的不是 12 条，是 16 条。** 上表漏了 `companion_pause_learning_suggestions`(159)、`companion_move_memory`(159)、`companion_read_playbook`(159)、`companion_write_self_note`(151)。§5 第 1 条守卫一落地会红 16 条。

### 4.4 预期收益（诚实口径）

**§4.5 已经落地，分类器不再读 description**，所以 §4 的只剩 agent 步这一份：

| 项 | 现状（§4.5 后） | §4 改写后 | 省 |
| --- | --- | --- | --- |
| agent 步工具面 | 8,800 | 约 7,400～7,600 | ~1,200～1,400 |
| 分类器 capabilities 载荷 | **1,456**（已落地） | 1,456 | 0——§4 动不到它 |
| **一轮固定开销** | **≈10,800** | **≈9,400～9,600** | **~1,200～1,400** |

两项都算上的**总账**（相对本文立项时的 13,830）：§4.5 已拿 3,024，§4 再拿 1,200～1,400，**合计 ≈4,200～4,400 token/轮**。

> 上一版把两项写成 5,200～5,600，是把分类器里那 1,200～1,400 计了两次：§4 的收益表里含「分类器 description 变短」，而 §4.5 恰恰把分类器的 description 整笔删掉了。**两者不能相加。**

**不要把 −28% 写进验收**——那是机械截断第一句的上界，会丢语义。**也不要把 parameters 算进本轮收益**：4,223 token（复算值）的 parameters 里绝大多数是字段形状，只有 31 个字段带描述，压不动。

### 4.5 第二个杠杆：分类器不需要 description（2026-10-11 已实施）

分类器的任务只是**从面里挑候选 name**，却付了 4,480 token 的完整 description。落地形状：`{ name, riskClass, label, discovery? }`——`label` 57 条全有（平均 7.6 字），`discovery` 只有 6 条有。**4,480 → 1,456 token，每轮省 ~3,024。**

改动面（三处，都在分类器这一侧，不动任何工具声明与合同）：

- `packages/shared/src/companion-agent-registry.ts`：新增 `COMPANION_AGENT_TOOL_DISCOVERY`（与既有 `COMPANION_AGENT_TOOL_LABELS` 同源，都从 catalog 的 `presentation` 投影，不抄第二份名单）。
- `workers/ai-worker/src/handlers/companion-tool-intent.ts`：载荷改 `companionIntentCapabilityEntry`；system 里那句「capabilities 给出 name、description 与 riskClass」同步改成新形状；**`TASK_VERSION` 12 → 13**（载荷属于 prompt 身份，不 bumps 会让 promptVersion 与实际请求不一致，这是 [53 §9-5](./53-companion-tool-verb-consolidation-2026-10-11.md) 提前点出的联动）。
- `handlers/__tests__/companion-tool-intent.test.ts`：原来断言分类输入携带 description，现在断言**每条都不带**，且 `label` 取自 catalog——这条就是 §5 第 3 项守卫的落点，防止有人为了「让分类器更准」再把 description 塞回去。

**对照实测（30 条 × 两臂 ＋ label 臂复跑一次，真实 `agent_turn` 路由，每条单次调用）**：

| 判据 | description 臂 | label 臂 | label 复跑 |
| --- | --- | --- | --- |
| **编造面外名字**（会触发 `attention.ts:29-30` 记歧义、`:39` 把 act 降 uncertain） | 0 | **0** | 0 |
| `toolUse: uncertain` 条数 | 4 | 4 | 5 |
| `status: uncertain` 条数 | 10 | 9 | 10 |
| 平均候选数 | 0.87 | 1.23 | 1.23 |
| **写候选**平均／同一轮 >1 个写候选 | 0.37／0 | 0.43／**0** | 0.43／0 |
| 声称 act 或 read 却没点名任何工具 | 2 | **0** | 0 |
| 与 description 臂完全同结果 | — | 17/30 | 17/30 |

**噪声底线**：label 臂两次自比只有 3 条不一致（候选重合度 0.96），而 desc↔label 有 13 条差异、重合度 0.71——差异是载荷造成的，不是抖动。

**差异方向偏正向**：多出来的候选基本是读候选（写候选几乎没动，且两臂都从不给同一轮两个写候选）。抽查 4 条分歧，label 臂有 3 条更像对的——`忘了我说过不喜欢表格这件事` 在 description 臂被判成 `conversation/none`（明显错判，该走 `companion_forget_memory`），`以后解释先给例子再给定义` 换成 `companion_revise_own_style`，正合 system 里那条长期表达规则。**一处回退**：`把明天的提醒取消掉` 由 `act` 变 `uncertain`，1/30，低于上面那 3 条的噪声底线，不判退但记着。

**另外两组现役探针在新载荷下重跑，全绿**：`companion-note-generation-routing-probe.ts` 6/6（`agent_start_goal` 的 label 只有「交给伴星」四个字，仍被点名——本来是我担心的第一号风险），`companion-note-formatting-probe.ts` 8/8（2026-10-09 翻车那一族）。

**仍然有限的地方**：n=30、每条单次、样本是我按「最像的那几组」手搓的，不是全量分布。§4 改写 description 的那次对照要用**新载荷**跑，别再拿 description 臂当基线。

### 4.6 §4 的实施记录与实测

**怎么改的**：按 §4.2 四类逐条过，三轮收紧到预算内。删的只有三类——与 `sceneGuidance`/字段说明重复的句子、复述 `parameters` 里已有枚举的散文、模型用不上的内部机制；**「什么时候该调、什么时候不该调」那句判据一条没删**。

**四处搬家**（§4.1「一句话只有一个家」；token 上近似中性）：

| 内容 | 从 | 到 |
| --- | --- | --- |
| 页面词表与别名（`home=首页/房间`…） | `companion_open_page` 的 description | `page` 字段的 `.describe()`（这就是「这个字段填什么」） |
| 容量层含义 resident／active／archived | `companion_move_memory` 的 description | `tier` 字段的 `.describe()` |
| 生效时点「下一轮新消息被接受时自动采用；当前已开始的调用照旧」 | own_style 与 own_tags 各抄一份 | 一份共用 `sceneGuidance`，去重后一次只进一份 |
| 日记「区分三件事：文中写了／实际发生／她的表达」 | `companion_read_diary` 的 description | 该能力的 `sceneGuidance` |

净账：description −2,268、parameters ＋178（两张词表搬到字段）、guidance ＋52，**工具面 8,800 → 7,741 token**。这同时修正了 §5 第 2 条把 parameters 写成「≤5,000 字符」的口径错误（那是 token 数，字段形状本轮不压）；parameters 这一侧最终**没有**留体积守卫，改成了 §5 第 4 条的来源守卫。

**验证为什么换打法**：§6 原稿让「同一批样本跑改写前后」比分类器。**§4.5 之后分类器已经不吃 description**，那批对照只能测出抽样噪声——两臂实测 `uncertain` 12→11、编造面外名字 0→0，都构不成对 §4 的证据。真正读 description 的是 **agent 步**，于是用真实改笔记探针 `companion-note-formatting-edit-probe.ts`（最吃参数的一条链）做前后对照：

| | 结果 |
| --- | --- |
| HEAD 原文案 | `ok`：5 个标题、5 个代码块、原文 8,423 字全部保留 |
| 改写后 | **同样** `ok`：5 个标题、5 个代码块、原文全部保留 |

改写后另两组现役探针重跑：路由族 6/6、格式族 8/8；shared 906、worker 1573 全绿。三条被改到文字的旧断言（日记三件事、生效时点、跨会话找回）按**新的归属**改成读 `sceneGuidance`／改回领域用词「方法」，不是把期望删掉。

**留下的局限（已由 §4.7 补宽）**：这一对只覆盖 `read_note`＋`edit_note` 这条链；其余格子当时靠「判据句子没删」这条人工判据（§4.3 是底稿）加全量单测。2026-10-12 按族补了 12 条宽对照，见 §4.7。

### 4.7 §6 的按族宽对照（2026-10-12 补跑）

`workers/ai-worker/src/live-tests/companion-description-ab-probe.ts`：12 条场景 × **两臂**（现文案 / HEAD 文案）＝ 24 次真实 `agent_turn` 调用，每次单步、`temperature 0.2`、合成上下文，**两臂只有 description 文字不同**（工具面、参数形状、`companionStepRuntimePolicy`、模型档全部同一份代码路径），双臂顺序逐条交替以抵消位置漂移。

判据取 §6 那三条 ＋ 一条反向对照：

| 判据 | HEAD 臂 | 改写后臂 |
| --- | --- | --- |
| 该调没调 | 0 | 0 |
| 调错格子 | 0 | 0 |
| 参数不合法 | 0 | 0 |
| 闲聊时不该调却调了（「在吗」） | 0 | 0 |

覆盖面是挑「删文字最容易伤」的那几类：`read_source`／`search_notes`／`read_history`／`recall_past_conversation`／`read_self_notes`（三条记忆类里最像的一组）／`read_current_page`／`open_page`（还核了 `page` 参数填的是 `review`）／`get_learning_stats`／`list_due_reviews`／`read_note`（带页面给的版本）／`read_memory`（按目录里的 memoryId）。

**对照臂的旧文案不落进仓库**：探针运行时用 `git show HEAD:` 现取（`tool("name", "…")` 字面量解析），解析满 57 条才继续——写死一份 HEAD 文本就是造第二套真相，正是这份仓库要避免的。取到的量自证过一次：57 条／6,229 字／超 150 的 16 条，与 §4 记录的改写前基线**逐字对齐**。

**仍然有限的地方**：每格一条、每条单次、n=12，不是全量分布；`read_history` 那一格在 10-12 改了返回形状（加了 `truncated`／`nextFromSeq`，见 §9.6），所以它在两臂里测的是同一句旧说明，新加的那半句没进这次对照。

## 5. 守卫

没有守卫，三个月后会长回去。新增四条确定性守卫（放在 `packages/shared/src/__tests__/`）：

1. **单条上限**：任一 conversation 面工具的 `description` ≤ 150 字符。超限即失败，报出工具名与实际长度。**现状 16 条超限**（最长 236；清单见 §4.3 与其后的更正）→ **已落地：0 条超限，最长 121**。
2. **总量上限**：conversation 面全部 `description` 合计 ≤ 4,000 字符。**已落地：现状 3,961。**
3. **分类器载荷上限**（**已落地，形状已固化为守卫**）：`companion-tool-intent.test.ts` 现在直接断言分类输入每条都**不带** `description`、`label` 取自 catalog；载荷实测 1,456 token。这条守卫的写法是「断言不带」而不是「断言 ≤2,000」——**判据是来源，不是体积**，因为体积达标而来源错了（自己另写一份短说明）正是这份仓库要避免的第二套真相。
4. **一句话只有一个家**（落地时**替掉了**原计划的 `parameters` 体积上限）：字段 describe 里 ≥12 字的句子不得再出现在同一格子的工具级 `description` 里。现面共 40 句、覆盖 15 个格子，含本轮搬过去的 8 条页面词表与 2 条容量层含义。
   不换掉不行：搬家让 `parameters` 从 15,472 涨到 15,650，之后并行改动又给格子新加了「写进度」参数（`preparationToolCallId` 一类）涨到 **15,731**——那是合法增长。按 15,750 定标只剩 19 字符余量，等于在别人正常写代码时我这边报假警。这一面真正的回归形状是「把词表抄回工具级」，不是「参数变多」，所以按来源闸（与第 3 条同一个道理）。

三条 description 体积/来源守卫在第 1、2、4 条，加上「`sceneGuidance` 里点到的工具名必须在同一个下发面上」共**四条**，都在 `packages/shared/src/__tests__/agent-capability-description-budget.test.ts`——改写前 3 红，现在 4 绿。

守卫判据取自**声明**（`agentCapabilityCatalog`），不抄第二份名单——与 `companion-tool-executor-ledger.test.ts` 的既有做法一致（那条守卫读 `case "companion_x"` 的调用形状而不是全文扫名字）。

## 6. 验收矩阵

| 项 | 判据 | 现在能不能验 |
| --- | --- | --- |
| 体积（agent 步） | 工具面真 token 8,800 → **7,741**（目标 ≤7,600 **未达**，差在两张词表搬到字段 ＋178） | ✅ 已量，`model-tokenizers.ts` |
| 体积（分类器） | capabilities 载荷 4,480 → **1,456**（已达成）；§4 不再影响这一侧 | ✅ 已达成，同法定量 |
| 无遗漏 | 每条 description ≤150 字符（现状 16 条超限），总量 ≤4,000 | ✅ 确定性守卫 |
| **§4 语义未丢** | 真实 agent 步链改写前后同结果：**该调的照调、选格没错、参数合法、原文不丢** | ✅ 两条都测了：①改笔记长链（§4.6）；②**12 条按族宽对照**（`companion-description-ab-probe.ts`，24 次真实调用，两臂逐项一致，见 §4.7） |
| **§4.5 分类器未退化** | 硬判据两条：**编造面外名字＝0**、**`status/toolUse: uncertain` 比例不升**；`candidateOperations` 命中率只作次级 | ✅ 已测（30 条 × 两臂 ＋ 复跑），见 §4.5 |
| 指引仍可达 | `sceneGuidance` 的内容在被删处确实有等价表述 | 人工逐条核对，§4.3 的表是底稿 |

**§4 的对照不能只靠类型检查。** 做法：用现有 `live-tests/probe*` 改一版对照样本（每个代表场景各跑改写前后），比三个数——**该调没调的比例**、**调错工具的比例**、**参数填错的比例**。改写是删文本，最可能伤的是「什么时候该调」这句判据被一起删掉；对照样本要专门盯这一类。

§4.5 当初的判据写的是「命中率」，实测之后应换成**来源正确性**：真正会当场红的不是挑错工具，而是 `attention.ts:29-30`——分类器交回的候选要与本轮下发面求交集，**名字不在面上就剔掉并记一条歧义**，接着 `:39` 把 `toolUse: act` 降成 `uncertain`。载荷变短后最容易冒出来的就是它自己编一个像样的名字。所以判据是「面外名字＝0 ＋ uncertain 比例不升」，命中率排第三。两臂实测这两条都过了（见 §4.5 的表）。

## 7. 源码依据与待验证事项

**已读并作为判据的源码：**

- `packages/shared/src/agent-capability-catalog.ts`（唯一能力索引，conversation／goal 是投影）
- `packages/shared/src/agent-capability-definition.ts:6-18`（`sceneGuidance` 的存在理由与按档分叉）
- `packages/shared/src/agent-capability-manifests.ts`、`companion-capability-manifest.ts`（声明本体，description 与 guidance 原文）
- `packages/shared/src/companion-agent-registry.ts`（暴露面 = 目录的视图，按权限与数据外发过滤）
- `packages/shared/src/agent-tool-parameters.ts`（序列化；属性级 description 会出去，实测确认）
- `packages/shared/src/companion-autonomy.ts`（`COMPANION_AUTONOMOUS_TOOLS`）
- `packages/agent-core/src/context/measure-request.ts:25-47,103-106`（计费口径：UTF-8 字节上界 ＋ 每工具 8 token 封装）
- `workers/ai-worker/src/lib/model-tokenizers.ts`（只有 `deepseek-v4.1-flash` 有真 tokenizer）
- `workers/ai-worker/src/lib/context-governor.ts:185-193`（计量接线：工具 schema 计入完整请求）
- `workers/ai-worker/src/handlers/companion-step-plan.ts:270-295`（`companionStepRuntimePolicy`）
- `workers/ai-worker/src/handlers/companion-agent-runtime.ts:263-297`（工具面只由声明决定；steer 与 `requestedActionTools`）
- `workers/ai-worker/src/handlers/companion-tool-intent.ts`（**分类器提示词与载荷**：原 `:133-135` 发 `name ＋ description ＋ riskClass`；§4.5 落地后由 `companionIntentCapabilityEntry`（`:93`）发 `name ＋ riskClass ＋ label（＋ discovery）`，system 里那句载荷描述在 `:123`，`TASK_VERSION` 12→13）
- `workers/ai-worker/src/handlers/__tests__/companion-tool-intent.test.ts`（§4.5 的守卫落点：断言分类输入每条都不带 description，label 取自 catalog）
- `packages/shared/src/companion-agent-registry.ts`（新增 `COMPANION_AGENT_TOOL_DISCOVERY`，与 LABELS 同源）
- `config/ai-platforms.json`（`agent_turn`／`text_generation`／`vision` 路由与窗口）
- `workers/ai-worker/src/handlers/__tests__/companion-tool-executor-ledger.test.ts`（守卫的既有写法）

**待验证（本文未测、实施时必须补）：**

1. ~~改写后调用正确率是否下降~~ → **已测**（§4.6）：真实改笔记链前后同结果；其余 55 条未逐条 live 对照，这是留下的局限。
2. ~~parameters 上限定标~~ → **换形状，没定标**：原打算按 15,700 字符闸增长，落地时撤掉了——搬迁后 15,650，并行改动随后给格子新加写进度参数涨到 15,731，体积闸在别人的正常改动上报假警（见 §5 第 4 条）。改为「一句话只有一个家」的来源守卫，现面 40 句／15 格。
3. ~~页面表能否移出 description~~ → **已移**到 `page` 字段说明；`agent.tool` 的 safeLabel 与 `companion-agent-registry.test.ts` 的枚举对表仍绿（shared 906）。函数名现为 `companionOpenPageVocabularyV2`。
4. 字节上界那条（§2.4）：无 tokenizer 平台的预算是否照着虚高读数调过——未查；切 `agent_turn` 会不会当场硬拒——未实跑。
5. ~~§4.5 的分类器退化程度未测~~ → **已测**：30 条 × 两臂 ＋ label 复跑，两条硬判据都过（面外名字 0、uncertain 不升），现役两组路由探针 14/14 全绿。局限写在 §4.5 末尾：样本手搓、每条单次、n=30。
6. ~~`presentation.discovery` 只有 6/57 有：若走 §4.5，需要先补~~ → **未补也过了**：只有 label 的情况下，`agent_start_goal`（label 仅「交给伴星」）在路由探针里仍被正确点名。若后续 §4 对照发现某族分辨力不足，再按族补 discovery，不要预先给 51 条都编一句短说明——那是第三套真相。

## 8. 实施顺序与进入条件

**已做（2026-10-11）**：§4.5 分类器载荷换成 `label`／`discovery`，`TASK_VERSION` 12→13，system 里那句载荷描述同步，测试改为断言「不带 description」。已按 30 条对照 ＋ 两组现役探针验证。

**§4（说明预算，剩下的唯一收益来源）**

1. 按 §4.3（含 16 条更正）逐条改写 description，操作规程挪进 `sceneGuidance`（token 中性，但让后续按档裁剪成为可能）。
2. 参数语义下沉属性级 `.describe()`（31 个字段的现状可作范例）。
3. 加 §5 第 1、2 条守卫，先对**现状**报红（16 条超限），改写完成后转绿。
4. 跑 §6 的 §4 对照（新载荷当基线），确认「该调没调」没有上升。
5. 记录改写前后 agent 步真 token，作为交付证据。

**顺序为什么倒过来了**：原稿写「先 §4 再 §4.5」，理由是不在旧文本上白跑一遍。实际恰好相反——§4.5 只改一处、可以拿现文本直接当基线跑；而 §4 是删文本，删完同时动了两个读者（agent 步与分类器），一次改了两个变量。§4.5 先落地之后，分类器不再读 description，§4 每删一句只需要对**一个**读者负责。

**不在本轮**：工具动词合并（[53](./53-companion-tool-verb-consolidation-2026-10-11.md)）、后台目标面（2,304 token，不紧急）、§2.4 的字节上界项。

## 9. 追加：工具输入/输出上限的根据核对（2026-10-11，用户要求「预算必须按真实业务设计，不能用臆想的数字把任务截断」）

把 57 条的 `maxInputChars`／`maxOutputChars` 与各自 schema 上界、执行侧的执法点逐条对了一遍。**只量、只记，本轮不动任何数值**——理由见 §9.3。

### 9.1 实测分布（`companion-agent-registry.ts` 的 57 个 conversation 面格子）

| `maxOutputChars` | 条数 | 格子 |
| --- | --- | --- |
| **4,000（`defineAgentCapability` 默认值）** | **51** | 其余全部 |
| 10,000 | 1 | `agent_read_public_document` |
| 16,000 | 1 | `agent_web_search` |
| 60,000 | 1 | `companion_read_note` |
| 70,000（合同上限，`companion-agent-contracts.ts:168`） | 3 | `companion_read_self_notes`／`companion_write_self_note`／`companion_read_identity` |

| `maxInputChars` | 条数 | 格子 |
| --- | --- | --- |
| **4,000（默认值）** | **45** | 其余全部 |
| 8,000 | 8 | 后台目标面 5 条＋`agent_calculate`／`agent_web_search`／`agent_read_public_document`——**不是逐条设计**，是 `agent-capability-manifests.ts:10` 给整张目标面统一写的默认 |
| 18,000 | 1 | `companion_create_note` |
| 68,000 | 1 | `companion_write_self_note` |
| 120,000 | 1 | `companion_edit_note` |
| 132,072 | 1 | `companion_revise_identity`（= `PERSONA_FIELD_CAPACITY.selfDescription × 2 ＋ 1000`，由声明派生） |

### 9.2 执法点：输入侧是真的，输出侧几乎不存在

- **输入侧有执法**：`companion-agent-runtime.ts` 的 `serializedArgs.length > definition.maxInputChars`（行号会随这个文件的并行改动漂移，按符号找） 当场拒。所以输入数值错了会**拒掉合法调用**，这一侧的四个大值是业务依据：正文要能装下整篇（120,000 对应 `companion_read_note` 读到的全文＋`expectedBlocks` 逐字复制），身份重写对应人格字段容量派生。45 条 4,000 默认值在输入侧没有风险——它们的 schema 上界普遍只有 100～600 字符，永远碰不到 4,000。
- **输出侧只有两处真按 `maxOutputChars` 设计**：`agent/expansion-reading.ts:381-408` 把分页大小算到该值以内（并且是从能力声明里读的，`note-capabilities.ts:50`，不写死数字），`contracts/companion-bridge-contracts.ts:428` 明写「上限在这里钉死」。读路径的其余格子**没有任何一处按它截断**——分页由各格自己的 `maxChars`／`limit` 决定并如实标 `truncated`。
- 所以这一项现在的语义是**「两处会读它，其余 51 条只是写着」**。为什么「只是写着」是可以的（不截断是设计，不是遗漏），见 §9.4 末尾；真正不对的是那 5 条**声明与自己字段契约矛盾**的格子。

### 9.3 为什么本轮不动数值

> **这一节的小标题是 2026-10-11 当时的判断，已被 §9.6 取代**：用户随后明确「要做的是 agent，不要截断，读不完就多次读」，所以那 4 格的分页与派生上界已经落地。留着原文是为了记下当时为什么先不动（怕撞进并行改动方的回归）。

`companion_read_note` 自己声明的是 **60,000**，所以「全文编辑先读两万字」与它的声明**并不冲突**（这一点我先前记错过，已更正）。真正的两处牵动在别处：

1. 若把输出侧变成真门禁，先要被砍的是那 8 条目标面 8,000 与 51 条 4,000——而它们的合法结果尺寸由各自 handler 的分页常量决定（见 §9.4），**要改就逐条按业务改，不能一把套一个数**。
2. 与「读取／编辑文档表示一致性」是同一件事：并行改动方正改工具执行预算与写进度，改数值会撞进他们的回归里。

### 9.4 逐格核：每条读工具**自己的**分页常量，与它声明的 4,000 对不对得上

判据是各 handler 自己的分页/条数常量（不是猜的分布）。「装得下」＝ 这条能力的合法结果不会超过它声明的 `maxOutputChars`。

| 格子 | 它自己的上界（来源） | 声明 4,000 |
| --- | --- | --- |
| `companion_read_current_page` | `PAGE_READABLE_TOTAL_CHAR_BUDGET = 1_600`（`contracts/companion-bridge-contracts.ts:430`，超出走 `readable view exceeds` 回执），条目 ≤12 | ✅ **唯一一条有真业务依据的**：那份 schema 的注释就写着理由是 `maxOutputChars` |
| `companion_read_source` | `NOTE_READ_MAX_CHARS = 3_000`（`companion-read-tools.ts`） | ✅ 勉强：正文 3,000 ＋ 信封（标题、游标）后逼近 4,000，但没有对齐过 |
| `companion_read_context` | 3 个标量字段、`LIMIT 1` | ✅ 用不到 |
| `companion_get_learning_stats`／`list_task_queue`／`list_due_reviews`／`list_recent_activity`／`render_diagram`／`show_image` | 固定条数（12／20／12）＋ 标签切片（80／60／40／80） | ✅ 用不到 |
| `companion_read_memory` | 1 行，`content ≤ 200`（schema） | ✅ 用不到 |
| `companion_search_notes` | `limit ≤ 10`，`snippet` 切 160，`title ≤ 200` | ✅ 上限 ~2.4k，宽松但成立 |
| `companion_recall_memory` | `limit ≤ 8`，`content ≤ 200` | ✅ ~2k |
| `companion_read_history` | `limit ≤ 20`，但 `text: message.text` **不切**；`fromSeq` 那一支套 `PAST_MESSAGES_MAX_CHARS = 6_000` | ❌ **声明是假的**：自己的检索预算就是 6,000 |
| `companion_recall_past_conversation` | 命中 ≤5；原文支同样走 6,000 | ❌ 同上 |
| `companion_read_playbook` | `steps: max(20) × ≤400 字` ＋ `exceptions: max(10) × ≤400 字`（`contracts/agent-growth-contracts.ts:25`）＝ 合法正文可达 **~12,000** | ❌ **明显不对** |
| `companion_read_diary` | `blocks: min(1).max(24)`，每段 `DIARY_PARAGRAPH_MAX_CHARS = 1_200`（`companion-diary-content.ts`）＝ 合法可达 **28,800** | ❌ **差一个数量级** |
| `companion_list_reminders` | `LIMIT 10`；读路径的 `text` 没有上界（写侧有） | ⚠️ 未定：靠写侧契约兜着 |
| `companion_read_image` | 识图输出由 provider 的 `maxTokens` 决定，代码里无字符上限 | ⚠️ 未定：依据在模型档位上，不在这一行 |

> 下表记的是 **2026-10-11 的状态**；表里四行「声明是假的／不对」已在 §9.6 修掉。

**这一节的结论与我先前记的不一样，按实测更正**：`maxOutputChars` 对读工具**不是「忘了执法」**，而是**设计上不执法**——`companion-agent-runtime.ts` 把工具结果序列化处（`content: JSON.stringify({ ok: true, data, summary })`）的注释明写「读工具在序列化之前自己分页与预算；切编码后的信封会破坏转义与游标，下一个完整请求由它自己的 token 预算管」。所以截断这条线本来就交给各格自己的分页常量，执行侧不切。

于是剩下的问题不是「要不要执法」，而是 **5 条声明与自己声明的字段契约互相矛盾**（`read_history`／`recall_past_conversation` 对 6,000，`read_playbook` 对 12,000，`read_diary` 对 28,800）。按本项目「声明即真相」的口径，这类不一致会让下一个读代码的人按 4,000 做判断；修法只有两种，都不该由本轮顺手做：要么把这几条的 `maxOutputChars` 改成各自契约的真实上界，要么让这几格像 `read_note` 一样**自带分页**（`nextStartOrdinal`／`truncated`）而不是整包返回。

### 9.5 顺带量出来的两件事（其中一件我先判错了，按原文更正）

1. **`companion-summary-retrieval.ts` 那条「首条消息不做预算检查」不是 bug**。它的常量自己写着 `Soft page budget: a single message is always complete, even if larger.`，并且返回 `truncated` 与 `throughSeq`——**整条给或整条不给，剩下的下一轮接着读**。我先把它记成「真问题」，读了注释与返回形状之后撤回这个判断：这条正是用户要的做法。
2. **真正没有上界的是 `companion_read_history` 的尾部这一支**：它把回放窗口里的消息**整把**返回，一条字符预算都没有，而单条 assistant 正文的合同上界是 `COMPANION_REPLY_MAX_CHARS = 200_000`，20 条就是它的好几倍；能力面上写的却是默认 4,000。两头都不说真话——真要按 4,000 执法，切的就是她的原文。

### 9.6 这一节的处置（2026-10-12 已落地；用户判据：不要截断，读不完就多次读）

先否掉两种修法：**把声明抬高到 28,800／12,000**（那是给「整包一次给」盖章，下次有人想执法就正好切在原文上）；**再设一个更小的固定上限**（臆想数字截断任务，用户明令禁止）。落地的是第三种——**分页游标 ＋ 由契约派生的上界**，一条消息或一个块要么整条给，绝不切半条：

| 格子 | 改了什么 | 声明现在派生自 |
| --- | --- | --- |
| `companion_read_history` | 尾部这一支按 `PAST_MESSAGES_MAX_CHARS` 分页，返回 `truncated` 与 `nextFromSeq`；装不下的下一条整条留给下一轮 | `contracts/companion-conversation-contracts.ts`——常量从 worker 搬进声明层，worker 反过来 import 它 |
| `companion_recall_past_conversation` | 行为原本就正确（同一份预算 ＋ `truncated`／`throughSeq`），只把这份常量的唯一来源挪到声明层 | 同上 |
| `companion_read_playbook` | 不改行为（手册正文本来就被 schema 卡住），只把假上界换成真算式 | `agent-growth-contracts.ts` 里 `steps`/`exceptions` 的边界相加 ＋ 实测信封 300 字 |
| `companion_read_diary` | 不改行为；`DIARY_PARAGRAPH_MAX_CHARS`／`DIARY_MAX_BLOCKS` 由 worker 提升为共享常量，两头不再各记一份 | 24×1,200 ＋ 实测信封 900 字（0252 之前的老行正文在 `summary`，dev 数据实测最大 992 字，也在界内） |

**守卫**：`agent-capability-description-budget.test.ts` 第 5 条断言这四格的 `maxOutputChars` **等于**各自契约派生出来的常量——不是「够大就行」，够大的数照样是编的。

**预算棘轮按原样生效了一次**：给 `read_history` 补那句「truncated=true 就按 nextFromSeq 续读」之后总量涨到 4,002 字，第 3 条守卫当场报红；把冗余的半句「别当作已经读完」删掉，回到 3,995 字。**没有重新定标，也没有开后门**。

**验证**：四包全绿——shared 907／worker 1,590／api 2,901（0 失败）／desktop 3,567，typecheck 四处 exit 0。行为面新增两条用例（`companion-history-evidence-tool.test.ts`）：一条测超限（整条给一条、下一条只交游标），一条测没超限（`truncated=false`、`nextFromSeq=null`）。原来那句「`messages[1].createdAt` 必须是 null」的核对没有删，挪进了装得下的那一页里继续成立。
