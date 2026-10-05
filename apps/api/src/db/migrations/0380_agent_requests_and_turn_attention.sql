-- Interpretation belongs to this turn, independently of a durable goal.
ALTER TABLE public.companion_turn_runs ADD COLUMN turn_interpretation jsonb
  CHECK (turn_interpretation IS NULL OR jsonb_typeof(turn_interpretation)='object');
--> statement-breakpoint
ALTER TABLE public.agent_runs ADD COLUMN direct_request jsonb
  CHECK (direct_request IS NULL OR jsonb_typeof(direct_request)='object');
ALTER TABLE public.agent_run_steps ADD COLUMN execution_kind text NOT NULL DEFAULT 'model'
  CHECK (execution_kind IN ('model','declared_request'));
