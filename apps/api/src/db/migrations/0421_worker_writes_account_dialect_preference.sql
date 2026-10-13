-- 伴星的长期默认方言是**语义判定**的产物：只有并行结构化注意力解释器能分清
-- 「以后都用河南话」（写进账号）、「这句用四川话」（只盖这一轮）和「以后改回普通话」
-- （清掉但不碰用户另存的音色/语速描述）。判定发生在 worker，落点却是账号级那一行
-- `user_learning_preferences`，而合成侧（API）读的就是这一行。
--
-- 0075 当初有意把这张表留在 worker 可见范围之外（注释原话：「account-scoped
-- Companion 状态表不授权」）。那时账号级偏好只有 API 侧的作答模态与音色设置，
-- worker 确实没理由读它。现在多了一条由对话产生的偏好：不授权就只能写成静默失败，
-- 用户听到的是「她说记住了，下一轮又不说方言」——比拒绝写入更糟。
--
-- 授权仍保持最小，和 0075 给 worker 的其他表同一形状：
--   - 只给 SELECT/INSERT/UPDATE，不给 DELETE（撤回语义由偏好值本身表达）；
--   - 表上的 ENABLE/FORCE ROW LEVEL SECURITY 不变，
--     `user_learning_preferences_user_isolation` 仍要求
--     `user_id = app.user_id` 且行是账号级（workspace_id IS NULL）或本空间级；
--     worker 的每个事务都带 `app.user_id`，所以够不到别人的行，也够不到别的空间。
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'astella_worker') THEN
    GRANT SELECT, INSERT, UPDATE ON public.user_learning_preferences TO astella_worker;
  END IF;
END $$;
