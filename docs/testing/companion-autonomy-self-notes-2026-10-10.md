# 伴星自主阶段验证记录（2026-10-10）

对应[方案 50 §20](../plans/learning-companion/50-companion-persona-presence-and-growth-refactor-2026-10-10.md)：她自主修订写给自己的身份文档、自主留下和整理自己的记事、自己安排稍后重评，变化自动进入后续交流；用户事后查看、纠正、停用或恢复。本文只记这一轮实际跑过的验证与仍然缺的证据，不写设计。

## 1. 这一轮改了什么

| 位置 | 改动 |
| --- | --- |
| `packages/agent-host/src/self-notes.ts` | 容量判据从「tier 变过没有」改成「这一层会不会多出一条」：改写一条本来就过期的记事不再被 `self_note_capacity` 误挡；新建 key 仍照原样受预算约束 |
| `workers/ai-worker/src/live-tests/companion-autonomy-probe.ts` | 导入路径修正为现役的 `companion-memory-extractor.ts`；解析链补上生产同款的 `clipReflectionOverflow`——之前探针把「多说了一条」当成协议失败 |
| `apps/api/src/integration-tests/companion-reflection-growth-postgres.integration.ts` | 容量用例补两条断言：过期记事被纠正要成功、填满那一层之后新建仍然拒绝 |
| `workers/ai-worker/src/handlers/__tests__/companion-agent-runtime.test.ts` | 只读权限的不变式改为「读工具 + 恰好等于 `COMPANION_AUTONOMOUS_TOOLS` 的自主集合」，并断言计划类写工具照旧被拒 |
| `.../companion-context-orchestrator.test.ts`、`.../companion-context-projections.test.ts`、`.../companion-daily-summary.test.ts` | 跟随已改判的 SQL 判据（`method_state='active' AND epistemic_status <> 'disputed'`）与 `<persona_data>` 安全段新文案；被保护的判定（候选判据同条 SQL、闭合标签只出现一次）原样保留 |
| 方案 50 与 `docs/plans/learning-companion/README.md` | §8.1、§8.2、§9.2、§11、§18、§19 中与「要用户确认」「上限 1000」「自主定时器留到阶段 5」冲突的句子就地改判，新增 §20 |

## 2. 验证台账

| 项 | 命令/入口 | 结果 |
| --- | --- | --- |
| 类型检查 | `packages/shared`、`packages/agent-host`、`apps/api`、`apps/desktop-client`、`workers/ai-worker` 各自 `npm run typecheck` | 五个包 exit 0，无 `error TS` |
| 单元 | `packages/shared` `npm test` | 902 pass / 0 fail |
| 单元 | `packages/agent-host` `npm test` | 37 pass / 0 fail |
| 单元 | `workers/ai-worker` `npm test`（全量） | 见 §4：修完 5 条红用例后复跑，1573 条全绿 |
| 实库集成 | `apps/api` `companion-reflection-growth-postgres.integration.ts`（一次性库 `astella_autonomy_20261010`，以 owner/migrator/api/worker 各自角色跑） | 33 pass / 0 fail，含记事版本与 CAS、RLS 跨用户隔离、停用后模型不能自行恢复、分层容量与重评时间、持久唤醒消费一次、唤醒读完后被停用不写回 |
| 实库集成 | `apps/api` `rls-policies-postgres.integration.ts` | 通过（新表 `companion_self_notes` 受限角色授权与 RLS 目录完整） |
| 真实模型探针 | `workers/ai-worker` `REAL_MODEL_BATCH=1 node --import tsx src/live-tests/companion-autonomy-probe.ts` | 3 个合成样本，`deepseek-v4.1-flash`，产物 `outputs/companion-autonomy-20261010/synthetic-live.json` |
| 真窗口走查 | `apps/desktop-client` `node scripts/check-self-notes-window.mjs`（`npx electron-vite dev --remoteDebuggingPort 9223 -- --user-data-dir=/tmp/astella-plan50-window`，账号 `companion-probe@astella.local`，dev 库 `astella`） | 证据在 `apps/desktop-client/outputs/self-notes-window-20261010/`（6 张截图 + `notes.md`） |

探针的三个样本各自回答一件事：`self-choice`——回顾能把用户给的自主取舍写进身份文档和自己的记事，且协议校验通过（`rejected: []`）；`quiet-wake`——由她自己安排的记事唤醒可以给出「不改变」的结论；`disagreement-with-identity`——面对「能改文件就算成长」这句她不同意，回答里引用了自己那条记事、给出可推翻的判据、没有为了显得有主见而编造行为，也没有越权调用工具。

真窗口走查覆盖：目录四条状态词（常放在手边／已过期／还在关注＋她打算什么时候再看／你已停用）、详情 Markdown（标题、引文、列表）、停用→状态词与按钮翻转→恢复、纠正正文后版本 +1 且旧版本仍在历史里、已停用那条可以直接恢复、关键词筛选与还原、1440 与 900 视口无横向溢出、人格页「她写给自己的文档」自由 Markdown 保存后按篇章渲染并标出「你改的」。

## 3. 走查脚本自己踩到的两个坑（不是产品缺陷）

- 直接给受控 `<textarea>` 赋 `.value` 再派发 `input`，React 的 value tracker 认为值没变，`onChange` 不会来——纠正正文那一步一开始因此写成「原样另存一版」。改用 Playwright 的 `fill()` 后落库正确。
- 伴星中心其它分区是 `Activity mode="hidden"`，仍在 DOM 里。`role="status"` 与 `.cc-persona-prose` 不限定到本分区就会串页，读到的是别的分区（甚至上一轮）留下的文案。

## 4. 仍未验证

- **长期成长与自然度没有验收**：探针只有 3 次单调用合成样本，不写库、不执行工具；没有跨日真实行为样本，也没有真人评阅。「她改了身份文档」与「她下次真的按新认识反应」是两件事，后者仍要靠样本。
- **到点重评的端到端一次没在真机 dev 栈上等过**：入队与消费由实库用例覆盖，`astella_enqueue_companion_self_wakes()` 挂在反思 scheduler 每分钟 tick 上，真实进程里等一次自然唤醒没跑。
- **版本表没有删除口**：`companion_self_notes` 当前没有生产删除路径（只有 `GRANT ... DELETE`）。本轮手工清理时实测：删掉记事行会留下孤儿 `companion_self_note_versions`，用同一个 key 重建会在触发器上撞主键。将来若要加删除，必须连历史一起清。
- 阶段 4 的连续身体表达、对外主动台词仍未实施。
