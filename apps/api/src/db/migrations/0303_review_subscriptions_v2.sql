-- 0303 —— **持续回访授权的来源记法**（39d W7-3 刀五；39 §9.1 第一段与第三段）。
--
-- §9.1 写了两句今天都没有落点的话：
--   「笔记的『安排以后复习』…卡片的『开启复习』…**两种意图可以分别存在**」
--   「一个目标可能同时被笔记与卡片授权覆盖。**内部维护授权来源**，避免重复建立
--     相同目标、相同回访目的的待办；**取消一项授权不误删另一项**」
--
-- 现状：`ReviewAuthorizationSourceV2`（`note_subscription` / `card_review`）只活在
-- `packages/shared/src/review-authorization-rules-v2.ts` 的**类型**里——全仓没有任何一处
-- 写它、也没有任何一处读它。于是「暂停笔记复习时说明已单独开启的卡片是否继续」这句
-- 没有可查的来源，"分别开停"也没有那颗开关能拨。
--
-- 为什么是新表而不是往 `review_schedules` 上加一列 `source`：
-- 排期是**派生**（可调度状态的投影，§9.1 末段"笔记上的下次建议时间来自这些有效需求的
-- 聚合"），授权是**事实**。把来源写在排期行上，暂停一个来源就只能去改/删排期行——
-- 那恰好是「取消一项授权不误删另一项」要禁止的动作，而且排期被消费之后来源就没了。
-- 来源必须独立于排期存在，才能回答"这条安排**还由谁撑着**"。
--
-- 主体分两种（`subject_type`），不是把两件事硬塞进一张表：
--   - `note`     → 笔记订阅，主体是**整篇**。§9.1「笔记订阅覆盖此后在这篇笔记中实际
--                  学过、或经本人声明／首次回忆确认需要维护的核心目标」。
--   - `objective`→ 卡片订阅，主体是**那个目标**。「卡片的『开启复习』表示维护具体
--                  提取目标」。
--
-- **暂停保留行**（`status='paused'` + `paused_at`），不删：§9.1 行 1「仅停用该授权
-- 来源」说的是停，不是撤销授权。留着行，屏上那颗开关才在"关"的位置上；恢复是改
-- status 而不是插第二条，于是"她什么时候授权的、范围是什么"不会因为暂停而丢
-- （`scope_note` 必填就是 §9.1「开启时用一句话说明这个持续范围」的数据面形状）。
--
-- 唯一性只作用在**活着的那一份**上（部分唯一索引），与 0287／0295／0300 同一套形状。
--
-- 一次性提醒与目标排除都**不在**这张表里：前者是 `review_schedules.reminder_kind =
-- 'one_time'` 的那条排程，后者是 `objective_review_holds_v2`。三件事各有一张表，
-- 是为了让"取消一项授权不误删另一项"在结构上成立——它们本来就不该互相覆盖。
--
-- 隔离：RLS 按 (workspace_id, user_id) 两列，与 0300 同一支。不给
-- `CURRENT_USER = 'ailearn_worker'` 那一支：这张表的每一行都是"某个人自己的授权"，
-- worker 没有读取理由（伴星也不该代读别人的授权状态）。

CREATE TABLE public.review_subscriptions_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- 本人的授权就是本人的数据：键里必须带 user_id，否则停一个人的不会只停他的。
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- `note_subscription` / `card_review`。词表在 `review-authorization-rules-v2.ts`，
  -- 这里只存它交出来的值——两处各写一份词表就是迟早分叉的那种重复。
  source text NOT NULL,
  -- `note` = 笔记订阅（整篇）；`objective` = 卡片订阅（那个目标）。
  subject_type text NOT NULL,
  -- `note` 档是笔记 id；`objective` 档是目标 id。**不设外键**：目标被合并或退役时
  -- 不该顺手删掉她的授权记录——那会变成"悄悄取消订阅"，正是本迁移要防的那件事。
  subject_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  -- §9.1「开启时用一句话说明这个持续范围」。**必填**：屏上那句"这份安排还由谁撑着"
  -- 要能念出范围，而范围不存在时最诚实的读数是"没有这条授权"，不是空字符串。
  scope_note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  paused_at timestamptz,
  pause_reason text,

  CONSTRAINT rs_v2_source_chk CHECK (source IN ('note_subscription', 'card_review')),
  CONSTRAINT rs_v2_subject_type_chk CHECK (subject_type IN ('note', 'objective')),
  CONSTRAINT rs_v2_status_chk CHECK (status IN ('active', 'paused')),
  CONSTRAINT rs_v2_scope_chk CHECK (length(scope_note) > 0),
  -- 暂停的时间不能早于授权：反过来那一份读出来会读成"我暂停过一句还没说过的话"。
  CONSTRAINT rs_v2_paused_chk CHECK (
    (status = 'active' AND paused_at IS NULL) OR (status = 'paused' AND paused_at IS NOT NULL)
  )
);

COMMENT ON TABLE public.review_subscriptions_v2 IS
  '39 §9.1：笔记订阅与卡片订阅分别开停的来源记法；暂停保留行，唯一性只作用在活着的那一份';

--> statement-breakpoint

-- 一个（空间, 人, 来源, 主体）至多一份**活着**的授权。暂停留行 ⇒ 恢复改 status，
-- 不插第二条，于是"她什么时候授权的、范围是什么"不会因为暂停而丢。
CREATE UNIQUE INDEX IF NOT EXISTS rs_v2_ws_user_source_subject_live_idx
  ON public.review_subscriptions_v2 (workspace_id, user_id, source, subject_type, subject_id)
  WHERE status = 'active';

--> statement-breakpoint

-- 「这条安排还由谁撑着」那一发：调度边界每次问「覆盖我的来源有哪些」都走它。
CREATE INDEX IF NOT EXISTS rs_v2_ws_user_subject_live_idx
  ON public.review_subscriptions_v2 (workspace_id, user_id, subject_type, subject_id)
  WHERE status = 'active';

--> statement-breakpoint

-- 笔记订阅那一屏的读入口（按空间＋人列出她订阅了哪几篇）。
CREATE INDEX IF NOT EXISTS rs_v2_ws_user_source_status_idx
  ON public.review_subscriptions_v2 (workspace_id, user_id, source, status, created_at);

--> statement-breakpoint

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['review_subscriptions_v2'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      DROP POLICY IF EXISTS %I_workspace_user_isolation ON public.%I
    $p$, t, t);
    EXECUTE format($p$
      CREATE POLICY %I_workspace_user_isolation
        ON public.%I AS PERMISSIVE FOR ALL
        USING (
          workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
          AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
        )
        WITH CHECK (
          workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
          AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
        )
    $p$, t, t);
  END LOOP;
END $$;

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.review_subscriptions_v2 TO ailearn_api;
GRANT ALL ON public.review_subscriptions_v2 TO ailearn_migrator;
