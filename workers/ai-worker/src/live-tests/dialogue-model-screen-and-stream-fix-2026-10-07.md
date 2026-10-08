# 方案 46 后续：模型初筛、思考对照与断流修复

2026-10-07（Asia/Shanghai），用户要求继续实施。承接 [第一阶段记录](dialogue-design-implementation-2026-10-07.md) 与 [方案 46](../../../../docs/plans/learning-companion/46-companion-natural-conversation-research-and-design-2026-10-07.md)。

新增 48 次真实表达调用，保留 3 个失败；累计表达诊断为 168 次，不是 168 场完整对话。Qwen 与 Seed 初筛尚无默认采用依据，正式路由、人格及额外检查开关未改变。修复了 Go 流式请求把缺少完成事件的半截正文归为成功，以及输出额度耗尽未按不可重试错误处理的问题。

## 模型与配置的核对

先读当前配置，再只读查询已有平台的模型目录，没有购买或注册新服务。已配置的 `tokenrhythm/qwen3.8-flash` 可直接试验。网关目录还声明了 Seed2.1 Turbo 的 262,144 token 窗口、131,072 输出额度及工具/思考支持，见 [目录回执](../../../../outputs/audits/2026-10-07-live/dialogue-catalog-tokenrhythm-v1.json)。这些是网关声明，不是本项目的容量、工具或识图验收。

Seed 仅在原平台下暂时添加试验档案，使用现有凭据；没有改变 capability 路由。试验结束移除了该新增档案，配置与进入本轮时一致。试验档案保留在结果的 routeProfiles 中，vision 为 false，避免只凭目录声明就开放图片外发。

[Qwen 官方 API 说明](https://help.aliyun.com/en/model-studio/qwen-api-via-dashscope) 列明混合思考的开关与模型档位差异；[Seed 官方深度思考说明](https://docs.volcengine.com/docs/ark/deep-thinking?lang=en) 给出其原生开关。这里走第三方网关的 chat/completions，以真实 `enable_thinking` 字段与返回用量核对兼容行为。不能将本地 profile 的 high 直接称为上游实际 high：该路径发的是开/关，并未发送具体 effort。官方文档与网关参数可能不同。

[Seed 发布说明](https://seed.bytedance.com/zh/blog/seed2-1-officially-released-advancing-ai-productivity) 描述的是通用 Agent 与实际工作流能力，不证明普通聊天比现役自然；本轮通过相同材料独立检查。

## 固定前缀调用

| 批次 | 范围 | 实际调用 | 结构有效 |
| --- | --- | ---: | ---: |
| [Qwen 初筛](../../../../outputs/audits/2026-10-07-live/dialogue-matrix-qwen-screen-v1.json) | 简历、鸭子视频、明确求助；现役/候选 × 完整/相关，各一次 | 12 | 11 |
| [Qwen 思考对照](../../../../outputs/audits/2026-10-07-live/dialogue-thinking-ablation-qwen-thinking-v1.json) | 简历、练琴、鸭子、歌曲、求助；automatic/enabled，各两次 | 20 | 20 |
| [Go 修复后正常完成](../../../../outputs/audits/2026-10-07-live/dialogue-matrix-stream-completion-v1.json) | 鸭子视频；DeepSeek/Muse × 完整/相关，各一次 | 4 | 4 |
| [Seed 初筛](../../../../outputs/audits/2026-10-07-live/dialogue-matrix-seed-screen-v1.json) | 与 Qwen 初筛同样三组、四条件，各一次 | 12 | 10 |

每条对应一次真实出网，没有为凑通过率补采样。四条 Go 正常回复验证新完成判定可以接收实际网关的完整结束；故障情形用注入 SSE 的协议回归复现，未破坏真实服务来制造故障。

[完整性核对](../../../../outputs/audits/2026-10-07-live/dialogue-integrity-followup-v1.json) 验证请求/出网哈希、完整原生历史、系统指令、温度、额度、档位字段和采样一致性；本轮保留的 payload 没有白名单字段省略。思考对照只改变普通聊天的 `disableThinking`，显式求助两条件均保持开启。

生成模型看不到评阅判据或参考答案，没有统一附加“不要建议/不要反问”。评阅仍为知道条件的编码 Agent，没有独立人类偏好结论。20 个隔离话题没有生成新回复或用于调试。

## 观察与采用判断

Qwen 初筛对简历仍建议“先让眼睛和脑子一起歇会儿，等缓过来了再最后扫一遍”。鸭子完整装配的“鸭子界的‘再来一次’”贴题，相关装配却直接输出“我去吃饭了。”；短句和正常结束因此都不能单独证明自然。

Qwen 思考开启后，两次简历分享仍出现“先别逼自己马上投出去”“眼睛疼就先别盯着了”。练琴与鸭子有个别贴题回复，也有“先让脑子有个下班点”和口头禅机械追加，没有稳定修复依据。

| Qwen 普通聊天（每条件 8 条，求助单列） | 完整执行中位等待 | 推理 token |
| --- | ---: | --- |
| automatic，本轮请求关闭 | 1.678 s | 全部为 0 |
| enabled，网关开启 | 9.070 s | 149–435 |

两条件的明确求助共 4 条保持开启，均给具体练法；没有通过统一关掉帮助能力来换取少建议。这些是表达执行器时间，不是 HTTP/UI 的首字等待；小样本不能估计稳定的延迟分布。

Seed 两条简历分享也安排休息和重新检查；两条鸭子反应基本跟题但仍有角色化发挥。两个开启思考的求助条件均在 60 秒取消，未收到可见正文，完整 token 用量未返回。不能把空用量填成 0，也不能推断模型一定没有推理或一定消耗了多少。

Qwen 初筛中的一次现役 DeepSeek 求助失败，旧日志仅记通用 Error。用量显示输出 1,449、其中推理 1,449，且未收到可见正文；日志不足以确定终止原因，不改写为断流或额度耗尽。原始失败保留。

结论是本轮候选及常开思考都未满足采用条件；明确保留当前自动思考与正式路由，不因少数好例子替换全局配置。

## 确定修复：流式完成与截断

原 [Go 流式实现](../lib/providers/opencode-go.ts) 在迭代结束时，只要已累计正文就返回 content；[执行器](../handlers/companion-agent-streaming-step.ts) 缺省归为 stop。网络断开但已生成一半的回复因此可能被当成完整成功。`response.incomplete/max_output_tokens` 则抛普通 Error，没有进入既有不可重试的输出截断合同。

现在：

- 必须收到 `response.completed`，有正文才正常返回 stop；仅收到 delta 或流结束，抛 `stream_incomplete`。
- 输出额度耗尽抛既有 `AgentOutputError/output_truncated`；传输回退也遵循不可重试判据，未发布草稿时同样不以相同额度重发。
- `response.failed`、空输出与流大小拒绝使用固定状态错误，不携带供应方错误正文。
- 已交付前缀不撤回或重发，执行器继续抛错交给既有失败保留链路；整段待发布时不发布失败草稿。
- 合成诊断后续版本会记录失败前收到的正文投影，并明确不是正式答复或 UI 收据。旧失败没有补造正文。

修复前新增的两项 provider 回归均失败；修复后通过。补充执行器测试覆盖断流前缀、待发布草稿额度耗尽、完成事件无末尾换行及禁止同额度回退。没有把字符串黑名单或模型评分加入前台自然聊天。

## 验证范围

- Go provider、真实流式执行器、Agent 运行、交付与评测入口相关组合 **141 项通过**；后续思考/治理/入口相关组合 **27 项通过**，有重叠，不合计为独立测试数量。
- shared、api、desktop-client（node/web）和 ai-worker 类型检查通过。首次检查曾读到共享笔记文件的临时缺引用，随后该独立改动已更新；本任务未修改笔记实现。
- 48 次实际调用与出网完整性核对完成，包含 3 个失败；正式配置无本轮残留路由/模型变更。
- 没有新的完整 HTTP、数据库落库或当前工作区桌面窗口验收；流式故障后的持久化仍沿既有失败保留合同，本轮没有新建数据库实测。
- 自然聊天仍未通过采用验证，20 个隔离话题保留，人工盲评尚未进行。
