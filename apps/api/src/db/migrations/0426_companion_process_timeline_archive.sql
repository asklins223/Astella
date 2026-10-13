-- 手记的思考与操作随对话保留，实时传输事件继续按原 TTL 清理。
ALTER TABLE public.companion_turn_runs
  ADD COLUMN process_timeline jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE FUNCTION public.companion_process_event_payload(event_type text, event_payload jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE event_type
    WHEN 'assistant.thinking' THEN jsonb_build_object('index', event_payload->'index', 'text', event_payload->'text')
    WHEN 'assistant.status' THEN jsonb_build_object('status', event_payload->'status', 'safeLabel', event_payload->'safeLabel')
    WHEN 'agent.tool' THEN jsonb_build_object('tool', jsonb_strip_nulls(jsonb_build_object(
      'toolCallId', event_payload#>'{tool,toolCallId}', 'name', event_payload#>'{tool,name}',
      'status', event_payload#>'{tool,status}', 'safeLabel', event_payload#>'{tool,safeLabel}',
      'safeSummary', event_payload#>'{tool,safeSummary}', 'proposalId', event_payload#>'{tool,proposalId}',
      'preparationToolCallId', event_payload#>'{tool,preparationToolCallId}')))
  END;
$$;

UPDATE public.companion_turn_runs AS run
SET process_timeline = archive.events
FROM (
  SELECT run_id, jsonb_agg(jsonb_build_object('version', 1, 'seq', seq, 'runId', run_id,
    'type', type, 'payload', public.companion_process_event_payload(type, payload)) ORDER BY seq) AS events
  FROM public.companion_stream_events
  WHERE run_id IS NOT NULL AND type IN ('assistant.thinking', 'assistant.status', 'agent.tool')
  GROUP BY run_id
) AS archive
WHERE run.id = archive.run_id;

CREATE FUNCTION public.companion_archive_process_event()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.run_id IS NOT NULL AND NEW.type IN ('assistant.thinking', 'assistant.status', 'agent.tool') THEN
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

CREATE TRIGGER companion_stream_events_archive_process
AFTER INSERT ON public.companion_stream_events
FOR EACH ROW EXECUTE FUNCTION public.companion_archive_process_event();
