-- 0301 —— 「停止本次评估」这条独立命令的数据面（39d W5-1；39 §5.5、§14.2、§16.36）。
--
-- §5.5 把三件事写成**三个独立动作**：「结束活动、取消 AI 任务和撤销未来复习授权是三个
-- 独立动作」。今天只有第一个（`LearningRunActionV1` 十二档里没有 `cancel_assessment`），
-- 而 `learning_assessments.status` 也**没有** `cancelled` 这一档——于是"停止本次评估"
-- 无处落脚：用户只能"先到这里"（那会连带要求 `abandonLockedEvidence`，把已经提交并
-- 锁定的作答丢掉），或者什么都不做（迟到的评分照常被采纳）。
--
-- 三条规则，**全部落在数据库而不是服务层**（与 W5-5 那一刀同一形状：写在服务层的规则
-- 会被下一处漏读绕过，而这一处漏读的后果是"用户明确取消了，系统照常改了他的学习事实"）：
--
--  1. `status` 枚举加 `'cancelled'`。它是**终态**，且**不要求** `report_hash`——
--     `learning_assessments_terminal_report_check`（0116）只对 completed/not_assessable
--     要求报告；被取消的评估本来就没有报告，硬要求一个会让取消这一发必须伪造一个哈希。
--  2. **迟到结果不得采纳**：触发器禁止 `cancelled` 走回任何别的状态。这条是本迁移的
--     重点——§5.5 原话「迟到报告不作为有效判定或调度依据」。若只把新值加进 CHECK 而
--     靠每一处 UPDATE 自己记得带 `status='running'`，漏一处就等于取消失效，而那种漏在
--     正常链路上**完全看不出来**（要等一次真实的取消后迟到才暴露）。
--  3. **已完成的判定不因取消而消失**：那条由既有约束与 `applyAction` 的分支保证
--     （`completed` / `not_assessable` 的那一发不接受 `cancel_assessment`）。这里只补
--     数据面上的一半——`cancelled` 与既有终态互斥，且不能互相转。
--
-- 为什么**不**用一张「取消记录」表：取消是**一次状态转移**，不是一件要留档的事；留档的
-- 那一半已经由 `learning_run_events`（每条命令都有事件）承担。再开一张表就要额外回答
-- "取消与评估的关联"和"取消记录的生命周期"两个问题，而它们没有任何一个能改善上面三条规则。
--
-- 存量：今天不可能有 `cancelled` 行（新值本轮才加），所以**无**回填。

ALTER TABLE public.learning_assessments
  DROP CONSTRAINT IF EXISTS learning_assessments_status_check;

--> statement-breakpoint

ALTER TABLE public.learning_assessments
  ADD CONSTRAINT learning_assessments_status_check CHECK (status IN (
    'queued', 'running', 'completed', 'not_assessable', 'failed', 'cancelled'
  ));

COMMENT ON CONSTRAINT learning_assessments_status_check ON public.learning_assessments IS
  '39 §5.5：cancelled 是「用户明确停止本次评估」的终态；不含 report_hash（被取消的评估没有报告）';

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.guard_learning_assessment_cancelled() RETURNS trigger AS $$
BEGIN
  -- §5.5：迟到报告**不作为有效判定或调度依据**。`cancelled` 走到任何别的状态都拒绝，
  -- 包括走回 failed——那会把"用户主动取消"改写成"系统没判出来"，两句完全不同的话。
  IF OLD.status = 'cancelled' AND NEW.status IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION
      'cancelled assessment is terminal; a late result is not adopted (39 §5.5, §16.36)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER learning_assessments_cancelled_terminal
  BEFORE UPDATE OF status ON public.learning_assessments
  FOR EACH ROW EXECUTE FUNCTION public.guard_learning_assessment_cancelled();

--> statement-breakpoint

COMMENT ON FUNCTION public.guard_learning_assessment_cancelled() IS
  '§5.5「迟到报告不作为有效判定或调度依据」的数据面执法：cancelled 不可离开';
