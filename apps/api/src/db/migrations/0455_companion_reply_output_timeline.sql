-- Preserve visible output order after the short-lived SSE log expires.
-- Only public process/output fields belong in this archive.
CREATE OR REPLACE FUNCTION public.companion_process_event_payload(event_type text, event_payload jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE event_type
    WHEN 'assistant.thinking' THEN jsonb_build_object('index', event_payload->'index', 'text', event_payload->'text')
    WHEN 'assistant.status' THEN jsonb_build_object('status', event_payload->'status', 'safeLabel', event_payload->'safeLabel')
    WHEN 'assistant.delta' THEN jsonb_build_object('appendFrom', event_payload->'appendFrom', 'textDelta', event_payload->'textDelta')
    WHEN 'assistant.utterance' THEN jsonb_build_object('messageId', event_payload->'messageId', 'text', event_payload->'text')
    WHEN 'assistant.final' THEN jsonb_build_object('messageId', event_payload->'messageId')
    WHEN 'agent.tool' THEN jsonb_build_object('tool', jsonb_strip_nulls(jsonb_build_object(
      'toolCallId', event_payload#>'{tool,toolCallId}', 'name', event_payload#>'{tool,name}',
      'status', event_payload#>'{tool,status}', 'safeLabel', event_payload#>'{tool,safeLabel}',
      'safeSummary', event_payload#>'{tool,safeSummary}', 'proposalId', event_payload#>'{tool,proposalId}',
      'preparationToolCallId', event_payload#>'{tool,preparationToolCallId}',
      'noteCreated', event_payload#>'{tool,noteCreated}', 'noteEdit', event_payload#>'{tool,noteEdit}',
      'noteAnnotation', event_payload#>'{tool,noteAnnotation}')))
  END;
$$;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_archive_process_event()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.run_id IS NOT NULL AND NEW.type IN ('assistant.thinking', 'assistant.status', 'agent.tool',
      'assistant.delta', 'assistant.utterance', 'assistant.final') THEN
    UPDATE public.companion_turn_runs
    SET process_timeline = process_timeline || jsonb_build_array(jsonb_build_object(
      'version', 1, 'seq', NEW.seq, 'runId', NEW.run_id, 'type', NEW.type,
      'payload', public.companion_process_event_payload(NEW.type, NEW.payload)))
    WHERE id = NEW.run_id AND conversation_id = NEW.conversation_id
      AND workspace_id = NEW.workspace_id AND user_id = NEW.user_id AND generation = NEW.generation;
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint

-- Restore still-available output boundaries without replacing older archived
-- thinking. The distinct sequence also upgrades earlier tool result fields.
WITH available AS (
  SELECT run_id, jsonb_build_object('version', 1, 'seq', seq, 'runId', run_id, 'type', type,
    'payload', public.companion_process_event_payload(type, payload)) AS node
  FROM public.companion_stream_events
  WHERE run_id IS NOT NULL AND type IN ('assistant.thinking', 'assistant.status', 'agent.tool',
    'assistant.delta', 'assistant.utterance', 'assistant.final')
), affected AS (SELECT DISTINCT run_id FROM available), combined AS (
  SELECT r.id AS run_id, e.node, 0 AS priority
  FROM public.companion_turn_runs r JOIN affected a ON a.run_id = r.id
    CROSS JOIN LATERAL jsonb_array_elements(r.process_timeline) AS e(node)
  UNION ALL SELECT run_id, node, 1 FROM available
), unique_events AS (
  SELECT DISTINCT ON (run_id, (node->>'seq')::bigint) run_id, node
  FROM combined ORDER BY run_id, (node->>'seq')::bigint, priority DESC
), archives AS (
  SELECT run_id, jsonb_agg(node ORDER BY (node->>'seq')::bigint) AS events
  FROM unique_events GROUP BY run_id
)
UPDATE public.companion_turn_runs r SET process_timeline = a.events FROM archives a WHERE r.id = a.run_id;
