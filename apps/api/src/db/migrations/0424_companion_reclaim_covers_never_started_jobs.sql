-- 0424: 让"卡住的那一轮"真的能被回收（用户实测：上一条卡死后，新对话永远是
-- 「上一条她还没说完，这条没能发出去。等她说完，或者先点停止」）。
--
-- 0232 的回收只认三种孤儿：没有 job、job 行不存在、job 已 dead。2026-10-13 dev 库
-- 实测到第四种它管不到的形状：
--
--   companion_turn_runs 8e0bfa6c…  status=accepted  created 06:41:57
--   jobs eaa7d1c9…                 status=pending   attempts=0  scheduled 06:41:57
--
-- worker 在崩溃重启循环里（并行改动没补 shared 的导出），job **从来没被领走**。
-- 它既不是 dead 也没有消失，于是那条 run 永远占着会话上的 partial unique index，
-- 之后每一句都在写用户消息之前被 409 拒回——一次环境故障毒死整个会话，
-- 而且界面上没有那颗被提示出来的「停止」（停止只在本地握着活动轮回执时才渲染）。
--
-- 补的三类判据，都是"这一轮不会再有产出"的确定形状：
--   1. pending 且排队超过 5 分钟：没有 worker 在跑它（正常队列的 companion_agent
--      handler 预算是 110s，5 分钟已经富余三倍）；
--   2. running 但租约早就不续了：领走它的进程已经死了；
--   3. succeeded 而 run 还挂着：终态事务没走完（崩在最后一步）。
-- `failed` 刻意**不列**——那是"还会重试"的状态，`dead` 才是耗尽。
--
-- 错误码同时说清是哪一种（原来一律 JOB_DEAD，用户和排障都读不到真实原因）。
-- 这几个值要进事件 payload 的 `code`，所以同批补进 shared 的公开错误码枚举：
-- 不在枚举里的事件帧会被桌面主进程的严格校验整帧丢弃，等于回收了但客户端看不见。
--
-- 函数体其余部分（事件写入、seq 分配、TTL 刷新、pg_notify）与 0232 逐字相同；
-- owner 与授权沿用 0232（CREATE OR REPLACE 不改 owner / ACL）。

CREATE OR REPLACE FUNCTION public.astella_reclaim_orphaned_companion_runs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_conv record;
  v_run record;
  v_total integer := 0;
  v_seq bigint;
  v_code text;
BEGIN
  -- 逐会话、再逐 run 处理。孤儿本就稀少（worker 崩溃/被杀才会产生），用循环换取
  -- 可读性与"seq 分配一眼可验"，比把 row_number 在三条语句里各算一遍更不容易错。
  FOR v_conv IN
    SELECT r.conversation_id AS cid
    FROM public.companion_turn_runs r
    LEFT JOIN public.jobs j ON j.id = r.job_id
    WHERE r.status IN ('accepted', 'running')
      AND r.created_at < now() - interval '5 minutes'
      AND (r.job_id IS NULL OR j.id IS NULL OR j.status = 'dead'
        OR (j.status = 'pending' AND j.scheduled_at < now() - interval '5 minutes')
        OR (j.status = 'running'
            AND coalesce(j.lease_renewed_at, j.started_at) < now() - interval '5 minutes')
        OR (j.status = 'succeeded' AND j.finished_at < now() - interval '5 minutes'))
    GROUP BY r.conversation_id
  LOOP
    FOR v_run IN
      SELECT r.id, r.workspace_id, r.user_id, r.generation, r.account_epoch, r.job_id,
             j.status AS job_status, j.scheduled_at AS job_scheduled_at
      FROM public.companion_turn_runs r
      LEFT JOIN public.jobs j ON j.id = r.job_id
      WHERE r.conversation_id = v_conv.cid
        AND r.status IN ('accepted', 'running')
        AND r.created_at < now() - interval '5 minutes'
        AND (r.job_id IS NULL OR j.id IS NULL OR j.status = 'dead'
          OR (j.status = 'pending' AND j.scheduled_at < now() - interval '5 minutes')
          OR (j.status = 'running'
              AND coalesce(j.lease_renewed_at, j.started_at) < now() - interval '5 minutes')
          OR (j.status = 'succeeded' AND j.finished_at < now() - interval '5 minutes'))
      ORDER BY r.created_at, r.id
    LOOP
      v_code := CASE
        WHEN v_run.job_id IS NULL OR v_run.job_status IS NULL THEN 'JOB_MISSING'
        WHEN v_run.job_status = 'dead' THEN 'JOB_DEAD'
        WHEN v_run.job_status = 'pending' THEN 'JOB_NEVER_STARTED'
        WHEN v_run.job_status = 'running' THEN 'JOB_LEASE_LOST'
        ELSE 'JOB_FINISHED_WITHOUT_RUN'
      END;

      UPDATE public.companion_turn_runs
      SET status = 'failed',
          error_code = v_code,
          waiting_proposal_id = NULL,
          finished_at = now(),
          updated_at = now()
      WHERE id = v_run.id
        AND status IN ('accepted', 'running');

      IF NOT FOUND THEN
        -- 抢在回收之前被别的终态路径（cancel / supersede）收尾了。
        CONTINUE;
      END IF;

      -- 每个 run 两个事件：error @ seq、character.cue @ seq+1。
      UPDATE public.companion_conversations
      SET next_event_seq = next_event_seq + 2
      WHERE id = v_conv.cid
      RETURNING next_event_seq - 2 INTO v_seq;

      INSERT INTO public.companion_stream_events
        (conversation_id, seq, workspace_id, user_id, run_id, generation,
         account_epoch, type, payload, expires_at)
      VALUES
        (v_conv.cid, v_seq, v_run.workspace_id, v_run.user_id, v_run.id, v_run.generation,
         v_run.account_epoch, 'error',
         jsonb_build_object(
           'code', v_code,
           'message', '这一轮的处理任务没能跑起来，没有产出回复。',
           'recoverable', false,
           'requestId', v_run.id
         ),
         now() + interval '24 hours'),
        (v_conv.cid, v_seq + 1, v_run.workspace_id, v_run.user_id, v_run.id, v_run.generation,
         v_run.account_epoch, 'character.cue',
         jsonb_build_object('cue', jsonb_build_object(
           'version', 1, 'intent', 'uncertain', 'emotion', 'concerned', 'intensity', 0.45
         )),
         now() + interval '24 hours');

      UPDATE public.companion_stream_events
      SET expires_at = now() + interval '24 hours'
      WHERE conversation_id = v_conv.cid AND run_id = v_run.id;

      UPDATE public.companion_turn_runs
      SET last_event_seq = v_seq + 1, updated_at = now()
      WHERE id = v_run.id;

      PERFORM pg_notify(
        'astella_companion_events_v1',
        json_build_object('conversationId', v_conv.cid, 'maxSeq', v_seq + 1)::text
      );

      v_total := v_total + 1;
    END LOOP;
  END LOOP;

  RETURN v_total;
END;
$$;

COMMENT ON FUNCTION public.astella_reclaim_orphaned_companion_runs() IS
  '终结"job 不会再产出任何结果"的孤儿 companion run（0232 的三种 + 0424 的没领走/租约失效/收尾没落库）。'
  '由 worker 每 30s 触发；SECURITY DEFINER 才能跨租户扫描。';
