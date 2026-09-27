-- 复核结论第四档「原判过宽」（39d W5-5；39 §14.2 由三档扩为四档）
--
-- **为什么是新增迁移而不是改 0296**：0296 已经应用到 dev 库与一次性库，
-- 改它会让「已应用的迁移」与「仓库里的定义」分叉，而这一族判据的整套价值就是
-- 拿 information_schema 现读当前列（台账 §19 记过两次同类教训：坐标会腐烂）。
--
-- `over_broad`＝复核**可靠地**说原判把没答对的算成了答对（逐条全部降档）。
-- 它此前无处可归：真模型实测遇到过（原判 covered、复核逐条 missing），
-- 三档里只能落进 `undetermined`——而那是另一句话：`undetermined` 是
-- 「复核自己也判不准」，`over_broad` 是「上次说答对的那次不算」。用户该做的
-- 两件事完全不同（前者可以补充说明，后者该重看原回答）。
--
-- 落库侧的 CHECK 必须同步：这是 D2 的「唯一调度边界」纪律在争议族上的形状——
-- 枚举、CHECK、公开合同、判据四处必须同宽，少一处就会有一处 cast 失守。
ALTER TABLE public.assessment_disputes_v2
  DROP CONSTRAINT IF EXISTS assessment_disputes_v2_outcome_chk;

ALTER TABLE public.assessment_disputes_v2
  ADD CONSTRAINT assessment_disputes_v2_outcome_chk
  CHECK (recheck_outcome IS NULL OR recheck_outcome IN ('upheld', 'corrected', 'over_broad', 'undetermined'));

-- 存量为不受影响：三档期间写入的行全部落在新集合内，逐行不变。
COMMENT ON CONSTRAINT assessment_disputes_v2_outcome_chk ON public.assessment_disputes_v2 IS
  '复核结论四档：upheld 原判站得住 / corrected 原判偏严 / over_broad 原判过宽 / undetermined 判不出来（39 §14.2，2026-09-27 由三档扩为四档）';

-- `status` 那一列同样要放宽：第四档需要一个**自己的**状态名。
-- 复用 `recheck_undetermined` 看起来省事，但 §16.22 的读侧是按状态分别判的
-- （`recheck_upheld` 放行、其余扣住），合成一个状态就等于把「原判被否定了」
-- 也放行了——那正是这一档要防的事。
ALTER TABLE public.assessment_disputes_v2
  DROP CONSTRAINT IF EXISTS assessment_disputes_v2_status_chk;

ALTER TABLE public.assessment_disputes_v2
  ADD CONSTRAINT assessment_disputes_v2_status_chk
  CHECK (status IN ('open', 'recheck_upheld', 'recheck_corrected', 'recheck_over_broad', 'recheck_undetermined', 'closed_held'));
