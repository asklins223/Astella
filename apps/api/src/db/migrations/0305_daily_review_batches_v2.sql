-- 0305 —— **"今天这一批"的锁**（39d W7-4 刀三；39 §9.4 第一段）。
--
-- §9.4 写死了一句今天没有落点的话：
--   「批次一旦开始，**不因后台新任务到期不断增加长度**；用户主动加量才加入新的任务。」
--
-- 刀一落了判据（`planLimitedBatchV2`：`lockedLength` 是入参），刀二落了读侧
-- （`loadLimitedBatchV2`：`lockedLength` 原样传下去）。但 **`lockedLength` 从哪来**
-- 至今没人答：每次调用都得由调用方给一个数，而调用方（屏上、首页、伴星）每一次
-- 进来都会重算"今天该有多少道"——于是这句话只在**单次调用内**成立，跨轮不成立。
--
-- 为什么落一张"天"粒度的表，而不是往 `review_schedules` 上加一列：
-- 批次是**她今天看到的那个列表**，不是任何一条安排的性质。`review_schedules` 是
-- **派生**的排期行（刀三：被消费掉就没有了），把"今天这一批有多长"写在某一行的
-- 上一批一换行就丢；而 §9.4 恰恰要求"系统结束本批后可以看到今天先到这里"——
-- 那个读数要活过这一批里的任何一行。
--
-- **一天一行**（`day_key` 按她的时区日历日算出），续同一批时读它、加量时改它。
-- 这就是 §9.4 那句"批次长度在**开始时**锁定"唯一可能的落点：锁的是一个数，不是
-- 一批行。
--
-- **不记"今天已经出了几题"**——那是 `review_schedules` 的账（数被消费的安排），
-- 在这里再记一份就会有两本账。这一张表只记**长度**与**加量**。
--
-- 唯一键 (workspace_id, user_id, day_key) 的 RLS 与 0303 同一套形状：按
-- (workspace, user) FORCE，worker 那一支**不进**（这张表只有本人那一侧读写）。
CREATE TABLE IF NOT EXISTS daily_review_batches_v2 (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL,
  user_id           uuid NOT NULL,
  -- 她时区下的日历日（'YYYY-MM-DD'）。跨日另起一批：§9.4「本批」的边界是"今天"。
  day_key           text NOT NULL,
  -- 本批开始时锁的长度。刀一的 `lockedLength` 读它。
  locked_length     integer NOT NULL CHECK (locked_length >= 0),
  -- 她一共主动点过几次「再来几道」，以及一共加了多少题。
  -- 两个都记是因为屏上要能说清"这批怎么变成现在这么长的"，而只记和就说不出来
  -- （一次加 5 和五次各加 1 落到 locked_length 上是同一个数）。
  bump_count        integer NOT NULL DEFAULT 0 CHECK (bump_count >= 0),
  bumped_by         integer NOT NULL DEFAULT 0 CHECK (bumped_by >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_review_batches_v2_scope_uq UNIQUE (workspace_id, user_id, day_key),
  CONSTRAINT daily_review_batches_v2_length_covers_bumps
    CHECK (locked_length >= bumped_by)
);

ALTER TABLE daily_review_batches_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_review_batches_v2 FORCE ROW LEVEL SECURITY;

CREATE POLICY daily_review_batches_v2_select ON daily_review_batches_v2
  FOR SELECT USING (workspace_id = current_setting('app.workspace_id')::uuid
                AND user_id      = current_setting('app.user_id')::uuid);
CREATE POLICY daily_review_batches_v2_insert ON daily_review_batches_v2
  FOR INSERT WITH CHECK (workspace_id = current_setting('app.workspace_id')::uuid
                     AND user_id      = current_setting('app.user_id')::uuid);
CREATE POLICY daily_review_batches_v2_update ON daily_review_batches_v2
  FOR UPDATE USING (workspace_id = current_setting('app.workspace_id')::uuid
                AND user_id      = current_setting('app.user_id')::uuid)
            WITH CHECK (workspace_id = current_setting('app.workspace_id')::uuid
                     AND user_id      = current_setting('app.user_id')::uuid);

-- ⚠️ **前缀是 `app.` 不是 `ailearn.`**：全仓 379 处策略都用 `current_setting('app.workspace_id')`
-- （运行时由 `db/client.ts` 的 `set_config` 建立并回读校验）。**0305/0306 第一版写成了
-- `ailearn.`**——而那个占位符在会话里**从不被创建**，于是策略求值时
-- `unrecognized configuration parameter "ailearn.workspace_id"`，被测路径一读就炸。
-- **它不会红在部署上**（部署走超户/所有者，FORCE RLS 那时也还没建），只红在被测路径。
COMMENT ON TABLE daily_review_batches_v2 IS
  '39 §9.4「批次一旦开始，不因后台新任务到期不断增加长度；用户主动加量才加入新的任务」的锁。一天一行，只记长度与加量，不记今天出了几题。';
