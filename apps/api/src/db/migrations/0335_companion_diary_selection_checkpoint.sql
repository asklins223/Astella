-- Keep the validated diary selection across job retries so draft recovery does
-- not spend the first model call again. The output is private and worker-only.
CREATE TABLE public.companion_diary_generation_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  task_id text NOT NULL,
  task_version integer NOT NULL CHECK (task_version > 0),
  input_snapshot_hash text NOT NULL CHECK (input_snapshot_hash ~ '^[0-9a-f]{64}$'),
  output jsonb NOT NULL,
  prompt_tokens integer NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens integer NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_diary_checkpoint_job_task_snapshot_unique
    UNIQUE (job_id, task_id, task_version, input_snapshot_hash),
  CONSTRAINT companion_diary_checkpoint_job_workspace_fk
    FOREIGN KEY (job_id, workspace_id)
    REFERENCES public.jobs(id, workspace_id) ON DELETE CASCADE
);

ALTER TABLE public.companion_daily_summaries
  ADD COLUMN selection_reason text
  CHECK (selection_reason IS NULL OR char_length(selection_reason) <= 240);

CREATE INDEX companion_diary_checkpoint_ws_user_idx
  ON public.companion_diary_generation_checkpoints(workspace_id, user_id, created_at);

ALTER TABLE public.companion_diary_generation_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_diary_generation_checkpoints FORCE ROW LEVEL SECURITY;

CREATE POLICY companion_diary_checkpoint_worker_scope
  ON public.companion_diary_generation_checkpoints FOR ALL TO astella_worker
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

REVOKE ALL PRIVILEGES ON public.companion_diary_generation_checkpoints FROM PUBLIC, astella_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_diary_generation_checkpoints TO astella_worker;
GRANT ALL PRIVILEGES ON public.companion_diary_generation_checkpoints TO astella_migrator;
