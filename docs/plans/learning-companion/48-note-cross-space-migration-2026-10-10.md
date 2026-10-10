# 48 · 把笔记搬到另一个空间

2026-10-10。用户在「笔记库」提出现实问题：个人空间里没有第二个人，「共享给空间」这个动作在那儿没有对象——`components/space-share-control.tsx` 在个人空间里整个控件不出现。于是想把笔记放到有别人的空间里去共享，而现在没有任何入口做得到。本轮**只定方案，未实施**；第 7 节那两个前提没实测，结论会回头改范围。

## 1. 用户得到什么

在「笔记库」勾选任意几篇 → 「搬到另一个空间」→ 选去处（只列我是主人的空间）→ 选可见范围（已共享给空间 / 仅自己可见）→ 选「复制一份」还是「移走」→ 逐篇看到结果。

搬过去的是**这篇笔记本身，以及已经为它做出来的学习附页**；不是这半年我怎么学的。新空间里的这篇是一张白纸：没排过复习、没记过掌握度、伴星不认识它。

## 2. 已核对的现状

| 当前事实 | 实现入口 | 对本次设计的影响 |
| --- | --- | --- |
| 会话令牌绑定单一空间，所有笔记路由只读 `req.session.workspaceId` | `apps/api/src/modules/identity/session-service.ts:215`、`apps/api/src/db/client.ts:171` | 今天没有任何入参能把请求指向别的空间，这是「不可行」的第一层原因 |
| RLS 租户闸门只比对 `app.workspace_id`，**不查成员关系** | `apps/api/src/db/migrations/0019_sec01_rls_policies_expand.sql:71-77` | 「我是不是目标空间的主人」数据库不会替我们挡，只能在应用层判，且必须判 |
| 一个事务只有一个租户，嵌套换租户直接报错 | `apps/api/src/db/client.ts:290`、`assertWorkspaceTransactionContextCompatible` | 源与目标只能是**两个先后独立的事务**；跨空间没有原子性，这是结构而不是 bug |
| `notes.current_version_id` 是复合外键 `(current_version_id, workspace_id) → note_versions(id, workspace_id)` | `0015_v03_migration_reconciliation.sql:136-139` | 不存在「改一列 `workspace_id` 就搬过去」；整棵子树必须重新铸造 id |
| 每张笔记子表都自带冗余 `workspace_id`，并被复合外键锁一致性 | `packages/shared/src/db-schema/note.ts:94-96` 及各产物表 | 任何一行 stamp 错就是把私有内容泄露到另一个空间 |
| 正文的事实源是 Yjs 快照，`note_blocks` 只是投影 | `note.ts:195-207`、`note/document-state.ts` | 搬正文＝搬那份 `bytea` ＋在新空间重新投影出版本与块 |
| 可见性判据只有一处：`shared` 或作者本人 | `note/visibility.ts:50-64` | 新空间的可见范围就落在 `share_scope` 上，不引入第二套口径 |
| 成员只有 `owner` / `member` 两档 | `packages/shared/src/db-schema/identity.ts:115`、`identity/middleware.ts:53-60` | 「只读空间」＝ `member`。来源和去处用同一个谓词判，不新造权限概念 |
| 图片 object key 带空间前缀且 `(workspace_id, object_key)` 唯一 | `note.ts:155-156`、`lib/object-storage.ts:129,162` | 图片要真复制字节；存储层只有 get/put，没有 copyObject |
| 卡的内容不住在 `learning_cards_v2`，住在 objective 及其 revision | `card-generation-v2.ts:170-247` | 「搬学习卡」实际是搬一串外壳＋内容行，见第 3 节 |
| 笔记没有目录／父级／排序容器，列表只按更新时间 | `0008_remove_tags_categories.sql` | 副本落点没有位置问题；撞标题不是约束 |

## 3. 什么跟着走，什么留下

### 跟着走

- 正文：Yjs 快照、当前版本、块投影、标题。
- 图片：复制到目标空间的 key，`note_image_assets` 铸新行，块里的 `image_asset_id` 重指。
- 写批注（`note_annotations`，只带我这一份）。
- 速看（`note_overviews`）与速看里的脑图（`note_mind_maps`）。
- 回想（`note_recall_records`）：**只带题和原文依据快照**。练习状态其实只活在 `hint_viewed_at / revealed_at / self_report / reflection` 四列（`note-recalls/service.ts:49` 用它推 waiting/hinted/revealed/reported），清空后在新空间就是一道没做过的题。`answer_snapshot` 存的是原文依据不是我的作答（`service.ts:169,178`），`hint_snapshot` 已由 `0318` 放开可空。
- 速看与批注生成的学习附页 HTML（`note_learning_artifacts`，`source_kind` 只有 `overview` / `annotation` 两档）。
- 学习卡：`learning_objectives_v2` ＋它的当前 `learning_objective_revisions_v2` ＋ `learning_cards_v2` ＋卡的修订与发布修订，并把 `learning_objective_origins_v2` 重指到新笔记——目标可见性判据会走 origin 那支（`note/visibility.ts:163-195`）。

### 留下

学习轮次及其计划修订／教导／产物／失败与反思；曝光与掌握账本、初次验证提醒、激活回执；复习订阅与「先别排这篇」；伴星对话、日记、提醒与伴星生成的附页；个人关系决定与目标绑定；来源与它的解析结果。

### 剪断的溯源（如实处理，不假装还在）

所有产物的 `generation_job_id` → NULL；回想行的 `source_message_id / conversation_id / hint_*` → NULL；`notes.source_id` → NULL。`note_expansions` 一行同时指源笔记与扩写笔记（`note-expansions.ts:47,49`），只有两篇都在同一次迁移里才连得上，否则不搬。

## 4. 页面

「笔记库」现在只有单选，行内动作在 `surfaces/notebook/note-library-surface.tsx:595`，要加复选框与底部批量条。去处列表 renderer 已经有每个空间的 `role` 与 `workspaceType`（`packages/shared/src/contracts/desktop-ipc-contracts.ts:1786-1793`，`role` 就是 `owner|member` 两档），过滤「我是主人」即可——**服务端仍要自己再判一遍，客户端传的什么都不能信**。

- 灰掉的只读空间要说清为什么灰，不是静默消失。
- 去处是个人空间时，「可见范围」那一档整档不出现：那儿没有人可共享，出现了就是一个点了没变化的开关，与现有控件的裁决一致。
- 「复制一份／移走」用这两个词，不用「迁移」。确认那一步照 `shareConfirmCopy` 的写法把后果写全：移走会进现成的三十天回收站，之后从回收站恢复会出现两份。
- 逐篇报进度，失败要说清是哪一篇、为什么，别把整批压成一个成功或一个错误。
- 单篇入口挂在「这篇笔记」的更多操作里，与批量走同一条通道、同一个对话框。

## 5. 服务端的跨空间口子

`POST /notes/migration`，**一篇一次**，客户端循环。

1. `requireOwner` 判源空间。
2. 以目标上下文开一个**只读事务**，查 `workspace_members(workspace_id=目标, user_id=我, role='owner', left_at IS NULL)`，0 行即 403 `target_not_owned`。这一步同时覆盖「目标存在」和「只读空间不能作去处」。
3. 源上下文事务读整棵树。
4. 图片字节搬运：get 源 key → put 目标 key。
5. 目标上下文事务写入：铸 note/version/blocks/asset 新 id，按选择落 `share_scope`，把每条产物行的 `(workspace_id, note_id, note_version_id)` 重 stamp，产物上的 `generation_job_id` 置 NULL，回想行的四个练习列清空。
6. **先写目标、后处理源**。目标写失败时源完好；提交后刷 `upsertSearchDocument` 与 `refreshNoteObjectiveSearchProjections`，投影不能漏。
7. 「移走」＝第 6 步成功后对源做 `deleted_at`，复用现成回收站（`note/service.ts:716`）。

幂等靠 `note_migration_records(migration_id, source_note_id, target_workspace_id, target_note_id)` 唯一，行放**目标空间下**，这样第 2 步那个事务才读得到它。`migrationId` 由客户端生成，用户重试时复用。

逐篇而非整批的理由：不撞请求超时与请求体上限、能逐篇报失败、天然可续跑。第 3、5 节合起来意味着"搬到另一个空间"在数据库层面是两次独立提交，任何声称它原子的写法都是错的。

## 6. 要动的数据合同

- `0400`：新表 `note_migration_records`（带 `workspace_id`，照现有表加 RLS 租户闸门）。
- `0401`：`note_mind_maps.generation_job_id` 改成可空。它现在是 NOT NULL 且带复合外键 `(job_id, workspace_id) → jobs` ON DELETE RESTRICT（`note-mind-maps.ts:22`）。不加这一条脑图就搬不动；把源空间的 job 行搬进新空间等于塞一条永远没人调度的调度记录。`note_mind_map_stages` 按 `job_id` 级联，不搬。
- 其余产物表的 job 列本来可空，不动 schema。

## 7. 两个前提没实测，结论会回头改范围

1. **一张没有曝光记录、没有激活回执的卡，在新空间到底进不进复习队列。** 卡搬过去时不带 `cardActivationReceiptsV2` / `evidenceEligibilityStatesV2` / `initialValidationRemindersV2`，这些表里若藏着排期的前置条件，卡就是"人在但不在队里"。实测法：造一篇带学习卡的笔记搬到另一个空间，只看「复习队列」和「今日学习」是否出现它，不跑任何生成。
2. **挂在旧版本的批注重指到新当前版本后，界面还贴不贴得对。** 块由同一份 Yjs 文档投影，当前版本的 ordinal 必然一致；旧版本的那一档不一定。写入路径有 `noteAnchorMatchesV1` 校验（`note-annotations/service.ts:112`），读取路径原样把 anchor 回给客户端，容错未核。若不宽容，退路是给被引用的旧版本各铸一行锚点版本——那等于偷偷搬部分历史，要回来重新确认，不要顺手实施。

## 8. 客户端接线与守卫

新增操作要动五处：`main/desktop-gateway-ns-note.ts` → `DESKTOP_IPC_CHANNELS` → main handler → `preload/index.ts` → renderer。

**一个已经核实的坑**：`main/desktop-ipc-note.ts:687` 的 `registerNoteChannels` 在整个 `src` 下没有任何引用，是同一份通道的死实现——活的注册在 `desktop-ipc-rest.ts:983`（例如 `noteSetShare` 两处都有）。加通道前先确认自己写进的是被调用那份。

要同步的守卫：`ipc-channel-single-source-guard`（不许裸通道字符串）、`renderer-copy-guard` 的 TARGETS 白名单、`renderer-style-order-guard` 等三件套与 `styles.ts` 分层、`component-size-guard`（笔记库那页有行数预算，批量逻辑抽成同目录模块）。对话框照 `notebook-version-choice.tsx:27` 的 `<dialog className="notebook-dialog" aria-modal>` 形状。

## 9. 验收

- `npm run typecheck`：desktop-client 的 node 与 web 两份 tsconfig 都要跑，加上 api 与 shared。
- 真窗口跑一次「个人空间 → 协作空间」搬三篇，分别含图片、含脑图、含学习卡。核对点：新空间的可见范围与所选一致；批注落回原句；回想显示为没做过；卡出现在复习队列（第 7.1 条的结论）；图片能打开；源按选择留下或进回收站；只读空间既不在去处列表也不能作来源。
- 重复提交同一个 `migrationId` 不产生双份。
- 故障注入：目标写到一半中断，源必须完好，重试必须续上。

## 10. 明确不做

不做「全选整个空间一键搬」的入口（逐篇循环做得到，但手滑代价太大，不递这个按钮）；不搬学习状态，也不给它做选择开关；不搬版本历史；不搬别人的批注（协作空间里那篇上其他人写的东西不跟着走）；不做跨环境搬迁——「导出包 → 切空间 → 导入」那条不碰跨租户代码的路线本轮已明确否决，将来若需要再说。
