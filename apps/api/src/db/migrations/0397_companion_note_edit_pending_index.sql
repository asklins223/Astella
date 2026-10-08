CREATE INDEX IF NOT EXISTS companion_note_edit_pending_idx ON public.companion_agent_tool_calls(created_at)
  WHERE name='companion_edit_note' AND status='executing' AND result_ref IS NULL;
