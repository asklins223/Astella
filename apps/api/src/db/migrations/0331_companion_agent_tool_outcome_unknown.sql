-- A tool write can time out after its transaction or external side effect has
-- committed. Preserve that uncertainty as a first-class durable ledger state.

ALTER TABLE public.companion_agent_tool_calls
  DROP CONSTRAINT IF EXISTS companion_agent_tool_calls_status_check;
ALTER TABLE public.companion_agent_tool_calls
  ADD CONSTRAINT companion_agent_tool_calls_status_check
  CHECK (status IN (
    'requested', 'executing', 'waiting_confirmation', 'succeeded',
    'outcome_unknown', 'failed', 'blocked', 'expired'
  ));
