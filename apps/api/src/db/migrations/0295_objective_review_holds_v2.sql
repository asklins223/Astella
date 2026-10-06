-- 0295 —— 目标级「暂不安排」的数据面（39d W7-3 刀一；39 §9.1 规则表行 2、行 3 与同段两句补充）。
--
-- 为什么单独一张表，而不是在 `review_schedules` 上加一格状态：
--  1. 排除停的是**授权**，不是一条待办。用户点"暂不安排"时这个目标可能压根还没有
--     pending 安排（卡片还没保存、这轮刚学完），挂在安排行上就没地方放；而它要优先于
--     三种来意——笔记订阅、卡片订阅、以及结算时的自动排期（`learning_observed`）。
--     后两种尤其要紧：§9.1 原话"在笔记订阅继续有效时也不自动加回来"，最刺眼的违反
--     就是下一次结算把它排回来。
--  2. "不停止其他目标、不删除历史"⇒ 解除排除要留痕（哪一档解的），所以 `released_at`
--     可空、只让**活着的那一份**参与唯一性（部分唯一索引），历史行留在表里。
--     "还在不在排除中"按当前活行判，不翻历史拼——用终态行的有无反推状态是本项目在
--     别处踩过的坑（对账要按序重放，不能合并全部历史声明）。
--  3. 键里带 `user_id`：排除是本人对自己回访意愿的决定。同一篇笔记被别人一起学到时，
--     本人的"暂不安排"不能把别人的安排也停掉（与 0287 那条部分索引把 user_id 放进键里
--     同一理由）。
--
-- `note_id` 参与唯一键但不参与执法查找：§9.1 的口径是"本人在**当前笔记内**该目标"，
-- 设的时候按笔记记；执法那一发手上只有 objective id（`review_schedules.subject_id`
-- 的语义就是"可确认的目标 id"，见 0287 注释第 1 条），所以另有一条只按目标的活行索引。
-- objective id 都是全局 uuid，跨笔记串到同一个 id 上不会发生。

CREATE TABLE public.objective_review_holds_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES public.notes(id) ON DELETE CASCADE,
  objective_id uuid NOT NULL,
  reason_code text NOT NULL DEFAULT 'user_deferred_objective',
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  release_reason text,
  CONSTRAINT orh_v2_reason_chk CHECK (reason_code <> ''),
  CONSTRAINT orh_v2_release_chk CHECK (released_at IS NULL OR released_at >= created_at)
);

COMMENT ON TABLE public.objective_review_holds_v2 IS
  '39 §9.1：本人对某个目标"暂不安排"的持续排除；活着的那一份优先于笔记订阅、卡片订阅与结算自动排期';

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS orh_v2_ws_user_note_obj_live_idx
  ON public.objective_review_holds_v2 (workspace_id, user_id, note_id, objective_id)
  WHERE released_at IS NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS orh_v2_ws_user_obj_live_idx
  ON public.objective_review_holds_v2 (workspace_id, user_id, objective_id)
  WHERE released_at IS NULL;

--> statement-breakpoint

ALTER TABLE public.objective_review_holds_v2 ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY orh_v2_owner ON public.objective_review_holds_v2 FOR ALL TO PUBLIC
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.objective_review_holds_v2 TO astella_api;
GRANT ALL ON public.objective_review_holds_v2 TO astella_migrator;
