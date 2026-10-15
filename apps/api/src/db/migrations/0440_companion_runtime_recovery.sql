-- Private execution state is distinct from metadata exposed by diagnostics.
ALTER TABLE public.companion_agent_steps
  ADD COLUMN IF NOT EXISTS runtime_checkpoint jsonb;
ALTER TABLE public.companion_agent_tool_calls
  ADD COLUMN IF NOT EXISTS result_payload jsonb;
COMMENT ON COLUMN public.companion_agent_steps.runtime_checkpoint IS
  'Private hashed Agent working state at a model-step boundary. Not user history or a diagnostic payload.';
COMMENT ON COLUMN public.companion_agent_tool_calls.result_payload IS
  'Private complete tool result committed with its succeeded ledger transition; reused on interrupted-step recovery.';
