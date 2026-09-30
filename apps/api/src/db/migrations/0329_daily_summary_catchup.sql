-- 0329: 桌宠日记调度加**补跑**（P2-13）。
--
-- ## 原状：只在本地 01:00 那一小时投
--
-- 0198 的函数第一句判据是
--   `IF extract(hour FROM now() AT TIME ZONE tz) <> 1 THEN CONTINUE;`
-- 即**只有 01:00 那一小时**会投当天的 job。那一小时里服务下线、迁移、
-- 或机器重启 —— 这一天的日记就**永久丢失**：没有第二次机会，事后也无从补。
--
-- ## 为什么补跑是安全的
--
-- 入队用的是 `ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`，
-- 幂等键是 `daily-summary:<ws>:<user>:<date>`。也就是说：
-- **同一用户同一天，投过几次都只有一条**。所以放宽时间窗不会产生重复 job，
-- 只会在"确实缺那一天"时补上。
--
-- ## 新判据
--
--   1. 仍然**不在 00:00–00:59 投**——那是用户的静默时段，
--      01:00 之前动手没有意义（前一天的数据也才刚结束）。
--   2. 01:00 之后，**逐日回看**最近 `lookback` 天（默认 7）：
--      哪一天有活动、且还没有对应的 job，就补哪一天。
--   3. `lookback` 封顶而不是无限回看：停机超过一周的用户，
--      一次性灌 7 天的日记会把 worker 打满；再早的日记补出来也没有意义。
--
-- ## 行为变化
--
-- - 服务在 01:00 在线：与 0198 完全一致（当天投一次）。
-- - 服务在 01:00 下线、02:00 恢复：**补上**当天那一份（原先是永久丢失）。
-- - 服务停机 3 天：恢复后补 3 份。

-- ⚠️ 必须先 DROP 掉无参版本，否则它是**另一个重载**。
-- `CREATE OR REPLACE` 只在签名完全相同时才替换；签名变了就是新增一个函数，
-- 旧的 0 参数版本会带着 `hour <> 1` 的老逻辑继续存在——而 worker 调的正是它。
-- 结果就是"迁移成功、行为没变"，而且不报错。
DROP FUNCTION IF EXISTS public.ailearn_enqueue_companion_daily_summaries();

-- ⚠️ 这里**不能**给 lookback_days 写 DEFAULT 7。
-- 带默认值的 1 参版本本身就能用 0 个实参调用，于是下面那个 0 参包装
-- 变成多余的——同一个调用点 Postgres 报 `function ... is not unique`。
-- （实库集成测试当场逮到：worker 调的正是无参形式。）
CREATE OR REPLACE FUNCTION public.ailearn_enqueue_companion_daily_summaries(
  lookback_days integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  tz text;
  local_date text;
  v_workspace_id uuid;
  v_user_id uuid;
  v_inserted integer := 0;
  v_hour integer;
  v_offset integer;
  lookback integer := greatest(coalesce(lookback_days, 7), 1);
BEGIN
  FOR tz IN
    SELECT DISTINCT COALESCE(quiet_hours->>'timezone', 'Asia/Shanghai')
    FROM user_companion_account_state
    WHERE global_enabled = true
  LOOP
    -- 01:00 之前仍然不动手：那是静默时段，且前一天的数据刚刚才结束。
    -- 注意判据从「必须正好是 1 点」放宽成「1 点及以后」——
    -- 原来那一条让 01:00 之外的所有 tick 全部 CONTINUE，于是漏掉的���就再也补不回来。
    v_hour := extract(hour FROM now() AT TIME ZONE tz);
    IF v_hour < 1 THEN
      CONTINUE;
    END IF;

    FOR v_offset IN 1..lookback LOOP
      local_date := to_char((now() AT TIME ZONE tz)::date - v_offset, 'YYYY-MM-DD');

      FOR v_user_id IN
        SELECT u.user_id
        FROM user_companion_account_state u
        WHERE u.global_enabled = true
          AND COALESCE(u.quiet_hours->>'timezone', 'Asia/Shanghai') = tz
      LOOP
        SELECT wm.workspace_id INTO v_workspace_id
        FROM workspace_members wm
        WHERE wm.user_id = v_user_id
          AND wm.left_at IS NULL
        ORDER BY wm.joined_at ASC
        LIMIT 1;

        IF v_workspace_id IS NULL THEN
          CONTINUE;
        END IF;

        IF NOT (
          EXISTS (
            SELECT 1 FROM companion_messages
            WHERE workspace_id = v_workspace_id AND user_id = v_user_id
              AND created_at >= (local_date::date AT TIME ZONE tz)
              AND created_at < ((local_date::date + 1) AT TIME ZONE tz)
          )
          OR EXISTS (
            SELECT 1 FROM assistant_page_contexts
            WHERE workspace_id = v_workspace_id AND user_id = v_user_id
              AND created_at >= (local_date::date AT TIME ZONE tz)
              AND created_at < ((local_date::date + 1) AT TIME ZONE tz)
          )
          OR EXISTS (
            SELECT 1 FROM learning_runs
            WHERE workspace_id = v_workspace_id AND user_id = v_user_id
              AND created_at >= (local_date::date AT TIME ZONE tz)
              AND created_at < ((local_date::date + 1) AT TIME ZONE tz)
          )
          OR EXISTS (
            SELECT 1 FROM notes
            WHERE workspace_id = v_workspace_id AND created_by = v_user_id
              AND deleted_at IS NULL
              AND (created_at >= (local_date::date AT TIME ZONE tz)
                   AND created_at < ((local_date::date + 1) AT TIME ZONE tz)
                   OR updated_at >= (local_date::date AT TIME ZONE tz)
                   AND updated_at < ((local_date::date + 1) AT TIME ZONE tz))
          )
          OR EXISTS (
            SELECT 1 FROM learning_cards_v2
            WHERE workspace_id = v_workspace_id
              AND created_at >= (local_date::date AT TIME ZONE tz)
              AND created_at < ((local_date::date + 1) AT TIME ZONE tz)
          )
          OR EXISTS (
            SELECT 1 FROM sources
            WHERE workspace_id = v_workspace_id
              AND created_at >= (local_date::date AT TIME ZONE tz)
              AND created_at < ((local_date::date + 1) AT TIME ZONE tz)
          )
          OR EXISTS (
            SELECT 1 FROM jobs
            WHERE workspace_id = v_workspace_id AND requested_by = v_user_id
              -- ⚠️ 必须排除 companion_daily_summary 自己。
              --
              -- 实测（一次性库）：没有这个排除时函数会**自己喂自己**——
              -- 它刚投出去的那条 job，`scheduled_at` 就是 now()，落在
              -- 另一个日期的窗口里，于是那一���被当成"当天有活动"，
              -- 又被投一条。三次调用下来 1 → 1 → 0，库里却多出一条
              -- 根本不存在的日记。
              --
              -- 0198 只看 offset=1 且只在 01:00 跑一次，投出去的 job 落在
              -- 次日的窗口里，所以这个自喂被掩盖了；一旦允许补跑就暴露出来。
              --
              -- 语义上也该排除：日记 job 是这个函数的**产物**，不是用户活动。
              AND type <> 'companion_daily_summary'
              AND (scheduled_at >= (local_date::date AT TIME ZONE tz)
                   AND scheduled_at < ((local_date::date + 1) AT TIME ZONE tz)
                   OR finished_at >= (local_date::date AT TIME ZONE tz)
                   AND finished_at < ((local_date::date + 1) AT TIME ZONE tz))
          )
        ) THEN
          CONTINUE;
        END IF;

        INSERT INTO jobs
          (type, workspace_id, requested_by, payload, status, priority, resource_class, idempotency_key)
        VALUES
          ('companion_daily_summary', v_workspace_id, v_user_id,
           jsonb_build_object('date', local_date, 'timezone', tz, 'userId', v_user_id),
           'pending', 10, 'maintenance',
           'daily-summary:' || v_workspace_id || ':' || v_user_id || ':' || local_date)
        ON CONFLICT (workspace_id, idempotency_key)
          WHERE idempotency_key IS NOT NULL
        DO NOTHING;

        IF FOUND THEN
          v_inserted := v_inserted + 1;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN v_inserted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ailearn_enqueue_companion_daily_summaries(integer) TO ailearn_worker;

-- 无参包装：worker 的定时调用写的正是 `..._daily_summaries()`，
-- 上面把 0 参数版本 DROP 了，所以这里必须把它加回来（否则那条调用直接失败）。
CREATE OR REPLACE FUNCTION public.ailearn_enqueue_companion_daily_summaries()
RETURNS integer
LANGUAGE sql
AS $$
  SELECT public.ailearn_enqueue_companion_daily_summaries(7);
$$;

GRANT EXECUTE ON FUNCTION public.ailearn_enqueue_companion_daily_summaries() TO ailearn_worker;

COMMENT ON FUNCTION public.ailearn_enqueue_companion_daily_summaries() IS
  '无参包装：等价于 lookback_days = 7。worker 的定时调用走这个签名，不要改它。';

ALTER FUNCTION public.ailearn_enqueue_companion_daily_summaries(integer)
  SET search_path = pg_catalog, public;

COMMENT ON FUNCTION public.ailearn_enqueue_companion_daily_summaries(integer) IS
  '桌宠日记调度：本地时区 01:00 之后逐日回看最近 N 天，为**有活动且尚未入队**的日期补投 companion_daily_summary。'
  '幂等键 daily-summary:<ws>:<user>:<date> 保证重复 tick 不产生重复 job；'
  '这正是"01:00 下线导致当天日记永久丢失"能被补上的原因。';
