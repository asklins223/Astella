-- 0366 —— 运维面板的**写**操作：重试失败作业、清理死信作业。
--
-- ─── 为什么要这两个函数 ───
--
-- 面板此前是纯只读的。一台只能看、不能做的控制台，对「有 7 个任务连续失败」
-- 这类问题给不出下一步——人看完数字，还是得自己开 psql。
--
-- 这两个动作是**运行状态**的操作，不是配置。选它们而不是「改配置」，是因为
-- 改配置要动部署（config 目录是 `:ro` 挂载），而这两条即时生效、不改部署、
-- 不需要重启任何进程。
--
-- ─── 三条边界（写操作比只读危险，逐条说明为什么这么设）─────────────────
--
--  1. **必须指定作业类型**。参数非空且过正则校验。不允许「重试全部」——
--     一次跨全部空间、全部类型的重试影响面不可控，而面板上的待办条目本来就
--     是按类型聚合的，粒度天然对得上。
--
--  2. **只碰 `failed`（重试）或 `dead`（清理），绝不动 `pending` / `running`。
--     一条正在跑的作业被重置成 pending 会产生两个 worker 同时处理同一份 payload
--     ——那是重复扣费与数据竞争，比原故障严重得多。
--
--  3. **`p_limit` 有上界（500）**。写在函数里而不是只写在路由里：函数可能被
--     别的调用方直接用，而无界的 UPDATE/DELETE 会锁住整张 jobs 表。
--
-- ─── 为什么重试必须把 attempts 归零 ───
--
-- 这条是本文件最关键的一行。`ailearn_claim_jobs` 的取活条件是
--
--     WHERE j.status = 'pending' AND j.attempts < parameters.max_attempts
--
-- （0018；max_attempts 默认 3，clamp 到 [1,10]）。一个 failed 作业的
-- attempts 通常已经是 3 —— 只把 status 改回 pending 而不重置 attempts，
-- 它会变成**永远取不走的僵尸**：队列里显示 pending、面板显示"已重试"，
-- 但没有任何 worker 会碰它。实测判据：这种状态与"正在排队"完全一样，
-- 没有任何东西会让它变红。
--
-- 所以人工重试 = 给它一轮全新的尝试次数，语义上也正是"再试一次"的意思。
--
-- ─── 为什么死信可以直接删 ───
--
-- 全仓（apps/api / workers / shared 的生产 TS）没有任何地方读取
-- `status = 'dead'` 的作业——`ailearn_reap_stale_jobs` 处理的是**租约超期的
-- running**，不是 dead。dead 是终态，删掉不会让任何读方失去依据，只让
-- `ailearn_job_queue_depth{status="dead"}` 的计数归零（那正是清理的目的）。
--
-- 代价：这些行的失败历史不再可查。面板在删除前会把数量与类型写进服务日志
-- （pino → stdout → 容器运行时收集），留一条事后可查的记录。

CREATE OR REPLACE FUNCTION public.ailearn_admin_retry_failed_jobs(
  p_job_type text,
  p_limit integer DEFAULT 100
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
DECLARE
  v_limit integer;
  v_affected integer;
BEGIN
  -- 必须指定类型（见文件头边界 1）。
  IF p_job_type IS NULL OR p_job_type !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'job type is required and must match ^[a-z][a-z0-9_]{0,63}$'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 上界写在函数里（见文件头边界 3）；下界至少 1，0 是"什么也不做"的误输入。
  v_limit := least(greatest(coalesce(p_limit, 100), 1), 500);

  WITH target AS (
    -- 优先重试最久没有动过的那些：它们最可能是真正卡住的。
    SELECT j.id
      FROM public.jobs j
     WHERE j.type = p_job_type
       AND j.status = 'failed'
     ORDER BY j.finished_at DESC NULLS LAST, j.id
     LIMIT v_limit
  )
  UPDATE public.jobs AS j
     SET status = 'pending',
         -- 关键：见文件头「重试必须把 attempts 归零」一节。
         attempts = 0,
         last_error = NULL,
         -- 这些列只有在对应状态才有意义；重置成 pending 后保留旧值会
         -- 让面板/指标误判"这条已经跑完了"。
         started_at = NULL,
         finished_at = NULL,
         lease_token = NULL,
         scheduled_at = now()
    FROM target
   WHERE j.id = target.id
     AND j.status = 'failed';

  -- 不能写成 `RETURNING ... INTO v_affected`：plpgsql 那个写法在**多行**结果上
  -- 会直接抛 "query returned more than one row"，而这里必然多行。
  -- 影响行数的正确读法是 ROW_COUNT。
  GET DIAGNOSTICS v_affected = ROW_COUNT;

  -- 第二次调用时没有 failed 了，ROW_COUNT 是 0 —— 幂等：返回 0 而不是报错。
  RETURN coalesce(v_affected, 0);
END;
$function$;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_admin_purge_dead_jobs(
  p_job_type text,
  p_limit integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
DECLARE
  v_limit integer;
  v_affected integer;
BEGIN
  IF p_job_type IS NULL OR p_job_type !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'job type is required and must match ^[a-z][a-z0-9_]{0,63}$'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_limit := least(greatest(coalesce(p_limit, 500), 1), 500);

  WITH target AS (
    SELECT j.id
      FROM public.jobs j
     WHERE j.type = p_job_type
       AND j.status = 'dead'
     ORDER BY j.finished_at DESC NULLS LAST, j.id
     LIMIT v_limit
  )
  DELETE FROM public.jobs AS j
    USING target
   WHERE j.id = target.id
     AND j.status = 'dead';

  -- 同上：多行结果必须用 ROW_COUNT，不能 RETURNING INTO。
  GET DIAGNOSTICS v_affected = ROW_COUNT;

  RETURN coalesce(v_affected, 0);
END;
$function$;

--> statement-breakpoint

-- ─── 授权 ───────────────────────────────────────────────────────────────
-- 与 0365 的只读视图同一套：REVOKE PUBLIC，只给 ailearn_api，不给 worker。
-- worker 不该有"人工重试/清理"的能力——那是运维的决定，不是队列消费者的事。

REVOKE ALL ON FUNCTION public.ailearn_admin_retry_failed_jobs(text, integer) FROM PUBLIC;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.ailearn_admin_retry_failed_jobs(text, integer) TO ailearn_api;

--> statement-breakpoint

GRANT ALL PRIVILEGES ON FUNCTION public.ailearn_admin_retry_failed_jobs(text, integer) TO ailearn_migrator;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_admin_purge_dead_jobs(text, integer) FROM PUBLIC;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.ailearn_admin_purge_dead_jobs(text, integer) TO ailearn_api;

--> statement-breakpoint

GRANT ALL PRIVILEGES ON FUNCTION public.ailearn_admin_purge_dead_jobs(text, integer) TO ailearn_migrator;

--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_admin_retry_failed_jobs(text, integer) IS
  '运维面板：重试某类 failed 作业。必须指定作业类型，只碰 failed（绝不碰 pending/running），上界 500。attempts 必须归零——claim_jobs 的条件是 attempts < max_attempts，不归零会得到永远取不走的僵尸作业。EXECUTE 只给 ailearn_api。';

--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_admin_purge_dead_jobs(text, integer) IS
  '运维面板：清理某类 dead 作业。必须指定作业类型，只碰 dead，上界 500。全仓生产代码不读 dead（reap 处理的是超期 running），因此删除安全；调用方须在删除前把数量写进服务日志。EXECUTE 只给 ailearn_api。';