# Agent 上下文、记忆、主动交流与首字延迟审查

> 2026-10-15 实机补验更新：本报告之后补做了真实 Electron 窗口测试，继续发现并修复安静时长精度、答后重复消息和停止状态问题；延迟仍有慢样本。最新结论见 [桌面实机补验](agent-desktop-real-device-validation-2026-10-15.md)，不要将本报告的单测结论理解为全体验验收通过。


日期：2026-10-15（Asia/Shanghai）。项目：`/Users/asklins/Documents/asklins_workspace/study`。

本次沿 API 接收回合、worker 上下文装配、摘要与记忆、Pi provider、主动任务准备、SSE 和桌面展示的调用链审查，修复已复现的逻辑与设计缺口。工作区同时存在其他移动端和服务端改动，本记录只描述本次检查及修改的链路；不把其他聊天的未提交内容算成本次交付。

## 已修复的问题

| 优先级 | 原问题及影响 | 本次修复 | 主要位置 |
| --- | --- | --- | --- |
| P1 | 按所有摘要区间合并覆盖，但只注入链头正文，兄弟摘要被误算成已读 | 只沿真实父子继承链计算覆盖，缺口提供历史取回入口 | `companion-dialogue-store.ts` |
| P1 | 区间内源消息失效仅作废直接摘要，继承它的后代仍可复述被更正或遗忘的内容 | 新增 0436 迁移，传播来源失效、停用、替换和删除；父摘要读取排除失效行 | `0436_conversation_summary_dependency_invalidation.sql`、`companion-dialogue-store.ts` |
| P1 | 失效摘要仍参与去重，妨碍重新生成 | 去重只认有效行，更新提交恢复当前有效状态 | `companion-dialogue-store.ts` |
| P1 | 范围端点跨过未覆盖消息，压缩仍折掉原文，动作账本也一并省略 | 覆盖清单中的内部缺口进入折叠与账本判断；缺口原文和回执保留 | `companion-compaction.ts`、`companion-dialogue.ts` |
| P1 | 递增摘要使用显示用短投影，未显示的纠正和目标在下一份摘要中永久丢失 | 使用完整父摘要结构，转义数据边界；输入预算扣除提示与父摘要开销 | `companion-summarizer.ts` |
| P1 | 向量生成期间正文被修改，旧向量可能把新正文标记 ready | 提交前锁行并核对正文、revision、删除状态；失败状态也按相同版本提交；任务键绑定正文哈希 | `companion-memory-embedding.ts` |
| P1 | 向量结果已满 topK 时，新记忆的关键词补召回在合并后被截掉 | 两路去重后按同一查询词证据排序，再取 topK；同等匹配保留原向量顺序 | `companion-memory-vector.ts` |
| P1 | 主动观察多读一层 facts，真实失败证据和安静时长没有进入模型观察 | 按持久化事实结构取 context 和 evidence | `companion-initiative-observation.ts` |
| P1 | 主动消息尚在读取就记为已接收，重复认领提前回执；迟到正文可覆盖新输入 | 分开进行中与已展示状态，输入版本、发送 generation 和空间 revision 共同围栏；失败可重试 | `companion-chat-session.tsx` |
| P2 | 无工具、无 phase 的文本等完整响应结束才下发 | 已声明无 phase 的模型增量交付，未知或有 phase 的模型保留终态筛选，显式私有 phase 始终拦截 | `pi-wire-observation.ts`、`pi-agent.ts`、模型档案 |
| P2 | 静默考虑不计发言间隔后，同一段安静每 90 秒可重复起模型 | 桌面上报稳定 quietEpisodeId；同一片段成功考虑后不重启，新操作撤销旧机会，新片段重新可用 | shared 合同、`use-companion-awareness.ts`、`companion-initiative.ts`、`companion-context-sources.ts` |
| P2 | 无会话提示时主动任务忽略现役 inbox，另选 dialogue | 先用明确交流落点或当前前台会话，再优先现役 inbox | `companion-initiative.ts` |
| P2 | 回放只算正文，随消息回放的 reasoning 形成隐形输入膨胀 | reasoning 纳入回放计量，摘要侧锚点使用同一消息形状 | `companion-context-handoff.ts`、`companion-summarizer.ts` |
| P2 | 摘要输入预算按 3,000 输出预留，但 provider 实际按模型档案发请求 | 按实际档案输出预留解析容量，避免虚高的输入预算 | `companion-summarizer.ts` |
| P2 | 摘要任务键只带父 revision，不同父节点常同为 revision=1 | 策略升至 v4；任务键绑定含父身份、版本、模型和参数的完整输入快照 | `companion-summarizer.ts` |
| P2 | 延迟验收工具仍构造旧 provider，不能代表现役 Pi | MiMo / OpenCode 探针改走 Pi | `live-tests/acceptance-common.ts` |

现有测试里一个工具预览夹具未提供实际必需的 read 上下文，已修正夹具。新集成测试已接入 worker 的 `test:companion-integration:postgres`，避免只写文件而没有运行入口。

## 首字速度实测

四次合成请求直接使用现役 MiMo Pi provider，按旧行为／增量／增量／旧行为交错发送相同问题，关闭思考，不读取业务数据。

| 行为 | 上游正文首增量 | provider 首次回调 | 本地额外等待 | 完成时间 | 回调次数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 旧缓冲 | 5,422ms | 7,505ms | 2,083ms | 7,505ms | 1 |
| 修复后增量 | 771ms | 771ms | 0ms | 2,845ms | 32 |
| 修复后增量 | 15,933ms | 15,934ms | 1ms | 17,501ms | 26 |
| 旧缓冲 | 2,140ms | 4,200ms | 2,060ms | 4,200ms | 1 |

四次正文均与 delta 拼接结果一致。证据支持移除约两秒的本地缓冲，不足以推导端到端 p50/p95；上游仍有明显波动。数据见 `agent-first-text-measurement.json`。

协议核对依据为 [MiMo Responses 官方文档](https://mimo.mi.com/docs/en-US/api/chat/responses)：输出含正文与 reasoning、思考关闭使用 none；其他 effort 值目前均映射为开启。因而仅把 medium 改成 low 不能证明减少了实际思考强度。本次保留知识和任务场景的思考策略，修复可测量的传输缓冲。

## 验证

- API 全量：2,989 通过，1 条依赖未配置 critic 环境的真实模型测试跳过。
- Worker 全量：1,782 条通过。Shared 全量：934 条通过。后续摘要任务键调整另跑摘要器回归。
- 桌面 4 份相关组件文件：50 条通过。
- 上下文定向回归：77 条通过；Pi、记忆检索和主动观察等定向回归：79 条通过。
- 实际 PostgreSQL：长会话与方案 44 的 13 条通过；主动交流 26 条通过；新增并发围栏与满额召回 6 条通过。
- 四包类型检查：shared、api、ai-worker、desktop-client 通过。
- 本次修改文件的 diff 空白检查通过。

数据库测试使用独立可丢弃库 `astella_agent_review_20261015`，执行实际迁移，并以受限 worker 角色检验生产读写路径。覆盖父子失效、单独删父、批量清理历史、源消息编辑、失效父节点排除、失效区间重建、迟到向量、新记忆满额补召回、安静片段去重、运行中的机会撤销及 inbox 选择。

## 设计判断与边界

1. 同一个 Agent 共享身份与有效记忆，具体执行保持会话与目标边界，这个方向成立。覆盖必须与真正进入模型的材料一致；读取过别的摘要的目录或知道其区间，并不等于模型读过其内容。
2. 同一次前台停顿是一个机会身份。阈值前允许便宜的持续上报；完成考虑后可以静默。用户新操作、新领域事实或自主安排的唤醒分别带来新机会，不依靠反复调用同一片段来制造主动感。
3. 召回按查询相关证据排序；新记忆不能因尚未生成向量而永久排在整页之后。当前修复保留同等关键词证据下的向量顺序，真实长期语料的语义质量仍需持续观察。
4. 本轮首字测量不含队列、上下文 SQL、桌面渲染、TTS 和网络播放；组件测试不等于真实安装包与听感验收。
5. quietEpisodeId 当前由桌面提供。没有上报该字段的旧客户端沿用既有节奏检查；原生移动端本轮并行改动不属于本次实机验收。
6. 0433 以前已经删除、且未保留来源版本的历史内容，无法由新迁移重建其过去状态。本次修复今后的继承失效和现有已标失效节点的后代，不把旧摘要的历史语义完整性宣称为已验证。
7. 修改保留在源码工作区；0436 已在隔离库验证，实际开发或部署环境应随服务端升级执行迁移并重启相关服务。现有客户端安装包不是本轮源码验证对象。
