-- 伴星「共享给空间」的派发清单（2026-10-09）。
--
-- 为什么共享要走 API 而不是 worker 直接写：worker 角色对 `notes` 没有 UPDATE 权限，
-- 这是 0395 立的规矩（"The worker remains unable to insert/update/delete notes directly"）。
-- 更要紧的是可见性一变，**目标索引里那句公开标题**就得跟着变——那条投影规则住在
-- `apps/api/src/modules/learning-objectives/search-projection.ts`，在 worker 里再写一份
-- 就是 0396 注释点名的"第二种笔记写入者"：两处各写一遍，哪天投影规则改了，
-- 取消共享的笔记会继续以已撤回的标题出现在别人的搜索里。
-- 所以这里只登记"有活要派"，真正写那一列的仍是服务层的 `setNoteShareScope`。
CREATE OR REPLACE FUNCTION public.astella_pending_companion_note_shares_v1()
RETURNS TABLE(workspace_id uuid,user_id uuid,call_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT c.workspace_id,c.user_id,c.id FROM public.companion_agent_tool_calls c
    JOIN public.companion_turn_runs r ON r.id=c.run_id
    WHERE c.name='companion_share_note' AND c.status='executing' AND c.result_ref IS NULL
      AND r.status IN ('accepted','running') AND r.cancel_requested_at IS NULL
    ORDER BY c.created_at LIMIT 8
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.astella_pending_companion_note_shares_v1() FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='astella_api') THEN
    GRANT EXECUTE ON FUNCTION public.astella_pending_companion_note_shares_v1() TO astella_api;
  END IF;
END $$;
