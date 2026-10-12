-- A goal runs until the work is delivered or a convergence fence stops it
-- (cancelled revision, lost lease, repeated empty turn, provider deadline).
-- A call counter frozen into the schema was none of those: it cut ordinary
-- long jobs at 16 model calls regardless of the model profile, and every
-- background generation a goal started charged that same counter.
ALTER TABLE public.agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_max_model_calls_check;
--> statement-breakpoint
ALTER TABLE public.agent_runs
  ALTER COLUMN max_model_calls DROP DEFAULT,
  ALTER COLUMN max_model_calls DROP NOT NULL;
--> statement-breakpoint
-- NULL now means "no ceiling". Rows that inherited the old default must not
-- keep reporting a limit the runtime no longer applies.
UPDATE public.agent_runs SET max_model_calls = NULL WHERE max_model_calls IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.agent_run_revisions
  DROP CONSTRAINT IF EXISTS agent_run_revisions_max_model_calls_check;
--> statement-breakpoint
ALTER TABLE public.agent_run_revisions
  ALTER COLUMN max_model_calls DROP NOT NULL;
--> statement-breakpoint
UPDATE public.agent_run_revisions SET max_model_calls = NULL WHERE max_model_calls IS NOT NULL;
