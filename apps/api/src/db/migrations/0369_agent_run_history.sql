-- 方案 42 第一批 A：目标历史。
--
--   1. agent_runs 记下「当前这一版从什么时候开始」。0368 的 updated_at 每次推进
--      都被覆盖，旧版一旦被替换，它的真实时间就找不回来了。
--   2. agent_run_revisions 存档被替换掉的每一版：追加写的凭据，不是可改的状态。
--
-- 部署前发生过的修订没有任何存档，这里不替用户补写。

--> statement-breakpoint
-- revision=1 时「这一版开始的时间」就是建目标的时间，这是事实；已经是 revision>1
-- 的老目标，其当前版起点确实不可知，留空——迁移时间不是它开始的时间。
-- FORCE RLS 连表 owner 也要过策略，所以这条回填靠 ailearn_migrator 的 BYPASSRLS。
ALTER TABLE public.agent_runs ADD COLUMN revision_started_at timestamptz;
UPDATE public.agent_runs SET revision_started_at = created_at
  WHERE revision = 1 AND revision_started_at IS NULL;
ALTER TABLE public.agent_runs ALTER COLUMN revision_started_at SET DEFAULT now();

-- 双字段 keyset 分页：旧索引缺 id 这一列的 tie-break，updated_at 打平时还要再排一次。
CREATE INDEX agent_runs_owner_history_idx
  ON public.agent_runs(workspace_id, user_id, updated_at DESC, id DESC);

--> statement-breakpoint
CREATE TABLE public.agent_run_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL, workspace_id uuid NOT NULL, user_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  goal text NOT NULL CHECK (char_length(goal) BETWEEN 1 AND 8000),
  status text NOT NULL CHECK (status IN ('queued','running','waiting','paused','completed','failed','cancelled')),
  resume_from_revision integer CHECK (resume_from_revision > 0),
  conversation_id uuid REFERENCES public.companion_conversations(id) ON DELETE SET NULL,
  account_epoch integer NOT NULL,
  inputs jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(inputs) = 'array'),
  summary text, error text,
  model_calls integer NOT NULL DEFAULT 0 CHECK (model_calls >= 0),
  max_model_calls integer NOT NULL CHECK (max_model_calls BETWEEN 1 AND 32),
  -- 这一版开始 / 最后一次有动静 / 被存档的时刻。存档后不再变。
  started_at timestamptz, last_active_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  superseded_by_revision integer CHECK (superseded_by_revision > revision),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id,workspace_id,user_id) REFERENCES public.agent_runs(id,workspace_id,user_id) ON DELETE CASCADE,
  UNIQUE (run_id,revision), UNIQUE (id,workspace_id, user_id)
);

--> statement-breakpoint
-- 与既有 agent 表同一套范围策略：owner + 空间成员，且 FORCE RLS。
ALTER TABLE public.agent_run_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_run_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON public.agent_run_revisions FOR ALL
  USING (public.ailearn_agent_scope_current(workspace_id,user_id))
  WITH CHECK (public.ailearn_agent_scope_current(workspace_id,user_id));

-- 最小权限：只有追加与读取。UPDATE/DELETE 一律不给，历史是凭据不是可改的状态。
-- worker 也要写：伴星的 agent_revise_goal / agent_control_goal 工具走的是 worker
-- 宿主上的同一个 store，存档就发生在那个事务里。
-- roles.sql 的 ALTER DEFAULT PRIVILEGES 会在建表时自动给 ailearn_api 整套 CRUD，
-- 所以这里显式收回——迁移一落地权限就已经是对的，不寄托在之后的 bootstrap 上。
REVOKE ALL ON public.agent_run_revisions FROM PUBLIC, ailearn_api, ailearn_worker;
GRANT SELECT,INSERT ON public.agent_run_revisions TO ailearn_api, ailearn_worker;