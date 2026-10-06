-- Reserve the maximum calls before leaving a short transaction. Failed and
-- interrupted calls count too; a crashed process cannot replenish a round budget.
CREATE TABLE public.note_learning_round_model_attempts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  round_id uuid NOT NULL REFERENCES public.note_learning_rounds(id) ON DELETE CASCADE,
  model_id text NOT NULL,
  reserved_calls integer NOT NULL CHECK (reserved_calls BETWEEN 1 AND 4),
  model_calls integer NOT NULL DEFAULT 0 CHECK (model_calls BETWEEN 0 AND reserved_calls),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  finished_at timestamptz,
  CHECK ((status = 'running') = (finished_at IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX nlrma_one_running ON public.note_learning_round_model_attempts(round_id) WHERE status = 'running';
--> statement-breakpoint
ALTER TABLE public.note_learning_round_model_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_learning_round_model_attempts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY nlrma_owner ON public.note_learning_round_model_attempts
  FOR ALL TO PUBLIC USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  ) WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.note_learning_round_model_attempts TO astella_api;
GRANT ALL ON public.note_learning_round_model_attempts TO astella_migrator;
