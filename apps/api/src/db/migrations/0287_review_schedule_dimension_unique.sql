-- 0287 —— 回访安排的唯一边界：`review_dimension` 一列 + `pending` 上的部分唯一索引
--          （39d W7-2 的前置；判据与键的形状出自 39d-w02 D2 §3.1–§3.3）。
--
-- 为什么这一支必须先落：W7-2 要把「保存到卡组」与「保存并开启复习」拆成两颗按钮，
-- 而后者的语义是"建立或关联**唯一**那条安排"。改前这张表上**没有任何东西在保证这件事**：
-- 唯一索引只有 `review_schedules_pkey(id)` 与 `(id, workspace_id)`，
-- `review_schedules_subject_idx (subject_type, subject_id)` 是**普通**索引，
-- 而四处写入（`run-processing-tick.ts`）各自"先查后写"、没有并发保护——
-- 同一目标同一维度可以安静地长出第二条待办。
--
-- 三条键的形状，逐条给理由（D2 §3.2 原文的三条，这里是落地版）：
--  1. **用 `subject_id`，不把 `subject_type` 放进键里**：这一列被 CHECK 成恒为 `'card'`
--     （实测 36 行全是 `card`），放进键里只会给"同一目标用两种 subject_type 写进来"
--     留一条绕过唯一性的路。语义上 `subject_id` 就是"可确认的目标 id"。
--  2. **`WHERE status = 'pending'` 的部分索引**：终态行（completed/cancelled/
--     superseded/dismissed）必须允许同一目标留多行历史——要唯一的只有"待处理那一份"。
--  3. **维度参与键，且用 `NOT NULL DEFAULT ''` 而不是可空列**：可空的列在唯一索引里
--     **不参与比较**，"未指定维度"这一档会整个漏掉。新列没有存量行要回填，所以直接
--     取默认空串这一边（D2 §3.2 给的二选一，这里按迁移成本定）。
--
-- 存量：D2 §3.3 要求加索引前先做冲突探测。2026-09-26 在 dev 库现读
-- `pending` 按 `(workspace_id, user_id, subject_id)` 分组**冲突 0 组**
-- （25 pending / 10 completed / 1 cancelled）⇒ 不需要先把多余行转 superseded。
-- 全新库从 0001 重放也安全（列带默认值，索引建在空表上）。
--
-- 加索引而四处仍各自"先查后写"，只会把竞态从"多一条安排"变成"一次 23505"——
-- 所以同一批把四处 `insert` 收进 `apps/api/src/modules/review/review-schedule-boundary.ts`
-- 的那一个边界函数（撞了就交回**已有那一条**的真实到期时间，不静默、不报错）。

ALTER TABLE public.review_schedules
  ADD COLUMN IF NOT EXISTS review_dimension text NOT NULL DEFAULT '';

COMMENT ON COLUMN public.review_schedules.review_dimension IS
  '这条安排服务的是哪个观察维度；空串 = 未指定维度（这一档照样参与唯一性，所以列不可空——D2 §3.2 第 3 条）';

CREATE UNIQUE INDEX IF NOT EXISTS review_schedules_pending_subject_dim_unique
  ON public.review_schedules (workspace_id, user_id, subject_id, review_dimension)
  WHERE status = 'pending';

COMMENT ON INDEX public.review_schedules_pending_subject_dim_unique IS
  '39 §15.3-18：同一空间、同一人、同一目标、同一维度，待处理的安排只能有一份（终态行留多行历史）';
