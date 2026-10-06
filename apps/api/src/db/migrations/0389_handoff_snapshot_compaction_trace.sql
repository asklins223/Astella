-- 方案 44 §3.3／§5.3：把这一轮发生过的折叠记进交接快照（新版本，带围栏）。
--
-- 背景：交接快照的注释写的是「Immutable, source-bound record of the **exact** context
-- handed to one dialogue run」，而它在 agent loop **之前**就提交了。压缩发生在 loop 里，
-- 之后真正发出去的请求是折过的——于是那句「exact」在有压缩的那一轮是假的：
-- 从快照上看不出哪一段被折了、是哪份摘要顶替的、那次判定是过了触发线还是被拒绝。
--
-- 这里不加历史表（run_id 是主键，本来就是「一次 run 一份」），而是有围栏地把同一行
-- 推进到下一个版本：
--   - 围栏：run 仍在 accepted/running/waiting_for_confirmation，且版本号正好是读到的那个；
--     版本对不上说明已经有别处推进过，本次不动（迟到结果不许覆盖）。
--   - `modelMessages` **仍然是折叠前**的完整上下文——恢复时多给上下文永远比少给安全；
--     变的是多了 `compactions`，让审计能回答「实际发出去的是什么」。
-- ⚠ 这里踩过一个坑，值得留着名字。
-- 0337 加的约束叫 `companion_context_handoff_snapshots_snapshot_version_check`
-- （注意是 snapshot_version，前面还有 snapshot_），内容是 `snapshot_version = 1`。
-- 它把版本钉死在 1——正是我们要放开的。0389 的第一版只 DROP 了
-- `…_snapshots_version_check` 这个**不存在的**名字，于是新加了一条冗余的 `>= 1`，
-- 而真正的拦路虎一动没动：每次写入都会撞 `violates check constraint`。
-- 文本形状的判据全绿（名字对得上、语句读得懂），只有真跑一次数据库才看得见。
-- 两边都 DROP，避免换个名字再踩一次；随后重建一条只要求 >= 1 的。
ALTER TABLE public.companion_context_handoff_snapshots
  DROP CONSTRAINT IF EXISTS companion_context_handoff_snapshots_snapshot_version_check;
ALTER TABLE public.companion_context_handoff_snapshots
  DROP CONSTRAINT IF EXISTS companion_context_handoff_snapshots_version_check;
ALTER TABLE public.companion_context_handoff_snapshots
  ADD CONSTRAINT companion_context_handoff_snapshots_version_check
  CHECK (snapshot_version >= 1);

-- 折叠轨迹只记区间与那一轮的预算判定，不记正文（44 §3.3「只记模型路由与水位」）。
CREATE OR REPLACE FUNCTION public.astella_assert_handoff_snapshot_fence(
  p_run uuid, p_expected_version integer
) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.companion_context_handoff_snapshots s
    JOIN public.companion_turn_runs r ON r.id = s.run_id
    WHERE s.run_id = p_run AND s.snapshot_version = p_expected_version
      AND r.status IN ('accepted', 'running', 'waiting_for_confirmation')
  );
END $$;
REVOKE ALL ON FUNCTION public.astella_assert_handoff_snapshot_fence(uuid, integer) FROM PUBLIC;
-- 生产路径（worker）要能调用；migrator 也要——集成夹具按仓库约定用 migrator 写数据，
-- 少了这一条，真库验证会以 `permission denied for function` 收场，而那与围栏本身无关。
GRANT EXECUTE ON FUNCTION public.astella_assert_handoff_snapshot_fence(uuid, integer) TO astella_worker, astella_migrator;
