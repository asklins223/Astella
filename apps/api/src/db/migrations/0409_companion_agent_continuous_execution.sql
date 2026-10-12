-- Agent steps describe actual work. Task limits belong to explicit execution
-- policy, not a historical eight-step database constraint.
ALTER TABLE public.companion_agent_steps
  DROP CONSTRAINT IF EXISTS companion_agent_steps_step_no_check;
--> statement-breakpoint
ALTER TABLE public.companion_agent_steps
  ADD CONSTRAINT companion_agent_steps_step_no_check CHECK (step_no >= 1);
--> statement-breakpoint
-- Renewed runs accumulate active time across attempts. A signed 32-bit ms
-- counter must not create an accidental total-duration cap after ~25 days.
ALTER TABLE public.companion_turn_runs
  ALTER COLUMN agent_elapsed_ms TYPE bigint USING agent_elapsed_ms::bigint;
