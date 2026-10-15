-- Independent from the model-result checkpoint: recovery can resume a complete
-- source scan before the main model call has produced any result.
ALTER TABLE public.companion_agent_steps
  ADD COLUMN IF NOT EXISTS compaction_checkpoint jsonb;

COMMENT ON COLUMN public.companion_agent_steps.compaction_checkpoint IS
  'Private, request/source/policy-bound semantic source progress. Replaced cumulatively; not coverage or diagnostics. Cleared when the step leaves running.';
