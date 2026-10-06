-- 42 阶段 1 子任务 C：把已有的 note_expansion_generate 接入 Agent 目标运行。
--
-- 背景：笔记拓展本来是笔记页自己发起的 job（apps/api note-expansions service）。
-- 现在伴星可以在目标里启动它，于是 worker 需要在目标续跑事务里 enqueue 这个
-- child job——和 0368 给 note_overview_generate / note_dynamic_artifact_generate
-- 开的口子完全同构。
--
-- 这里的边界很重要：`jobs` 上 worker 的 INSERT 权限只有两类
-- （0368 的 agent_goal_enqueue 与更早的 companion 记忆类白名单），不能因为
-- 多了一种生成就把 worker 的 jobs 权限整体放宽。因此本迁移**替换**同名的
-- agent_goal_enqueue 策略，只把类型列表多写一个词，其余判据逐字保留：
--   - 必须是 agent_operations 里已经绑定好的 job（id 即 job id）；
--   - capability 必须等于 job 的 type（速看演示不能借拓展的通道投出去）；
--   - run 与 operation 必须在同一个 workspace / user。
-- 0368 里 note_expansion_generate 不在列表 → worker 的插入会被 RLS 拒绝，
-- 这正是本迁移要修的那一处；其他类型的拒绝行为保持不变。

--> statement-breakpoint

DROP POLICY IF EXISTS agent_goal_enqueue ON public.jobs;
CREATE POLICY agent_goal_enqueue ON public.jobs FOR INSERT TO astella_worker WITH CHECK (
  (type='agent_run_advance' AND EXISTS(SELECT 1 FROM public.agent_runs r
    WHERE r.id=(payload->>'runId')::uuid AND r.revision=(payload->>'revision')::integer
      AND r.workspace_id=jobs.workspace_id AND r.user_id=jobs.requested_by))
  OR (type IN ('note_overview_generate','note_dynamic_artifact_generate','note_expansion_generate') AND EXISTS(
    SELECT 1 FROM public.agent_operations o JOIN public.agent_runs r ON r.id=o.run_id AND r.revision=o.revision
    WHERE o.job_id=jobs.id AND o.capability=jobs.type AND o.workspace_id=jobs.workspace_id AND o.user_id=jobs.requested_by))
);

--> statement-breakpoint
-- 结果未知（outcome_unknown）的核对有次数上限；上限之外只有「产物后来真的
-- 落库」这一条理由值得再醒一次目标。0368 只认速看与互动演示的产物表，拓展
-- 草稿表同样是一种真实保存记录，不写进来的话：丢失回执的拓展草稿会永远停在
-- 未知，用户收下草稿后目标也不会被叫醒。函数逐字保留，只重写这段 EXISTS。
-- 权限（REVOKE/GRANT）与触发条件都不变。
--
-- 这三条 EXISTS 刻意是同一个形状：领域行必须和 job 的类型、归属、payload 冻结
-- 的材料完全对上，并且材料在目标自己的冻结输入里。只看「有一行 id 相同的草稿」
-- 是不够的——一个目标冻结多份材料时，别处的一行也能对上 id，那会让一个永远
-- 拿不到产物的操作被反复唤醒，正好是核对预算想防的事。
CREATE OR REPLACE FUNCTION public.astella_enqueue_agent_recovery() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE inserted integer;
BEGIN
  -- Reconcile uncertain results using facts, with a bounded check budget and
  -- no repeated generation. A later saved artifact can still wake the goal.
  INSERT INTO public.agent_run_events(run_id,workspace_id,user_id,revision,operation_id,job_status)
  SELECT r.id,r.workspace_id,r.user_id,r.revision,o.id,j.status
  FROM public.agent_runs r JOIN public.agent_operations o ON o.run_id=r.id AND o.revision=r.revision
    JOIN public.jobs j ON j.id=o.job_id
    JOIN public.user_companion_account_state a ON a.id=r.identity_id AND a.user_id=r.user_id
  WHERE r.status='waiting' AND o.status='outcome_unknown' AND a.global_enabled AND a.epoch=r.account_epoch
    AND EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=r.user_id AND m.left_at IS NULL)
    AND o.updated_at < now()-interval '30 seconds'
    AND (o.receipt_checks < 4
      OR EXISTS(SELECT 1 FROM public.note_overviews n JOIN public.jobs c ON c.id=n.generation_job_id
        WHERE n.generation_job_id=o.job_id AND n.workspace_id=r.workspace_id AND n.user_id=r.user_id
          AND c.type='note_overview_generate' AND c.workspace_id=r.workspace_id AND c.requested_by=r.user_id
          AND c.payload->>'noteId'=n.note_id::text AND c.payload->>'noteVersionId'=n.note_version_id::text
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.inputs) i
            WHERE (i->>'noteId')::uuid=n.note_id AND (i->>'noteVersionId')::uuid=n.note_version_id))
      OR EXISTS(SELECT 1 FROM public.note_learning_artifacts n JOIN public.jobs c ON c.id=n.generation_job_id
        WHERE n.generation_job_id=o.job_id AND n.workspace_id=r.workspace_id AND n.user_id=r.user_id
          AND c.type='note_dynamic_artifact_generate' AND c.workspace_id=r.workspace_id AND c.requested_by=r.user_id
          AND c.payload->>'noteId'=n.note_id::text AND c.payload->>'noteVersionId'=n.note_version_id::text
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.inputs) i
            WHERE (i->>'noteId')::uuid=n.note_id AND (i->>'noteVersionId')::uuid=n.note_version_id))
      OR EXISTS(SELECT 1 FROM public.note_expansion_tasks n JOIN public.jobs c ON c.id=n.id
        WHERE n.id=o.job_id AND n.workspace_id=r.workspace_id AND n.user_id=r.user_id
          AND c.type='note_expansion_generate' AND c.workspace_id=r.workspace_id AND c.requested_by=r.user_id
          AND c.payload->>'noteId'=n.note_id::text AND c.payload->>'noteVersionId'=n.note_version_id::text
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.inputs) i
            WHERE (i->>'noteId')::uuid=n.note_id AND (i->>'noteVersionId')::uuid=n.note_version_id)))
    AND NOT EXISTS(SELECT 1 FROM public.agent_run_events e WHERE e.operation_id=o.id AND e.processed_at IS NULL);
  INSERT INTO public.jobs(type,workspace_id,requested_by,payload,status,priority,resource_class,idempotency_key)
  SELECT 'agent_run_advance',r.workspace_id,r.user_id,jsonb_build_object('runId',r.id,'revision',r.revision),
    'pending',60,'maintenance','agent-recover:'||r.id::text||':'||r.revision::text||':'||floor(extract(epoch FROM now())/30)::text
  FROM public.agent_runs r JOIN public.user_companion_account_state a ON a.id=r.identity_id AND a.user_id=r.user_id
  WHERE a.global_enabled AND a.epoch=r.account_epoch
    AND EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=r.user_id AND m.left_at IS NULL)
    AND (r.status IN ('queued','running') OR (r.status IN ('waiting','paused') AND EXISTS(
      SELECT 1 FROM public.agent_run_events e WHERE e.run_id=r.id AND e.revision=r.revision
        AND e.processed_at IS NULL AND e.job_status IN ('succeeded','dead','failed'))))
    AND NOT EXISTS(SELECT 1 FROM public.jobs j WHERE j.workspace_id=r.workspace_id AND j.requested_by=r.user_id
      AND j.type='agent_run_advance' AND j.payload->>'runId'=r.id::text
      AND j.payload->>'revision'=r.revision::text AND j.status IN ('pending','running'))
  ON CONFLICT (workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END $$;
REVOKE ALL ON FUNCTION public.astella_enqueue_agent_recovery() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_enqueue_agent_recovery() TO astella_worker;
