-- 0338: Persist a running Agent model step result for lease recovery.
-- The payload stays on the existing workspace/user-scoped step row and is
-- cleared as soon as the step ledger takes over recovery responsibility.
ALTER TABLE public.companion_agent_steps
  ADD COLUMN IF NOT EXISTS checkpoint jsonb;

COMMENT ON COLUMN public.companion_agent_steps.checkpoint IS
  'Private, identity-keyed model-step recovery payload. Cleared when the step leaves running; never included in diagnostics.';
