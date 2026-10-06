-- 0289 —— 轮次族三把「只追加」守卫加一条级联豁免（39d 登记的 P0 回归；F 台账 F43）。
--
-- 症状（2026-09-26 实测，改前）：解散一个真的学习过笔记的空间必然失败——
--   SELECT public.astella_dissolve_workspace(ws, owner)
--   → ERROR: note_learning_round_artifacts is append-only: DELETE is not allowed
--            (round 8db5c0aa-…, artifact 526eb2f0-…)   [code P0001]
-- 同一条路还覆盖"删用户／数据保留请求"（39 §10.3 末段明写删除要继续按既有规则走）。
--
-- 为什么会出现：0282 给父表 `note_learning_rounds` 装的是 `nlr_identity_immutable`，
-- 那是 **BEFORE UPDATE** 一把——父行删得掉；0283/0284/0285 给三张子表装的是
-- **BEFORE UPDATE OR DELETE**，把删除也挡了。于是父表那发 DELETE 沿外键级联下来时，
-- 子表守卫在半路抛异常、整个事务回滚。绕行口子 `app.allow_history_mutation`
-- 在生产代码里一处都没设（全仓只命中 probes 与集测夹具）。
--
-- 为什么"挡住级联"不是保护：这一族的历史只有在**父轮次还在**时才谈得上被改写。
-- 父行既然可删（今天的实情），挡下级联并不会多留住任何一行——它只是在一次合法的
-- 拆租户半途制造一个硬错误，把"这个空间再也解散不了"当成代价。真正的保护是另外两条，
-- 它们在本迁移之后仍然成立：
--   1. 直接改子表的行仍然红（UPDATE 那一挡一字未动）；
--   2. **父行还在时**直接删子表的行仍然红——`note-learning-round-service-postgres`
--      第 431 行那条"超户也绕不过触发器"的用例就是这一条，它删的时候轮次行仍在场，
--      所以本豁免对它无效（不是"改完就把它改绿"，是它本来就不该被放过）。
--
-- 判据为什么用"父行查不到"而不是别的信号：Postgres 的 RI 级联触发器是在**父行已删之后、
-- 同一语句内**逐行触发的，所以此刻按 `OLD.round_id` 回查父表必然查不到；而一次针对
-- 子表的直接 DELETE 发生在父行还在的时候，回查得到。两者可分，且不依赖会话变量、
-- 不依赖调用方自觉——放在触发器里，比放在每个调用点前面对它诚实。
--
-- 外键次序一句：`note_learning_round_teachings.artifact_id` 指回 artifacts，那条外键是
-- 默认的 NO ACTION（0285 末尾注释记过原因），级联删完两侧后在语句末尾才核，不会先报错。

CREATE OR REPLACE FUNCTION public.prevent_note_learning_round_plan_mutation()
RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_history_mutation', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.note_learning_rounds r WHERE r.id = OLD.round_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'note_learning_round_plan_revisions is append-only: % is not allowed (round %, plan ordinal %)',
    TG_OP, OLD.round_id, OLD.plan_ordinal;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.prevent_note_learning_round_teaching_mutation()
RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_history_mutation', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.note_learning_rounds r WHERE r.id = OLD.round_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'note_learning_round_teachings is append-only: % is not allowed (round %, ordinal %)',
    TG_OP, OLD.round_id, OLD.ordinal;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.prevent_note_learning_round_artifact_mutation()
RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_history_mutation', true) = 'on' THEN
    -- BEFORE DELETE 里 NEW 是 NULL，返回 NULL 的语义是"跳过这一行"（0283 真踩过）。
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.note_learning_rounds r WHERE r.id = OLD.round_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'note_learning_round_artifacts is append-only: % is not allowed (round %, artifact %)',
    TG_OP, OLD.round_id, OLD.id;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

COMMENT ON FUNCTION public.prevent_note_learning_round_plan_mutation() IS
  '计划修订只追加：挡 UPDATE；DELETE 只在"祖先那一轮已经不在"（外键级联）时放行（0289）。';

--> statement-breakpoint

COMMENT ON FUNCTION public.prevent_note_learning_round_teaching_mutation() IS
  '教学产物只追加：挡 UPDATE；DELETE 只在"祖先那一轮已经不在"（外键级联）时放行（0289）。';

--> statement-breakpoint

COMMENT ON FUNCTION public.prevent_note_learning_round_artifact_mutation() IS
  '动态产物只追加：挡 UPDATE；DELETE 只在"祖先那一轮已经不在"（外键级联）时放行（0289）。';
