-- 0309 —— **把「每 run 单例 job 类型」那个部分唯一索引的谓词收窄到还活着的那一档**
-- （39d §7.5 登记的第二件；039d W7-7 刀五）。
--
-- 0163 建这个索引时的两档是：`card_generation_plan`（旧四阶段链的出图 job）与
-- `card_v2_post_activation`（激活后的投影 job）。**旧链在 9470b601 删掉之后，前者已经
-- 没有人投递，也没有任何处理器认领它**——全仓对这两个字符串的引用只剩：
--   - 0163 这一行谓词（迁移本身不动）；
--   - `packages/shared/src/db-schema/card-generation-v2.ts` 那份**已提交迁移的 1:1 镜像**。
--
-- ## 为什么现在能收窄，而当年不能
--
-- 库里有 **674 行** `card_generation_plan`，全部是**终态**（639 `completed` ＋ 35
-- `failed`，创建于 2026-08-19 … 2026-09-24，即旧链还在跑的那段日子）。收窄谓词只是让
-- **索引不再覆盖**那些行，而：
--   - **唯一性是插入时检查的**，不是对存量补检的——不存在"新行撞上旧行"；
--   - 既然**没有代码再投递**那一档，就**永远不会再有插入**。
-- 所以这一步是**真的零后果**。当年不能收窄，是因为那时旧链还在投递。
--
-- ## 与 `policies.stageRuntimes` 那一条**不同**
--
-- 那一条进 `semanticSpecHash`（审计闭包），动它＝改哈希＝打掉在途 run 的重放前提。
-- **索引谓词不进任何哈希**，它只影响数据库怎么存。
--
-- ## 为什么必须**新迁移**而不是改 0163
--
-- 0163 是**已提交的历史迁移**，改它的内容会让"重建出来的库"与"升级上来的库"不一致。
-- `card-generation-v2-contracts.ts` 那把库存守卫说得很直白：**镜像与迁移不一致，比旧名字
-- 出现在谓词里严重得多**。所以这里是新迁移 ＋ 镜像跟着改**两处一起**。
DROP INDEX IF EXISTS public.cgro_v2_run_singleton_job_type_unique;
CREATE UNIQUE INDEX IF NOT EXISTS cgro_v2_run_singleton_job_type_unique
  ON public.card_generation_run_outbox_v2 (run_id, job_type)
  WHERE job_type IN ('card_v2_post_activation');
