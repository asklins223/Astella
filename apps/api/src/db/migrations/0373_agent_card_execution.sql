-- 42 阶段 1 子任务 P：制卡接入 Agent 目标运行，执行体从 job 扩成两类。
--
-- 制卡没有准备用的 jobs 行，于是执行体有两条互斥的支；结果迁成 result；
-- 事件列改名；领域侧补齐触发器、取消、恢复与两个受控函数。旧三类 jobId 保留。
--
-- 锁顺序：parent Agent run → card run → outbox。取消、修订与 p_lock=true 同向取锁，
-- 且写成三条独立语句而非一条 FOR SHARE OF a,b——后者按扫描顺序取锁，会与取消死锁。

--> statement-breakpoint

-- ── 1. 制卡侧的可被引用形状 ────────────────────────────────────────────────
-- 复合外键需要可引用的唯一键；制卡那两张表原先只有读索引。
CREATE UNIQUE INDEX IF NOT EXISTS cg_v2_id_ws_user_unique
  ON public.card_generation_runs_v2(id,workspace_id,user_id);
CREATE UNIQUE INDEX IF NOT EXISTS cgro_v2_id_run_ws_unique
  ON public.card_generation_run_outbox_v2(id,run_id,workspace_id);

--> statement-breakpoint

-- ── 2. 执行体三列 ──────────────────────────────────────────────────────────
-- job_id 变可空。复合外键是 MATCH SIMPLE：它为 NULL 时整条判定跳过，
-- 而"非空时必须同空间同用户"仍是库级保证。
ALTER TABLE public.agent_operations ADD COLUMN card_generation_run_id uuid;
ALTER TABLE public.agent_operations ADD COLUMN card_generation_outbox_id uuid;
ALTER TABLE public.agent_operations ALTER COLUMN job_id DROP NOT NULL;

-- scoped composite FK 绑住「同一空间/同一用户/同一批」；两个 partial unique 保证
-- 一次领域执行只被一条操作认领、一发初始 outbox 只被认领一次。
--
-- 用 ON DELETE CASCADE 而非 RESTRICT：制卡 run 是笔记的从属行，而永久删除软删除笔记
-- 是现役路径（note/service.ts:1016），RESTRICT 会让那篇笔记再也删不掉。
ALTER TABLE public.agent_operations
  ADD CONSTRAINT agent_operations_card_run_fk
  FOREIGN KEY (card_generation_run_id,workspace_id,user_id)
  REFERENCES public.card_generation_runs_v2(id,workspace_id,user_id) ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.agent_operations
  ADD CONSTRAINT agent_operations_card_outbox_fk
  FOREIGN KEY (card_generation_outbox_id,card_generation_run_id,workspace_id)
  REFERENCES public.card_generation_run_outbox_v2(id,run_id,workspace_id) ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX agent_operations_card_run_unique
  ON public.agent_operations(card_generation_run_id) WHERE card_generation_run_id IS NOT NULL;
CREATE UNIQUE INDEX agent_operations_card_outbox_unique
  ON public.agent_operations(card_generation_outbox_id) WHERE card_generation_outbox_id IS NOT NULL;

-- XOR：要么 job 非空两卡列为空，要么 job 空两卡列都非空。三列同有值等于一次执行挂两个
-- 主人，三列全空等于一条拿不到回执的操作。存量行 job_id 是 NOT NULL 的，无需先回填。
ALTER TABLE public.agent_operations ADD CONSTRAINT agent_operations_execution_xor_chk CHECK (
  (job_id IS NOT NULL AND card_generation_run_id IS NULL AND card_generation_outbox_id IS NULL)
  OR (job_id IS NULL AND card_generation_run_id IS NOT NULL AND card_generation_outbox_id IS NOT NULL)
);

--> statement-breakpoint

-- ── 3. artifact 列迁成 result ──────────────────────────────────────────────
-- 旧列是裸产物引用；新列是 `{kind:"artifact",artifact:…}` 或
-- `{kind:"no_cards_recommended",reasonCodes:[…]}`，读侧因此只有一种解析。
ALTER TABLE public.agent_operations RENAME COLUMN artifact TO result;
UPDATE public.agent_operations SET result = jsonb_build_object('kind','artifact','artifact',result)
  WHERE result IS NOT NULL;
-- 存量行一律是裸引用（列名就叫 artifact），回填后不会误包。
ALTER TABLE public.agent_operations ADD CONSTRAINT agent_operations_result_shape_chk CHECK (
  result IS NULL OR jsonb_typeof(result)='object'
    AND result->>'kind' IN ('artifact','no_cards_recommended')
);

--> statement-breakpoint

-- ── 4. 事件列改名 ──────────────────────────────────────────────────────────
ALTER TABLE public.agent_run_events RENAME COLUMN job_status TO execution_status;

-- 0368 的字面函数体不会跟着改名，不重建它，三个现役 note 能力的终态事务全部失败。
-- 只换列名，绑定与唤醒语义逐字保留。
CREATE OR REPLACE FUNCTION public.ailearn_agent_job_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE op record; event_seq bigint;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  SELECT o.*,r.status AS run_status,r.revision AS current_revision INTO op
  FROM public.agent_operations o JOIN public.agent_runs r ON r.id=o.run_id
  WHERE o.job_id=NEW.id AND o.workspace_id=NEW.workspace_id AND o.user_id=NEW.requested_by;
  IF NOT FOUND THEN RETURN NEW; END IF;
  INSERT INTO public.agent_run_events(run_id,workspace_id,user_id,revision,operation_id,execution_status)
  VALUES(op.run_id,op.workspace_id,op.user_id,op.revision,op.id,NEW.status::text) RETURNING seq INTO event_seq;
  IF op.revision=op.current_revision AND op.run_status IN ('queued','running','waiting','paused')
     AND NEW.status::text IN ('succeeded','dead','failed') THEN
    INSERT INTO public.jobs(type,workspace_id,requested_by,payload,status,priority,resource_class,idempotency_key)
    VALUES('agent_run_advance',op.workspace_id,op.user_id,
      jsonb_build_object('runId',op.run_id,'revision',op.revision),'pending',60,'maintenance',
      'agent-wake:'||op.run_id::text||':'||op.revision::text||':'||event_seq::text)
    ON CONFLICT (workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
-- CREATE OR REPLACE 保留既有 ACL，这里不动授权。

--> statement-breakpoint

-- ── 5. 制卡领域的回执触发器 ────────────────────────────────────────────────
-- 与 jobs 上那个同构，但只认被绑定的那一发初始 outbox：审核台之后的重检／重写／重排
-- 各自产生新 outbox、没有绑定，这里整段跳过，不被已 completed 的旧目标叫醒。
CREATE FUNCTION public.ailearn_agent_card_run_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE op record; event_seq bigint; next_status text;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  SELECT o.*, r.status AS run_status, r.revision AS current_revision INTO op
  FROM public.agent_operations o JOIN public.agent_runs r ON r.id = o.run_id
  WHERE o.card_generation_run_id = NEW.id
    AND o.workspace_id = NEW.workspace_id AND o.user_id = NEW.user_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  -- 取消先落操作终态，随后的领域状态变化对它只是噪音。
  IF op.status NOT IN ('accepted','running','outcome_unknown') THEN RETURN NEW; END IF;
  -- 这一发必须是初始那一发。
  IF NOT EXISTS (SELECT 1 FROM public.card_generation_run_outbox_v2 b
    WHERE b.id = op.card_generation_outbox_id AND b.run_id = NEW.id
      AND b.workspace_id = NEW.workspace_id AND b.job_type = 'card_generation_simplified_v1') THEN
    RETURN NEW;
  END IF;
  -- 审核可交付态与零推荐都只表示"结束了"；是什么结果由回执核对领域事实决定。
  next_status := CASE
    WHEN NEW.status IN ('review_ready','needs_attention','no_cards_recommended') THEN 'succeeded'
    WHEN NEW.status = 'cancelled' THEN 'cancelled'
    WHEN NEW.status IN ('failed','stale') THEN 'failed'
    ELSE NULL END;
  IF next_status IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.agent_run_events(run_id,workspace_id,user_id,revision,operation_id,execution_status)
  VALUES (op.run_id,op.workspace_id,op.user_id,op.revision,op.id,next_status) RETURNING seq INTO event_seq;
  -- 持久入队是唤醒的依据，LISTEN 只是加速。
  IF op.revision = op.current_revision AND op.run_status IN ('queued','running','waiting','paused') THEN
    INSERT INTO public.jobs(type,workspace_id,requested_by,payload,status,priority,resource_class,idempotency_key)
    VALUES('agent_run_advance',op.workspace_id,op.user_id,
      jsonb_build_object('runId',op.run_id,'revision',op.revision),'pending',60,'maintenance',
      'agent-wake:'||op.run_id::text||':'||op.revision::text||':'||event_seq::text)
    ON CONFLICT (workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ailearn_agent_card_run_event() FROM PUBLIC;
CREATE TRIGGER agent_card_run_event AFTER UPDATE OF status ON public.card_generation_runs_v2
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_agent_card_run_event();

--> statement-breakpoint

-- ── 6. 恢复扫描涵盖制卡，核对有界 ───────────────────────────────────────────
-- 三支逐字保留，jobs 内连接换 LEFT JOIN。制卡的"越界再唤醒"理由只有真实交付事实：
-- 审核开放且至少一张最新 revision 可审，或零推荐已落定。review_ready 但一张都不可审
-- 不算——否则永远不可交付的批次会把目标一次次叫醒。
CREATE OR REPLACE FUNCTION public.ailearn_enqueue_agent_recovery() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE inserted integer;
BEGIN
  -- Reconcile uncertain results using facts, with a bounded check budget and
  -- no repeated generation. A later saved artifact can still wake the goal.
  INSERT INTO public.agent_run_events(run_id,workspace_id,user_id,revision,operation_id,execution_status)
  SELECT r.id,r.workspace_id,r.user_id,r.revision,o.id,
    CASE WHEN o.job_id IS NOT NULL THEN j.status::text
      WHEN cr.status IN ('review_ready','needs_attention','no_cards_recommended') THEN 'succeeded'
      WHEN cr.status='cancelled' THEN 'cancelled' ELSE 'failed' END
  FROM public.agent_runs r JOIN public.agent_operations o ON o.run_id=r.id AND o.revision=r.revision
    LEFT JOIN public.jobs j ON j.id=o.job_id
    LEFT JOIN public.card_generation_runs_v2 cr ON cr.id=o.card_generation_run_id
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
            WHERE (i->>'noteId')::uuid=n.note_id AND (i->>'noteVersionId')::uuid=n.note_version_id))
      OR EXISTS(SELECT 1 FROM public.card_generation_candidates_v2 c
        WHERE c.workspace_id=cr.workspace_id AND c.run_id=cr.id
          AND c.quality_state='passed' AND c.review_decision='undecided'
          AND c.publish_state='unpublished' AND c.evidence_binding_plan_hash IS NOT NULL
          AND cr.status IN ('review_ready','needs_attention')
          AND NOT EXISTS(SELECT 1 FROM public.card_generation_candidates_v2 newer
            WHERE newer.workspace_id=c.workspace_id AND newer.run_id=c.run_id
              AND newer.candidate_id=c.candidate_id AND newer.revision>c.revision))
      OR cr.status='no_cards_recommended')
    AND NOT EXISTS(SELECT 1 FROM public.agent_run_events e WHERE e.operation_id=o.id AND e.processed_at IS NULL);
  INSERT INTO public.jobs(type,workspace_id,requested_by,payload,status,priority,resource_class,idempotency_key)
  SELECT 'agent_run_advance',r.workspace_id,r.user_id,jsonb_build_object('runId',r.id,'revision',r.revision),
    'pending',60,'maintenance','agent-recover:'||r.id::text||':'||r.revision::text||':'||floor(extract(epoch FROM now())/30)::text
  FROM public.agent_runs r JOIN public.user_companion_account_state a ON a.id=r.identity_id AND a.user_id=r.user_id
  WHERE a.global_enabled AND a.epoch=r.account_epoch
    AND EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=r.user_id AND m.left_at IS NULL)
    AND (r.status IN ('queued','running') OR (r.status IN ('waiting','paused') AND EXISTS(
      SELECT 1 FROM public.agent_run_events e WHERE e.run_id=r.id AND e.revision=r.revision
        AND e.processed_at IS NULL AND e.execution_status IN ('succeeded','failed','dead'))))
    AND NOT EXISTS(SELECT 1 FROM public.jobs j WHERE j.workspace_id=r.workspace_id AND j.requested_by=r.user_id
      AND j.type='agent_run_advance' AND j.payload->>'runId'=r.id::text
      AND j.payload->>'revision'=r.revision::text AND j.status IN ('pending','running'))
  ON CONFLICT (workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END $$;
REVOKE ALL ON FUNCTION public.ailearn_enqueue_agent_recovery() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ailearn_enqueue_agent_recovery() TO ailearn_worker;

--> statement-breakpoint

-- ── 7. 取消／修订也停掉制卡这一发 ───────────────────────────────────────────
-- 原来只杀 jobs 行，制卡链完全不受"停止目标"影响。锁顺序与父围栏一致：
-- parent（上面已锁）→ card → outbox。只碰被绑定的那一发，已成功的成果保留。
CREATE OR REPLACE FUNCTION public.ailearn_cancel_agent_operations(p_run uuid,p_revision integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.agent_runs WHERE id=p_run AND revision=p_revision
    AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.workspace_members m
    WHERE m.workspace_id=r.workspace_id AND m.user_id=r.user_id AND m.left_at IS NULL) THEN
    RAISE EXCEPTION 'agent scope not authorized' USING ERRCODE='42501';
  END IF;
  UPDATE public.jobs SET status='dead',lease_token=NULL,finished_at=now(),last_error='agent_cancelled'
    WHERE workspace_id=r.workspace_id AND requested_by=r.user_id AND status IN ('pending','running')
    AND id IN (SELECT job_id FROM public.agent_operations WHERE run_id=p_run AND revision=p_revision);
  -- 先收操作终态再动领域行：否则取消会顺手叫醒一个正要停下的目标。
  UPDATE public.agent_operations SET status='cancelled',error=NULL,updated_at=now()
    WHERE run_id=p_run AND revision=p_revision AND status IN ('accepted','running','outcome_unknown');
  -- 先把领域 run 收到终态（V3 的 CAS 来源状态集合不含 cancelled，迟到结果改不写它），
  -- 再收初始那一发 outbox 的租约。
  UPDATE public.card_generation_runs_v2 cr SET status='cancelled',error_code='agent_cancelled',
    error_message='这次目标已经停止，已做好的内容保留。',updated_at=now()
    FROM public.agent_operations o
    WHERE o.run_id=p_run AND o.revision=p_revision AND o.card_generation_run_id=cr.id
      AND cr.workspace_id=r.workspace_id AND cr.user_id=r.user_id
      AND cr.status IN ('queued','source_sealing','planning','authoring','checking');
  UPDATE public.card_generation_run_outbox_v2 b SET status='failed',lease_token=NULL,last_error='agent_cancelled'
    FROM public.agent_operations o
    WHERE o.run_id=p_run AND o.revision=p_revision AND o.card_generation_outbox_id=b.id
      AND b.workspace_id=r.workspace_id AND b.status IN ('pending','processing');
END $$;
REVOKE ALL ON FUNCTION public.ailearn_cancel_agent_operations(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ailearn_cancel_agent_operations(uuid,integer) TO ailearn_api,ailearn_worker;

--> statement-breakpoint

-- ── 8. 制卡这一发的父围栏 ──────────────────────────────────────────────────
-- 未绑定的 outbox（用户自己点的制卡、审核台后续几发）恒 true：它们本来就没有父围栏。
-- 判据与 ailearn_agent_job_current 对齐，另加"材料确实在目标冻结输入里"。
CREATE FUNCTION public.ailearn_agent_card_job_current(p_outbox uuid,p_workspace uuid,p_lock boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE allowed boolean; parent_run uuid; card_run uuid;
BEGIN
  SELECT o.run_id,o.card_generation_run_id INTO parent_run,card_run
  FROM public.agent_operations o WHERE o.card_generation_outbox_id=p_outbox LIMIT 1;
  IF parent_run IS NULL THEN RETURN true; END IF;
  -- 先父后子，与取消同一条路（见文件头）。
  IF p_lock THEN
    PERFORM r.id FROM public.agent_runs r WHERE r.id=parent_run FOR SHARE;
    PERFORM cr.id FROM public.card_generation_runs_v2 cr WHERE cr.id=card_run FOR SHARE;
    PERFORM b.id FROM public.card_generation_run_outbox_v2 b WHERE b.id=p_outbox FOR SHARE;
  END IF;
  SELECT true INTO allowed FROM public.agent_operations o
    JOIN public.agent_runs r ON r.id=o.run_id
    JOIN public.card_generation_runs_v2 cr ON cr.id=o.card_generation_run_id
    JOIN public.card_generation_run_outbox_v2 b ON b.id=o.card_generation_outbox_id AND b.run_id=cr.id
    JOIN public.user_companion_account_state a ON a.id=r.identity_id AND a.user_id=r.user_id
    WHERE o.card_generation_outbox_id=p_outbox AND o.workspace_id=p_workspace AND cr.workspace_id=p_workspace
      AND o.user_id=cr.user_id AND b.workspace_id=p_workspace AND o.revision=r.revision
      -- paused 保留：已接受的这发让它做完，但父目标不因此推进新步骤。
      AND r.status IN ('queued','running','waiting','paused') AND a.global_enabled AND a.epoch=r.account_epoch
      AND a.agent_settings->>'permissionLevel'<>'read_only'
      AND o.status IN ('accepted','running','outcome_unknown')
      AND EXISTS(SELECT 1 FROM public.workspace_members m
        WHERE m.workspace_id=p_workspace AND m.user_id=cr.user_id AND m.left_at IS NULL)
      AND EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(r.inputs) i
        WHERE (i->>'noteId')::uuid=cr.note_id AND (i->>'noteVersionId')::uuid=cr.note_version_id)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(r.inputs) i WHERE NOT EXISTS(
        SELECT 1 FROM public.notes n JOIN public.note_versions v ON v.note_id=n.id AND v.workspace_id=n.workspace_id
        WHERE n.id=(i->>'noteId')::uuid AND v.id=(i->>'noteVersionId')::uuid AND n.workspace_id=p_workspace
          AND n.deleted_at IS NULL AND (n.share_scope='shared' OR n.created_by=cr.user_id)));
  RETURN coalesce(allowed,false);
END $$;
REVOKE ALL ON FUNCTION public.ailearn_agent_card_job_current(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ailearn_agent_card_job_current(uuid,uuid,boolean) TO ailearn_worker;

--> statement-breakpoint

-- ── 9. 初始归属读取 ────────────────────────────────────────────────────────
-- worker 的链内事务是 userId=null，而 agent_operations/agent_runs 的 owner_scope
-- 要求 row.user_id = app.user_id：直查恒 0 行，所有 Agent 制卡会被误认成普通制卡，
-- 父预算与围栏整条绕过。绑定读取不是 current 判定，不按成员资格或终态过滤——
-- 取消或失去成员资格时仍必须知道「它有父目标」。
CREATE FUNCTION public.ailearn_agent_card_execution_binding(p_outbox uuid,p_workspace uuid)
RETURNS TABLE(operation_id uuid,agent_run_id uuid,revision integer,user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_workspace IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'')::uuid THEN
    RAISE EXCEPTION 'agent scope not authorized' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
  SELECT o.id,r.id,o.revision,cr.user_id
  FROM public.agent_operations o
    JOIN public.agent_runs r ON r.id=o.run_id
    JOIN public.card_generation_run_outbox_v2 b ON b.id=o.card_generation_outbox_id
    JOIN public.card_generation_runs_v2 cr ON cr.id=b.run_id AND cr.workspace_id=p_workspace
  WHERE o.card_generation_outbox_id=p_outbox AND o.workspace_id=p_workspace
    AND o.user_id=cr.user_id AND r.user_id=cr.user_id;
END $$;
REVOKE ALL ON FUNCTION public.ailearn_agent_card_execution_binding(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ailearn_agent_card_execution_binding(uuid,uuid) TO ailearn_worker;

--> statement-breakpoint

-- 属主收敛到 migrator（BYPASSRLS 语义依赖它）。触发器函数不给任何角色 EXECUTE。
ALTER FUNCTION public.ailearn_agent_card_run_event() OWNER TO ailearn_migrator;
ALTER FUNCTION public.ailearn_agent_card_job_current(uuid,uuid,boolean) OWNER TO ailearn_migrator;
ALTER FUNCTION public.ailearn_agent_card_execution_binding(uuid,uuid) OWNER TO ailearn_migrator;
