-- 空间隔离 schema 棘轮的第一刀：给 11 张「带 workspace_id 却没有指向 workspaces
-- 外键」的表补上那条外键。
--
-- ## 这条闸在量什么
--
-- `schema-isolation-gate-postgres.integration.ts` 是一条**棘轮**：把当前违规集合
-- 如实登记为基线，之后要求实际集合与基线**完全相等**——新增一张漏写外键的表就红，
-- 修好一张却忘了从基线里删也红。它 2026-10-06 实测是红的，列出 11 张表：
--
--   agent_operations, agent_run_events, agent_run_revisions, agent_run_steps,
--   assistant_memory_budget_events, assistant_memory_item_revisions,
--   companion_context_handoff_snapshots, companion_diary_generation_checkpoints,
--   companion_discovery_entries, daily_review_batches_v2, home_suggestion_dismissals_v2
--
-- 断言自己的话是「请补 FK，不要加进基线绕过」——基线只该用来记**暂时补不动**的，
-- 而这 11 张都能补，所以走迁移。
--
-- ## 为什么它们一直没被拦住
--
-- `agent_*` 那四张与 `assistant_memory_budget_events` 其实**有**外键，只是
-- 经父表传递：`(run_id, workspace_id, user_id) → agent_runs(id, workspace_id, user_id)`，
-- 而 `agent_runs.workspace_id → workspaces(id)` 是有的。也就是说运行时不会出孤儿行，
-- 但"这一行属于哪个空间"这件事在它自己的字典里查不到——任何只读这张表的查询
-- （核对 RLS、按空间清理、导数据）都得靠 JOIN 父表才能确定，漏 JOIN 就是跨空间读。
--
-- 另外 6 张（`companion_discovery_entries` / `daily_review_batches_v2` /
-- `home_suggestion_dismissals_v2` / `companion_diary_generation_checkpoints` /
-- `assistant_memory_item_revisions` / `companion_context_handoff_snapshots`）
-- **一张外键都没有**，连传递都没有。
--
-- ## ON DELETE 为什么是 CASCADE
--
-- 显式决定，不是照抄：本仓 19 条已存在的 workspace 外键里 18 条是 CASCADE
-- （唯一例外 `companion_conversations` 是 NO ACTION）。空间解散走的是迁移 0276
-- 那支 `SECURITY DEFINER` 函数**按 catalog 逐表删**，所以 CASCADE 在正常路径上
-- 不会先于它触发——它只是兜底：直接 `DELETE FROM workspaces`（脚本、运维、
-- 一次性测试库）也不会留下无主行。
--
-- 取 CASCADE 而不是 RESTRICT：RESTRICT 会让「直接删空间」变成一件需要先手工清
-- 11 张表的事，而产品上解散空间是用户自己可做的动作，不该被这几张辅助表挡住。
--
-- 本文件是**单个** DO 块（下面没有迁移器要求的语句分隔标记）——逐条 ALTER 会
-- 各占一次 catalog 锁，而这里只做一件事：给一张表补一条外键。
--
-- 幂等：整段包在 `IF to_regclass(...) IS NULL OR NOT EXISTS(...workspace 外键...)`
-- 里，重跑不会重复加。`ADD CONSTRAINT ... NOT VALID` 只取 ACCESS EXCLUSIVE 锁且
-- 很快返回，随后立刻 `VALIDATE CONSTRAINT`（只取 SHARE UPDATE EXCLUSIVE，不挡读写）
-- ——分两步是为了不在有数据的库上锁表全扫。
-- 若某个部署的存量里真的有孤儿行，本条会当场失败并指出是哪张表，
-- 那比悄悄放过它们好。

DO $$
DECLARE
  target text;
  tables text[] := ARRAY[
    'agent_operations',
    'agent_run_events',
    'agent_run_revisions',
    'agent_run_steps',
    'assistant_memory_budget_events',
    'assistant_memory_item_revisions',
    'companion_context_handoff_snapshots',
    'companion_diary_generation_checkpoints',
    'companion_discovery_entries',
    'daily_review_batches_v2',
    'home_suggestion_dismissals_v2'
  ];
BEGIN
  FOREACH target IN ARRAY tables LOOP
    IF to_regclass(format('public.%I', target)) IS NULL THEN
      RAISE EXCEPTION '0390 期望给 % 补 workspace 外键，但那张表不存在（迁移顺序错了吗？）', target;
    END IF;
    IF to_regclass(format('public.%I', target)) IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM pg_constraint k
         WHERE k.conrelid = format('public.%I', target)::regclass
           AND k.contype = 'f' AND k.confrelid = 'public.workspaces'::regclass
       ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) '
        'REFERENCES public.workspaces(id) ON DELETE CASCADE NOT VALID',
        target, target || '_workspace_id_fkey');
      EXECUTE format(
        'ALTER TABLE public.%I VALIDATE CONSTRAINT %I',
        target, target || '_workspace_id_fkey');
      RAISE NOTICE '0390: % 已补 workspace 外键', target;
    END IF;
  END LOOP;
END
$$;
