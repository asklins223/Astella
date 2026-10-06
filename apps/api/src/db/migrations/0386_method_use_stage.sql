-- 方案 44 §6.3：区分「目录被提供」「正文被阅读」「经验被实际采用」。
--
-- 背景（44 §2／§6.3 核对）：`companion_method_uses` 只有一种行——`readAgentMethod`
-- 带 consultation 时插的那一行，而统计口径是 `count(*) AS consulted_count`。
-- 也就是说**这张表里进来什么都被算成「被阅读」**。
--
-- 这在本轮之前恰好不出错，因为只有一种行。加上「专业任务读相关经验目录」（§6.1）之后
-- 就不成立了：目录出现会插进 offer 行，而 `count(*)` 会把它们一起算成阅读——
-- 正是 §6.3 点名禁止的那件事（「阅读次数不能直接记成采用或有帮助」）。
--
-- 所以先给这类记录一个**阶段**，再把统计口径按阶段收紧。
ALTER TABLE public.companion_method_uses
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'read';

-- 已有行都是 readAgentMethod 插的阅读记录，默认值刻意取 'read'：
-- 存量的语义没有变，只有新写入的 offer 会被区分出来。
ALTER TABLE public.companion_method_uses
  DROP CONSTRAINT IF EXISTS companion_method_uses_stage_check;
ALTER TABLE public.companion_method_uses
  ADD CONSTRAINT companion_method_uses_stage_check
  CHECK (stage IN ('offered', 'read', 'adopted'));

-- 「只被提供过」的方法不该收到质量评价：没读过正文的人判不了这条做法好不好。
-- 采用（adopted）与阅读（read）都可以收评价——用户是针对**具体一次使用**说的。
ALTER TABLE public.companion_method_uses
  DROP CONSTRAINT IF EXISTS companion_method_uses_feedback_requires_engagement;
ALTER TABLE public.companion_method_uses
  ADD CONSTRAINT companion_method_uses_feedback_requires_engagement
  CHECK (feedback IS NULL OR stage IN ('read', 'adopted'));

CREATE INDEX IF NOT EXISTS companion_method_uses_stage_idx
  ON public.companion_method_uses (workspace_id, user_id, method_id, method_revision, stage);
