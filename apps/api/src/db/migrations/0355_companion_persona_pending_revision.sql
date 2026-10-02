-- 0355: staged account persona revision — the "pending" pointer (A50 / 40 §4.8.4).
--
-- 为什么要有这一列
-- 0341 之后 `companion_persona_profiles` 上只有 `revision` + `profile`：任何一次写入都
-- **立刻**成为当前版本。于是「模型自改在下一次会话建立时生效，用户直接纠正可从下一轮
-- 未开始的调用生效」这句合同在结构上没有落脚点——当场生效就等于长会话中途换人
-- （与「一次调用使用固定版本」直接冲突），不写则那一版连同作者与依据一起丢掉。
--
-- `pending_revision` 是**指针**，不是第二份正文：那一版仍然只存在于
-- `companion_persona_profile_versions`（append-only）里，指针只说明「这一版已经排好队，
-- 还没生效」。于是：
--   * 「待生效版本可见」（A50）= 一个指针 + 那条不可变版本行，读路径一次 JOIN 就够；
--   * 不必维护两份可能漂移的正文，也就没有「指针指了 A、正文是 B」这种状态。
--
-- 三条不变量由数据库兜底，不靠应用层自觉：
--   1. CHECK：待生效一定比当前新（`pending_revision > revision`）。少了它，
--      "待生效" 可以退化成与当前同一版自指，UI 上就会出现两个"当前"。
--   2. FK (user_id, pending_revision) → versions (user_id, revision)：指针只能指向
--      **本账号自己**那条不可变版本行；别的账号的版本指不过去，也不必在应用层
--      复查一遍账号归属。
--   3. 版本行仍然 append-only（0341 的授权 + 0356 的 run 固定锁），所以"待生效"
--      指的那一版不会被谁事后改写成另一份内容。

ALTER TABLE public.companion_persona_profiles
  ADD COLUMN IF NOT EXISTS pending_revision integer;

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.companion_persona_profiles
    ADD CONSTRAINT companion_persona_profiles_pending_revision_check
    CHECK (pending_revision IS NULL OR pending_revision > revision);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.companion_persona_profiles
    ADD CONSTRAINT companion_persona_profiles_pending_version_fkey
    FOREIGN KEY (user_id, pending_revision)
    REFERENCES public.companion_persona_profile_versions (user_id, revision);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

COMMENT ON COLUMN public.companion_persona_profiles.pending_revision IS
  'Staged persona version that is not effective yet. A new run binds the current '
  'revision and must ignore this pointer; the staged version becomes current only '
  'through an explicit activation that moves revision.';

--> statement-breakpoint

-- 约束真的落上了吗。0342 用同一个 DO 块做自检：迁移被裁剪、被手工改过、
-- 或者在旧库上重跑时，这里会当场炸，而不是等到第一次"待生效不生效"才被发现。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'companion_persona_profiles'
       AND column_name = 'pending_revision'
  ) THEN
    RAISE EXCEPTION 'companion persona pending revision column is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'companion_persona_profiles_pending_revision_check'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'companion_persona_profiles_pending_version_fkey'
  ) THEN
    RAISE EXCEPTION 'companion persona pending revision constraints are missing';
  END IF;
END;
$$;
