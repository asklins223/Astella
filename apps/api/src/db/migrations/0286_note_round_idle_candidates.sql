-- 0286 —— 轮次空闲暂停的**候选预筛**（39d W4-5 ④ 附带）。
--
-- 为什么要有这一支：`round-activity-sweep.ts` 那条对账要读 `note_learning_rounds` 的
-- `phase` 与 `updated_at`，而那张表是 **FORCE RLS**，策略谓词同时比
-- `app.workspace_id` 与 `app.user_id` 两个 GUC——一次调用只能带一份，所以受限角色下
-- 不存在合法的"跨空间看一眼有哪些轮次"的读法（实测：跨空间扫在受限角色下恒 0 行，
-- 长得和"没有待办"一模一样）。于是扫描只能从 `workspace_members` 枚举 (空间,人)，
-- 逐个开事务去问"你有进行中的轮次吗"。
--
-- 实测代价（2026-09-26，dev 库）：1 330 条在册成员 ⇒ 每一趟 2149 / 2026 / 1846 ms、
-- 1 330 次事务，而**停掉 0 条**——代价随成员数长，不随真正在学的轮次数长。
--
-- 这一支函数把"有哪些 (空间,人,轮次) 真的等着被判"提前答掉：扫描只对返回的那些 scope
-- 开事务，事务次数从"成员数"变成"候选数"。
--
-- 三条边界钉在这里：
--  1. **SECURITY DEFINER 是必需的，不是方便**：函数由迁移创建 ⇒ owner 是 `ailearn_migrator`
--     （`roles.sql:37` 带 BYPASSRLS），所以它能在 FORCE RLS 下跨租户读那一行；先例是 0098 的
--     TTL 清理函数（`roles.sql:806` 那条注释明写的就是同一件事）。
--  2. **只回四列标识**（空间／人／轮次／最后变化时刻）：不含 driving question、正文锚点、
--     快照哈希。这条跨租户读的能力被压到"够挑出候选"为止——预筛不该变成第二个读面。
--  3. **grant 给 API，不给 worker**：D1 §6.5 对轮次族一律不开 worker 的跨租户读，
--     这条也不破例（调用方是 `server.ts` 里那条 API 进程的定时对账）。
--
-- 宽限期由调用方给（`min_age_ms`，默认 90 000 ms = 租约 30 秒 × 3）。为什么默认值也留在
-- 这里：函数被别的读法直接调用时，一个"没有宽限期"的版本会挑出**刚刚还在动**的轮次。

CREATE OR REPLACE FUNCTION public.ailearn_note_rounds_idle_for_pause(min_age_ms integer DEFAULT 90000)
RETURNS TABLE (
  workspace_id uuid,
  user_id uuid,
  round_id uuid,
  last_changed_at timestamptz
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT r.workspace_id, r.user_id, r.id, r.updated_at
    FROM public.note_learning_rounds r
   WHERE r.phase = 'active'
     AND r.updated_at < now() - (greatest(coalesce(min_age_ms, 0), 0) * interval '1 millisecond')
   ORDER BY r.workspace_id, r.user_id, r.id;
$function$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_note_rounds_idle_for_pause(integer) FROM PUBLIC;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.ailearn_note_rounds_idle_for_pause(integer) TO ailearn_api;

--> statement-breakpoint

GRANT ALL PRIVILEGES ON FUNCTION public.ailearn_note_rounds_idle_for_pause(integer) TO ailearn_migrator;

--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_note_rounds_idle_for_pause(integer) IS
  '轮次空闲暂停的候选预筛（39d W4-5 ④）。SECURITY DEFINER／migrator owner（BYPASSRLS）才能在 FORCE RLS 下跨租户挑候选；只回 (workspace_id, user_id, round_id, updated_at) 四列标识，不含问题正文与快照锚点。EXECUTE 给 ailearn_api，不给 worker（D1 §6.5）。';
