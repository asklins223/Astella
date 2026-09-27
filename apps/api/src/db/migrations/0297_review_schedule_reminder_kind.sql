-- 0297 —— 「仅提醒这一次」与「持续安排复习」在数据上分开（39d W5-4 刀一；39 §9.1 末段与 §16.24）。
--
-- 为什么是加一列而不是加一张表：
--  1. 两种东西**共用同一把唯一键**。§9.1 明写"一个目标可能同时被笔记与卡片授权覆盖……
--     内部维护授权来源，避免重复建立相同目标、相同回访目的的待办"——所以"这次只提醒一次"
--     与"这个目标持续安排复习"落在**同一个（空间, 人, 主体, 维度）格**里，是同一项记忆需求的
--     两种授权档位，不是两项需求。新开一张表就等于允许同一格同时挂两份待办，那正是 0287
--     那把部分唯一索引要防的事。
--  2. 两种东西的**差别只有一件事**：处理掉之后会不会自己长出下一次。把它做成"关闭这一条"
--     的那一个状态位，比做成另一张表更贴近真实语义，也不用为它再写一遍取数、翻页与撤权过滤。
--
-- 存量回填成 `sustained`（默认值即此）：今天能写进这张表的只有三个调用方——结算
-- （`run-processing-tick` 的首次与继任两发）、卡片激活授权、以及本次新增的单次提醒入口。
-- 前两个按定义都是持续安排（§9.1："创建卡、读过笔记或结束一轮都不默认授权未来提醒"，
-- 能排上说明已有明确授权，且授权一开就"按实际观察继续安排"）。把存量判成 one_time
-- 才是危险的方向：那些行会在处理后**静默不再排下一次**，而没有任何人授权过这件事。
--
-- 不加 CHECK 之外的约束（不改唯一索引、不加外键）：这一列不参与任何键，它只是"这一条
-- 是一次性的还是持续的"这一个读数；把它塞进唯一键会立刻要求读侧全部认识它，而
-- `review-schedule-single-writer.test.ts` 那份读侧台账正是在等那一批（19 处读点逐条登记）。
--
-- 提醒的**处理与学习判定分开**这一条不靠这列实现：关闭单次提醒走的是一个显式命令
-- （`one-time-reminder-service.ts` 的 acknowledge），打开通知、进入笔记、快速回顾都不写
-- 任何一行；§16.24 的验收"打开通知和部分学习不默认关闭提醒"由那条命令的调用面保证。

ALTER TABLE public.review_schedules
  ADD COLUMN IF NOT EXISTS reminder_kind text NOT NULL DEFAULT 'sustained';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'review_schedules_reminder_kind_chk'
  ) THEN
    ALTER TABLE public.review_schedules
      ADD CONSTRAINT review_schedules_reminder_kind_chk
      CHECK (reminder_kind IN ('one_time', 'sustained'));
  END IF;
END $$;

COMMENT ON COLUMN public.review_schedules.reminder_kind IS
  '39 §9.1：「仅提醒这一次」处理后不自动产生后续提醒；「持续安排复习」才按实际观察继续安排。存量全部为 sustained（见迁移头注第 3 条）。';
