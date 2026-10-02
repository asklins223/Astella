-- 0356: a companion run's pinned persona identity is written exactly once
-- (40 §4.8.4「一次调用使用固定版本」/ 40b §5.3.2).
--
-- 为什么要有这道锁
-- 0355 之后账号人格有「当前 / 待生效」两版，而**产物**必须记着自己用的是哪一版
-- （0341 已经把 `persona_profile_revision` / `persona_examples_revision` /
-- `default_expression_version` 写在 run、日记检查点、每日摘要、念头上）。
-- 合同那句「一次调用使用固定版本，已生成产物不静默重写」此前只由**代码纪律**保证：
-- `companion-dialogue.ts` 的固定写法是 `WHERE persona_profile_revision IS NULL`。
-- 纪律不是结构——哪天有人把守卫条件放宽、或者哪条恢复路径顺手回写了这一列，
-- 结果是同一个 run 的前半段用旧人格、后半段用新人格，而旧消息**不会**被重写，
-- 于是产物与它声称的版本身份悄悄对不上，且没有任何报错。
--
-- 这里把那条纪律落到数据库：pin 一旦非空就不可改。允许 NULL → 值（首次固定），
-- 禁止 值 → 另一个值。对重试是安全的：同一个 run 重试时 handler 走的是
-- "已 pin" 分支，根本不会再写这几列。
--
-- 刻意**不**覆盖日记检查点 / 每日摘要 / 念头：那三处是
-- `INSERT … ON CONFLICT DO UPDATE SET persona_profile_revision = EXCLUDED.…`，
-- 重试会合法地换一版人格（那是**新的一次生成**，不是同一次调用被改写）。
-- 把锁加到它们上面会直接把重试打断，所以这道锁只落在「一次调用」的载体上：
-- `companion_turn_runs`。

CREATE OR REPLACE FUNCTION public.ailearn_lock_companion_run_persona_pin()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.persona_profile_revision IS NOT NULL
     AND ROW(NEW.persona_profile_revision, NEW.persona_examples_revision, NEW.default_expression_version)
        IS DISTINCT FROM
        ROW(OLD.persona_profile_revision, OLD.persona_examples_revision, OLD.default_expression_version)
  THEN
    RAISE EXCEPTION
      'companion run % is already pinned to account persona revision %; a run binds one fixed version',
      OLD.id, OLD.persona_profile_revision
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS companion_turn_runs_persona_pin_lock
  ON public.companion_turn_runs;
CREATE TRIGGER companion_turn_runs_persona_pin_lock
  BEFORE UPDATE ON public.companion_turn_runs
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_lock_companion_run_persona_pin();

--> statement-breakpoint

-- 自检：锁必须真的在表上，否则"代码纪律"就还是唯一的保证。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'companion_turn_runs_persona_pin_lock'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'companion run persona pin lock trigger is missing';
  END IF;
END;
$$;
