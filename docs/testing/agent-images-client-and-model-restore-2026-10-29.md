# Agent 原模型恢复、双端图片与最终验收

> 后续：主要语义词表的本地清理、确认链修复与当前保留边界见[2026-10-29 清理记录](./agent-lexical-cleanup-and-boundaries-2026-10-29.md)；零读取假完成、独立消息交付及草稿恢复的后续修复见[来源与实际交付记录](./agent-completion-grounding-2026-10-29.md)。本文保留当时的实施和失败状态。

日期：2026-10-29。接续[早期发布快照](./agent-completion-and-release-2026-10-29.md)。本轮按用户后续决定修复图片实际发送方式，桌面与 iOS 一起改；不让用户手动压缩或拆批，不增加意图关键词表或固定业务工具流程。

Follow-up audit: [active lexical rules and image recovery](./agent-lexical-rules-and-recovery-audit-2026-10-29.md) distinguishes remaining runtime rules from unused legacy helpers, records synthetic counterexamples, and documents subsequent local recovery/prompt fixes. Those later fixes have not been deployed; the release evidence below remains a historical snapshot.

## 当前模型与执行方式

主档恢复并保留用户原配置：`agent_turn`、`text_generation` 为 `mimo-agent / mimo-v2.6-flash`；副档为 `tokenrhythm / deepseek-v4.1-flash-1017`。部署配置文件 SHA-256 为 `7a48ce0f5ff870961e352d31f837b770d323d0e0ba9216919c8f793630e7d92d`。没有把千问、SiliconFlow Flash 或 Pro 实验模型接成当前主副模型。早期切换模型的决定已撤回，不能用那批延迟证明当前模型满足相同指标。

保持模型自主选择工具的循环：`chat / answer / work` 只决定资源档；语义判断与无工具的闲聊草稿并行，未判为闲聊的草稿不公开也不执行操作。主循环仍负责推理、工具发现、实际执行和交付，宿主管理权限、对象身份、版本、取消、幂等与真实回执。没有根据某个意图标签硬排新建、搜索、读取或修改顺序。

## 图片从客户端到模型的实际链路

桌面和 iOS 每轮最多 12 张。超过 **4 MiB** 的图片在客户端先压缩，再申请或执行对象存储上传；服务端没有承担本轮压缩。小 JPEG/PNG/GIF/WebP 保留原始字节与 MIME，较大图优先保留尺寸和较高质量，最长边最多 4096，再逐步降低质量和尺寸直到满足目标。iOS 另将 HEIC 等格式本机转为 JPEG，逐张准备，避免同时保留 12 份原始大图。

桌面从单图状态改为有序附件数组，悬浮输入器、历史抽屉、发送和乐观回显共用同一份附件。可只发图，单图失败保留其他成功图，发送失败保留附件；打开系统选择器、上传或持有附件时不再因闲置计时卸载输入器。保持输入器不再连带暂停语音。iOS 拍照、选图和裁剪统一准备流程，草稿持久化 MIME，避免重启后把小 PNG 按 JPEG 上传。

服务端按原始用户消息保留真实图片身份，实际发送时才解析对象存储字节，保留发送／未发送记录。原主模型直接接收图像像素：单批输入沿原生多模态消息；超过单批容量时自动按最多 4 张、12 MiB 打包，同一原主模型分批观察，最多并行两批，按原顺序汇合后交给主循环综合。观察结果必须完整覆盖本批身份且不能重复，不能用文件名或文本描述冒充实际识图。

分批观察仅负责读取图像；主循环的认真推理没有被一并关闭。观察缓存只在当前 run 内复用，取消与租约仍受统一调用治理。`companion_visual(read_image, assetIds)` 允许模型自主一次重读多图，每张仍经过相同的空间、用户同意和资产检查；缓存不绕过权限，也不成为操作回执。没有强制模型走固定的批量读取流程。

另修复一处重复答复：模型正文与单独的 `companion_finish` 同步返回、且 finish 省略 text 时，现在能复用当前完整正文；不再误判为空草稿后要求模型重写整段。混有业务工具的前言、旧轮回复和空正文仍不能冒充最终答复。

## 本地与客户端验证

| 检查 | 最终结果 |
| --- | --- |
| Worker 全量 | 1913/1913，跨轮旧推理停止回放后全量通过；[原始日志](./evidence/agent-images-client-2026-10-29/worker-regression-replay.log)（回退版 1912/1912 见 [revert 日志](./evidence/agent-images-client-2026-10-29/worker-regression-revert.log)；1913/1913 见 [coverage 日志](./evidence/agent-images-client-2026-10-29/worker-regression-coverage.log)；1912/1912 见 [标签修复日志](./evidence/agent-images-client-2026-10-29/worker-regression-tagfinish.log)，1906/1906 保留为[before 日志](./evidence/agent-images-client-2026-10-29/worker-regression-before-finish-schema.log)） |
| Shared 全量 | 543/543；[原始日志](./evidence/agent-images-client-2026-10-29/shared-regression-contract.log)（542/542 保留为[before 日志](./evidence/agent-images-client-2026-10-29/shared-regression-before-finish-schema.log)） |
| 桌面图片与交互 | 49/49；[原始日志](./evidence/agent-images-client-2026-10-29/desktop-image-interaction-final.log) |
| Swift Package | 209 项通过，包含真实 ImageIO 编码；[原始日志](./evidence/agent-images-client-2026-10-29/image-client-swift-tests-v2.log) |
| 类型与构建 | shared、api、desktop-client、ai-worker 类型检查通过；桌面生产构建、远端 API/worker 生产构建通过；iOS 最终增量构建成功，模拟器编译 178.88 秒 |
| 批量重读的实际库检查 | 12 个真实上传资产按序返回，跨空间资产先拒绝、禁发图片不读取、重复身份拒绝。使用明确的测试缓存观察验证权限及回执，不把它算成模型识字测试；[结果](./evidence/agent-images-client-2026-10-29/batch-read-tool-postgres.json) |
| 部署清理回归 | 2/2；本地镜像不被清掉，继承旧 mtime 的待发布目录不被误删；[日志](./evidence/agent-images-client-2026-10-29/deploy-retention-tests.log) |

桌面真实窗口通过真实 API 上传了一张 **8,653,832 字节 PNG**：上传后的对象是 **2,524,979 字节 JPEG**，仍为 1800×1600。再加入 11 张小图，输入器和历史抽屉都保留 12 张；第 13 张被数量上限拦下，已有 12 张不丢失。[对象存储核验](./evidence/agent-images-client-2026-10-29/desktop-upload-verification.json)、[窗口截图](./evidence/agent-images-client-2026-10-29/desktop-12-images.png)。

iOS 使用自建独立模拟器、真实账号和 API 启动应用，系统照片选择器确实显示最多 12 张；当前 DeviceHub 无法操作该系统选择器，未把完整选图上传列为 iOS 窗口通过，也没有可用已连接真机。Swift 测试与增量构建不能代替设备全流程检查。手机仓库的 `docs/testing/ios-image-compression-12-2026-10-29.md` 记录这项边界。本次未创建客户端版本 tag 或发布新 IPA，服务端上线不代表用户已安装新客户端。

回归过程曾发现批量读取错误提示含内部字段名，已改为用户可理解的中文并通过全量复验；Shared 单步超时用例在与多个构建并行时曾测到 211ms、超过其 200ms 断言，单独 21 项及最终全量（现为 543 项）复跑均通过。没有放宽断言来消除失败。

## 真实模型与线上结果

保持各批原始判定，不把重跑当成更多独立样本。测试图的字符只存在于像素，上传名和图注不携带答案。普通字体 12 图批覆盖顺序、字符完整与整段不重复；这不等于复杂图表和所有 OCR 都可靠。

- [本地 v6](./evidence/agent-images-client-2026-10-29/native-images-12-v6.json)：首轮和追问两项均通过字符、顺序及每个答案只出现一次的检查，总耗时 34.23／56.68 秒，首可见事件 17.79／56.23 秒。
- [恢复原模型后的前一生产批](./evidence/agent-images-client-2026-10-29/production-images-original-models.json)：10/10 客观检查。包含明确逐字新建及局部修改、真实计算器、贝叶斯推导、闲聊不写入、12 图和追问、取消。12 图总耗时 24.28 秒，追问 81.87 秒；追问出现 12 次单图工具读取，本轮补入自主批量读取能力来减少往返。贝叶斯内容人工核对为 8/57≈14.04%，自动成功状态本身不能证明推导质量。
- 同一生产批中普通闲聊首可见事件为 **3.122、5.235、3.654 秒**。原模型下仍不能保证每条首字 1–2 秒；不使用固定开场白冒充有效回复，也不引用早期其他模型的约 1 秒结果。

随后 `1d0abf16cf25` 生产批[10/10 客观检查](./evidence/agent-images-client-2026-10-29/production-images-final.json)仍暴露耗时问题：12 图首轮 23.85 秒，但追问 89.57 秒。追问已经用了单次批量工具，不能声称批量工具解决了全部延迟。[控制调用轨迹](./evidence/agent-images-client-2026-10-29/production-image-followup-control-trace.json)显示原图已实际提供，模型却把重看材料标成需要外部读取回执；finish 被拒，继而装载、读取和重写，六个步骤中包含可避免的往返。

因此将 `textOnly` 的证据含义统一到共享合同，工具 schema、初始执行与补交付指引共用一份定义：对宿主确认实际提供的文字、像素、文件和观察结果进行分析，是可直接交付的回答；实际保存、修改及尚未取回的外部材料仍需本轮真实成功回执。没有增加关键词、自动改写模型的完成声明或放宽写入校验。finish 也明确支持同一步正文与单独 finish 调用，避免先生成完整草稿再重写。

[原模型协议对照](./evidence/agent-images-client-2026-10-29/finish-covered-materials-results.json)中，新旧各 4/4：原图复读、已给完整文字、未给正文的私人笔记、实际保存。新版原图复读一次完成、旧版两次；未给材料与保存均继续提出工具调用。该实验不执行数据库或业务工具，不能当作完整线上验收；单次新版原图反而用了 27.36 秒、旧版 15.10 秒，**不能从步骤减少推断模型时延必然降低**。完整线上复验单独记录。

统一提示后的 `51aa8b11041c` [生产批](./evidence/agent-images-client-2026-10-29/production-images-context.json)实际只有 **8/9**。第二次原图追问返回“还没有核对完”，没有交付 12 项答案；首轮与第一次追问分别 26.86／41.78 秒，第二次追问失败仍花了 41.83 秒。工作档要求 finish 合同，但请求仍允许普通正文，模型连续回答后被宿主反复退回，最终给出通用失败说明。仅统一提示没有解决协议不一致。这批安静陪伴首可见事件为 **12.168 秒**：语义判断超时后进入认真档，不能只列较快闲聊来声称延迟达标。

随后为工作档以及已经发生写入的轮次声明 `tool_choice: required`，没有当前可复用正文时，finish schema 要求 `text`。但继续核对适配器和[MiMo 官方协议](https://mimo.mi.com/docs/en-US/api/chat/responses)后确认：**原主模型链路只支持 auto，适配器会把 required 转为 auto，不能宣称主模型在传输层被强制调用工具。** 当前能依靠的是明确的 finish schema 与宿主校验；缺失交付合同后，下一步携带真实草稿和回执转给原配置副模型补交付。副模型支持 required；仍由模型自主选择业务工具，宿主不编造完成回执或硬排业务流程。未公开的闲聊试答保持无工具。

在同一原模型的[原始对照](./evidence/agent-images-client-2026-10-29/finish-structured-materials-results.json)中，旧自动判定只检查协议形状，漏掉一次“已有原图却要求重传”的未完成答复；[独立复核](./evidence/agent-images-client-2026-10-29/finish-structured-materials-review.json)保留原字段，重新核对完成状态与真实字符后，标为 auto 的实验臂为 3/4、标为 required 的实验臂为 4/4。**这两个实验臂实际上都发送 auto，后一个还改变了 finish 的 text schema，因此不能把差异归因于强制工具选择。** 两项是已给材料作答，另两项只验证提出读取／保存工具，未执行业务操作；这个小样本不代表实际保存成功率或整体质量。14.22／20.65 秒也不能证明因果性的时延改善。

`4099a6e806f7` 的[图片与基础操作批](./evidence/agent-images-client-2026-10-29/production-images-structured.json)为 **9/9**。12 图首轮、两次原图追问总耗时为 20.50／24.76／23.17 秒，均完整且有序、不重复。安静陪伴首可见事件 1.730 秒，但问候因主档超时转原副档为 6.475 秒，仍不能保证每条 1–2 秒。[控制轨迹](./evidence/agent-images-client-2026-10-29/production-structured-delivery-diagnostic.json)还保留了多次 finish 返修，不能把这批通过解释为协议缺口已经完全消失。

`56d7cc3b5727` 起，`companion_finish` 的 `outcome`、`requirements` 可省略（`actions`、`evidence` 原本就有默认值），空目标清单也交给运行时判断。触发点是 2026-10-29 生产 12 图首轮：模型在流式完整答案之后调用 `{}`，旧 schema 以通用参数错误拒收；下一步模型重答同一份列表，宿主把两段都并入同一条消息，同一条消息出现两遍 12 项（[该批 2/3](./evidence/agent-images-client-2026-10-29/production-image-batch-final.json)）。现在工作档或已有写回执时仍由 `requireRequirements` 要求 `outcome` 和逐项目标，普通答复直接精确交付当前草稿。回归覆盖 `{}` 交付草稿、工作档拒绝空清单，以及既有回执校验。

2026-10-29 后半轮的 `3608736987ba` 继续处理“答完还要补交付”的往返：

- 交付合同只由动作触发：`companion_finish` 的 `outcome`/`requirements` 是否必填，改看本轮是否已有真实写回执或未发完的独立消息；只读材料后的正文直接结算。旧规则按“工作档”标签要求 finish，读一条笔记要 6 步、首可见 22.6 秒。
- 没有待引用回执时，回答可以流式下发（此前工作档整段缓冲，首可见等于整轮结束）。
- “单条 publish 直接收尾”仍然拦住：工作档发布一条消息后不能就此结束。第一批把这条判据一起去掉时，`split` 只发了一条。
- 12 图三批视觉读取改为同时进行（原来最多并行两批）。与 56d7 批对照，12 图首轮 26.81→20.27 秒、两次追问 34.58／32.85→25.79／18.05 秒；这里也包含交付往返减少，不能全部归因于并发。
- 只带语音标签（如 `[neutral]`）的回复按空答复处理，交付非空提示而不是静默成功。
- `finish` 只逐字重复本轮已发布消息时不再追加气泡；一批里出现过的第三条“早上好。”就是它造成的。
- 单批视觉读取 12 秒没有回来就并行发第二路，取先成功的那一路，另一路取消。线上见过同一轮里两批 4–10 秒、第三批 33 秒；兜底只在这类单批卡顿时生效。
- `finish` 的正文先剥语音标签再判空：只剩 `[neutral]` 这类标签时按没有正文拒收，避免落一条空消息。
- 思考不再设墙钟上限：默认删掉“主档 60 秒 / 副档 180 秒后即使仍在推理也切备用”的可用输出等待，推理片段持续续命；只有连接完全停止发送字节 45 秒才判空闲并切备用（`COMPANION_PROVIDER_IDLE_TIMEOUT_MS=0` 可关闭）。原先的上限保留为可选环境变量，默认关闭。整轮没有硬截止，用户取消优先。
- 跨轮旧推理不再回放给模型：推理只在**当前请求边界内**作为工具链回放材料，上一轮的思考保留在检查点供排查，但不再发给 provider。线上见过上一轮一句“去找 Agent验收规范”的旧念头留在上下文里，下一轮 `split` 直接把它当成当前任务，跑去检索记忆并答非所问。过滤后连续三批没有再出现这种串台。
- 试过再回退（两次）：先给“模型判成工作档且零回执”的轮次加交付声明守卫，草稿回灌后模型误以为第一条已发出，丢了一条；改成不回灌草稿的“重考虑”后，又在一次 `split` 里把模型 3852 token 的长草稿整段丢弃重生成，单轮多花 149 秒。两次都已回退，只保留写回执/独立消息合同、标签空答复和重复交付抑制。

外部做法核对（一手资料）：OpenAI 的函数调用用 `tool_choice: "required"` / `allowed_tools` 在传输层强制至少一次工具调用（[function calling](https://developers.openai.com/api/docs/guides/function-calling)）；Anthropic 的 `tool_choice` 支持 `auto / any / tool / none`，但强制工具会跳过思考，新模型上还可能报错（[implement tool use](https://platform.claude.com/docs/en/build-with-claude/tool-use/implement-tool-use)）。Codex 仓库里 `update_plan` 只是模型声明的步骤清单（`pending / in_progress / completed`），提示要求“结束前所有条目完成或明确取消”，并明确“Do NOT guess”（[plan_tool.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/plan_tool.rs)、[gpt_5_2_prompt.md](https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_2_prompt.md)）；Claude Agent SDK 的待办文档也写明宿主只是读取工具调用、不做完成校验（[todo tracking](https://code.claude.com/docs/zh-CN/agent-sdk/todo-tracking)）。我们的主档 MiMo 只支持 auto，传输层强制用不了；试过把“不许猜”落成宿主可核对的交付声明，但修复消息会把草稿回灌成助手消息、导致模型误判已发送，线上丢了一条消息，因此回退——这条边界只能继续靠现有回执合同，不能靠额外声明。

随后增加的[交付交叉检查](./evidence/agent-images-client-2026-10-29/production-delivery-crosscheck.json)只有 **4/7**，保留全部失败：记忆实际写入但回复为空，分两条消息与引用吐槽两项超过 180 秒观察窗口后由测试取消。贝叶斯推导内容正确，但总耗时 119.67 秒，首可见事件 118.26 秒。这批发现了两个独立的代码缺口：降级收尾误从 `data.summary` 读取实际位于回执顶层的 summary，且成功写入缺少 summary 时没有非空提示；输出看门狗则把持续思考当成进展，可能长期没有正文和工具。

新修复只使用当前 run 中真实配对、最终成功的写入回执，优先取顶层 summary，并明确提示后续回复中断、其他要求尚未核对；不再空白成功或宣称整项完成。另将输出活动区分为正文、思考、工具。2026-10-29 起，**思考默认没有墙钟上限**：推理片段会持续续命，只有连接完全停止发送字节 45 秒才判空闲、切备用档；原先“主档 60 秒 / 副档 180 秒后即使仍在思考也切走”的可用输出等待保留为可选配置（`COMPANION_PROVIDER_FIRST_MEANINGFUL_OUTPUT_TIMEOUT_MS`），默认关闭。正常长输出和多步任务没有整轮硬截止，取消优先。

`56d7cc3b5727` 的[线上批](./evidence/agent-images-client-2026-10-29/production-finish-schema.json)为 **10/10 客观检查**：独立笔记读取、先问后记、确认后写入并保留原话出处、两条独立消息、引用吐槽不操作、贝叶斯推导、工作后闲聊、12 图首轮与两次原图追问。12 图首轮 26.81 秒、两次追问 34.58／32.85 秒，首可见 22.33／32.20／31.96 秒；安静闲聊首可见 1.511、1.588、3.696 秒；独立笔记读取 23.83 秒、写入确认 23.73 秒，分两条 25.29 秒，贝叶斯 22.21 秒。贝叶斯内容人工核对：真阳性 0.016、假阳性 0.098、后验 8/57≈14.04%，推导与结论一致。

`3608736987ba` 的[完整批](./evidence/agent-images-client-2026-10-29/production-contract4.json)为 **12/12**（加入逐字新建与局部修改）：12 图首轮 20.27 秒、两次追问 25.79／18.05 秒，首可见 17.47／22.11／15.24 秒；独立笔记读取 14.61 秒、写入确认 12.36 秒、分两条消息 10.42 秒、贝叶斯 17.62 秒；安静闲聊首可见 2.02、4.13 秒。同版[第二批](./evidence/agent-images-client-2026-10-29/production-contract4b.json)为 **11/12**：`split` 只回了“早上好。”，第二条问题整条丢失；这批模型整体延迟约为前一批的 2–3 倍（逐字编辑 51.25 秒、贝叶斯 41.43 秒、12 图 45.87 秒），保留失败，不并入成功率。

`7894e166542e` 的[图片与基础批](./evidence/agent-images-client-2026-10-29/production-contract5.json)为 **5/5**：12 图首轮 34.84 秒、两次追问 42.01／20.67 秒，均完整、有序、不重复；独立笔记读取 15.29 秒、工作后闲聊首可见 1.79 秒。这一批每批视觉读取都在 12 秒内返回，并行兜底没有触发；首轮 34.8 秒主要花在回答生成（15.4 秒、627 个输出 token），追问 42 秒时有一段 25.7 秒、1056 个输出 token 的长回答。兜底行为由三条单测覆盖（第二路胜出、正常批次不额外发请求、取消传播），线上样本还没遇到需要触发它的单批卡顿。

`7894e166542e` 的[第二批](./evidence/agent-images-client-2026-10-29/production-contract5b.json)为 **11/12**：`hidden-note` 那轮模型没有读取就直接写出“暗号”，检查发现正文里的字符是编造的，读取工具一次都没调用；同一轮 330 条思考片段显示它在脑内编了一篇不存在的资料并反复核对。这属于模型凭空生成，宿主没有可核对的结构信号（该轮为零回执），保留失败。该批处于明显变慢的窗口：写入确认 82.58 秒（主档持续思考 60 秒被可用输出上限切断后转副档 3 秒完成）、两次图片追问 57.96／80.01 秒（模型分别输出 1436／1615 个 token 的长回答），12 图与其余项目通过。

`bb97864d7fc2` 的[定向批](./evidence/agent-images-client-2026-10-29/production-contract6.json) **5/6**：独立笔记读取、两条消息、贝叶斯、工作后闲聊、12 图通过；第 6 项 `accept-followup` 是本轮用例顺序写错（没带 `offer-first`，“刚才说的偏好”没有前文），模型反过来请用户说清楚，操作本身没有出错。按正确顺序补跑的[记忆批](./evidence/agent-images-client-2026-10-29/production-contract6b.json)为 **3/3**：先问后记、确认写入并保留原话出处、引用吐槽不操作。

`e5039289050a` 的[定向批](./evidence/agent-images-client-2026-10-29/production-contract7.json) **6/7**：独立笔记读取、逐字新建、两条消息、贝叶斯、工作后闲聊、12 图通过；`accept-followup` 又是用例顺序问题（这批没带 `offer-first`），模型先查了记忆和旧对话（8 次读取回执）再请用户说清楚，没有编造。按正确顺序补跑的[记忆批](./evidence/agent-images-client-2026-10-29/production-contract7b.json)为 **3/3**。同批 `split` 遇到一次 60 秒持续思考被切断后转副档，总耗时 80.82 秒，但两条消息完整。

`da8a24b31518` 的[定向批](./evidence/agent-images-client-2026-10-29/production-contract8.json) **6/7**：`split` 只发布了第二条、丢了“早上好”。检查点显示模型先写出了两条完整草稿，是零回执守卫把草稿回灌成助手消息后，模型误以为第一条已经发出、只补了第二条——这是守卫造成的丢条，不是模型漏发。该守卫已回退。

`a2f0cf4b6597`（跨轮推理过滤后）连续三批全过：[稳定批 1](./evidence/agent-images-client-2026-10-29/production-stability-1b.json) **12/12**、[稳定批 2](./evidence/agent-images-client-2026-10-29/production-stability-2b.json) **12/12**、[稳定批 3](./evidence/agent-images-client-2026-10-29/production-stability-3b.json) **12/12**。三批合计 36 项全部通过：逐字新建/修改、笔记读取、先问后记、确认写入、两条独立消息、引用不操作、贝叶斯、闲聊、12 图与两次追问；首可见 1.31–42.58 秒，总耗时 3.91–128.42 秒（最慢的一次 `split` 是模型写了 1598＋3017 token 的长输出，不是宿主等待）。同版[长证明](./evidence/agent-images-client-2026-10-29/production-final-proof.json) 64.38 秒完整交付、首可见 22.53 秒。

`994f58b51e2e` 的[完整批](./evidence/agent-images-client-2026-10-29/production-final-check.json)为 **12/12**：逐字新建与局部修改、独立笔记读取、先问后记、确认写入并保留出处、两条独立消息、引用吐槽不操作、贝叶斯、工作后闲聊、12 图与两次追问全部通过。首可见 1.49–23.18 秒，总耗时 2.47–25.74 秒；12 图首轮 18.16 秒、两次追问 24.58／22.42 秒。

`994f58b51e2e`（取消思考上限后）的[线上批](./evidence/agent-images-client-2026-10-29/production-nocap.json)为 **8/8**：长证明（根号 2）41.03 秒完整交付、首可见 18.08 秒；读笔记 14.11 秒、先问后记 5.52 秒、确认写入 20.93 秒、两条独立消息 20.24 秒、贝叶斯 19.56 秒、工作后闲聊 3.63 秒、12 图 21.34 秒。

`ad2075e7a5b9`（回退后）的[定向批](./evidence/agent-images-client-2026-10-29/production-contract9.json)为 **8/8**：笔记读取 21.22 秒、先问后记 5.40 秒、确认写入 21.48 秒、两条独立消息 15.53 秒、引用吐槽 11.82 秒、贝叶斯 28.35 秒、工作后闲聊 14.19 秒、12 图 19.76 秒。此前守卫单独造成的 `offer-first` 31.57 秒也回到 5.40 秒。

修复过程中的[第一批](./evidence/agent-images-client-2026-10-29/production-contract.json) 9/10 与[第二批](./evidence/agent-images-client-2026-10-29/production-contract2.json) 8/10 也保留：前者 `split` 只发一条；后者 `split` 只剩标签导致静默完成、下一轮才补答，引用吐槽那轮还出现了一次写入。它们分别促成了 publish 收尾判据、标签空答复与 finish 重复抑制的修复。结构通过不等于整体语义成功率，也不覆盖复杂图表与所有 OCR。

## 最终发布与保留的失败

运行时代码快照更新为 `a2f0cf4b6597438ffa54dcc3ab85823e3b2b3d3f93875660638bc9ff2b6ff498`，包含 91 个文件；[逐文件清单](./evidence/agent-images-client-2026-10-29/source-manifest.json)。前一版 [602093c85918 清单](./evidence/agent-images-client-2026-10-29/source-manifest-before-replay.json) 保留“重考虑”实验批；[994f58b51e2e 清单](./evidence/agent-images-client-2026-10-29/source-manifest-before-nocap.json) 等更早的清单也保留。它们是基线 `9ac7d098dd8ba2a4e82b49495f920bf3e99109d8` 上的工作区快照，不是已创建的新 Git 提交。[双端源码身份](./evidence/agent-images-client-2026-10-29/client-source-manifest.json)独立记录。镜像沿精确运行中的原始 API/worker 基底只叠加 Agent 与共享合同，保留另一组无关的生产 API/语音实现。

发布状态：`2026-10-29 18:57`（UTC+8）部署 `…-a2f0cf4b6597`，7 个服务健康，API/worker 镜像 ID 与发布清单一致、标签 `ai.astella.agent.source` 指向该快照；[健康回执](./evidence/agent-images-client-2026-10-29/production-health-contract13.json)。此前各版的健康回执也保留在证据目录。

历史镜像清理：`2026-10-29 16:48`、`17:43`、`18:01`、`18:57` 四轮，删除 32 个旧版 `astella-agent-api/worker` 标签和全部 release-hold 容器，只保留当前运行的 `a2f0cf4b6597` 与两根构建基底 `astella-agent-image-base-*:20261029`；[清理记录](./evidence/agent-images-client-2026-10-29/production-image-cleanup-20261029.txt)。根分区 64%（剩 11G），api/worker 仍健康。**比当前版本更早的发布已不能按镜像回滚。**`config/ai-platforms.json` 未改动（SHA-256 `7a48…92d`），主档 `mimo-agent / mimo-v2.6-flash`、副档 `tokenrhythm / deepseek-v4.1-flash-1017` 保持不变。

第一次最终发布失败于部署清理：复制目录继承旧 mtime，待发布目录被误删；自动回滚又报告旧 API 标签缺失。检查时旧 API、worker 仍健康，未执行新版本数据库迁移。恢复旧运行镜像的标签后，部署脚本显式保留待发布目录，并在 `--local-images` 时保留已准备镜像。部署脚本有独立 SHA 与回归记录，不混入上述运行时代码哈希。

以下失败继续保留，不因新批通过而删除：

- 早期像素字体 D/0、B/8 混淆确实读错；普通字体的新样本不能覆盖这项模型能力限制。相关 v2/v3 原始结果仍在证据目录。
- [v5](./evidence/agent-images-client-2026-10-29/native-images-12-v5.json) 的旧自动检查漏掉了整段重复，因此当时的 `ok` 不能算完整正确；后续独立 v2 评估合同加入顺序及唯一性检查，保留旧分母和原输出。
- 认真档仍有“把可能性说成事实”的既有内容反例，完成合同与二次审稿不能保证语义全对，没有宣称整体 ≥95% 或所有问题都已可靠。
- [交付交叉检查修复批](./evidence/agent-images-client-2026-10-29/production-delivery-crosscheck-repaired.json)前 5 项通过（独立读取、先问后记、确认写入、两条消息、引用不操作），随后测试机 SSH 复用连接断开，剩余 2 项不是轮次失败；它们在独立账号重跑通过（[3/5 中断记录](./evidence/agent-images-client-2026-10-29/production-delivery-crosscheck-repaired-2.json)），不把两批合并成一个成功率。
- [图片批 2/3](./evidence/agent-images-client-2026-10-29/production-image-batch-final.json)：12 图首轮在同一条消息里重复整份答案（finish `{}` 被旧 schema 拒收后重答），该批判为失败；修复后 `56d7cc3b5727` 的 12 图首轮与两次追问均通过，没有删除这条失败记录。
- [交付合同第一批 9/10](./evidence/agent-images-client-2026-10-29/production-contract.json)：去掉“单条 publish 收尾”闸后，`split` 只发一条就结束；判据已恢复，其余 9 项通过。
- [交付合同第二批 8/10](./evidence/agent-images-client-2026-10-29/production-contract2.json)：`split` 只输出 `[neutral]` 标签，整轮静默成功，下一条请求才补答；同一批引用吐槽那轮出现了一次写入。标签空答复与重复交付已单独修复并回归。
- [同版第二批 11/12](./evidence/agent-images-client-2026-10-29/production-contract4b.json)：`split` 只回“早上好。”、第二条问题丢失；这批模型延迟为前一批的 2–3 倍，属于模型漏答，宿主不按条数强推，保留失败。
- [守卫定向批 6/7](./evidence/agent-images-client-2026-10-29/production-contract8.json)：`split` 在零回执守卫下丢了第一条消息。该守卫已回退，回退后的同用例两批均通过；这条记录保留，用来说明“交付声明”类守卫会把未发送草稿回灌成已发送上下文，不能再用。
- [慢窗口批 11/12](./evidence/agent-images-client-2026-10-29/production-contract5b.json)：`hidden-note` 无读取回执、正文暗号是编造的（思考里自己编了一篇不存在的资料）。宿主没有可核对的结构信号，不把这类内容判成完成也不改写用户请求；保留失败并记录 60 秒可用输出上限把一次持续思考切到副档的行为。

## 证据与清理

[证据目录](./evidence/agent-images-client-2026-10-29/)只保存合成测试账号回答、工具与耗时、代码身份和测试记录，不发布真实用户消息、解析后凭据、会话令牌、私有数据库地址或原始思考。保留失败批次和不同源码版本，不能把所有通过数加成一个整体成功率。

清理状态：37 个合成账号全部 `global_enabled=false`、epoch+1、会话令牌已删除，没有排队或运行中的轮次。旧发布镜像与 release-hold 容器已全部删除，只保留当前版本与两根基底。测试脚本、运行日志和发布回执在 `outputs/agent-final-repair-2026-10-29/`，证据目录只含这些摘要与结果。
