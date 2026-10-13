-- Follow-up prompts are generated after assistant.final so optional metadata cannot
-- extend the user's visible reply wait. The worker inserts the job in the same
-- terminal transaction as the assistant message.

-- Suggestions are presentation metadata, not message content. Keeping them in a
-- dedicated column preserves the canonical content hash and avoids firing the
-- message-edit triggers that withdraw reflection evidence.
ALTER TABLE public.companion_messages
  ADD COLUMN IF NOT EXISTS follow_up_prompts jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.companion_messages
  DROP CONSTRAINT IF EXISTS companion_messages_follow_up_prompts_check;
ALTER TABLE public.companion_messages
  ADD CONSTRAINT companion_messages_follow_up_prompts_check CHECK (
    jsonb_typeof(follow_up_prompts) = 'array'
    AND jsonb_array_length(follow_up_prompts) <= 3
  );

-- Suggestions do not change conversation evidence. Content edits still advance
-- the revision used to validate summaries; keep the list explicit if new
-- content-bearing message columns are added later.
DROP TRIGGER IF EXISTS companion_messages_context_revision_update ON public.companion_messages;
CREATE TRIGGER companion_messages_context_revision_update
  AFTER DELETE OR UPDATE OF blocks, content_sha256 ON public.companion_messages
  FOR EACH ROW EXECUTE FUNCTION public.astella_bump_conversation_context_revision();

GRANT SELECT, INSERT, UPDATE ON public.companion_messages TO astella_worker;

DROP POLICY IF EXISTS "worker_type_allowlist_insert_guard" ON public.jobs;
CREATE POLICY "worker_type_allowlist_insert_guard"
  ON public.jobs
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    CURRENT_USER = 'astella_worker'::name
    AND "type" IN (
      'companion_agent', 'companion_followup_suggestions',
      'companion_memory_extract', 'companion_summarizer',
      'companion_daily_summary', 'companion_memory_organize', 'companion_reflection'
    )
  );

ALTER TABLE public.companion_stream_events
  DROP CONSTRAINT IF EXISTS companion_stream_events_type_check;
ALTER TABLE public.companion_stream_events
  ADD CONSTRAINT companion_stream_events_type_check CHECK (type IN (
    'turn.accepted', 'assistant.status', 'assistant.delta', 'assistant.final',
    'assistant.followups.ready', 'agent.skill', 'agent.tool', 'character.cue',
    'action.proposed', 'action.decision', 'action.expired', 'action.started',
    'action.completed', 'action.failed', 'voice.segment.ready',
    'proactive.delivery', 'proactive.delivery.updated', 'turn.cancelled', 'error'
  ));
