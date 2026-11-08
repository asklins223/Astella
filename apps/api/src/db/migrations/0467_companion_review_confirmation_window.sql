-- A tool review with no expiry keeps its run in waiting_for_confirmation.
-- That status is active, so the conversation cannot start another turn.
-- Reviews use the same five-minute window as every other confirmation.
-- Rows already stored with a null expiry are reclaimed once they are older
-- than that window.

CREATE OR REPLACE FUNCTION public.astella_reclaim_stale_companion_proposals()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ids uuid[];
  v_total integer := 0;
  v_conv record;
  v_start_seq bigint;
BEGIN
  SELECT array_agg(p.id), count(*)::int
    INTO v_ids, v_total
  FROM public.companion_action_proposals p
  LEFT JOIN public.companion_turn_runs r ON r.id = p.agent_run_id
  LEFT JOIN public.user_companion_account_state s ON s.user_id = p.user_id
  WHERE p.status = 'pending'
    AND (
      p.expires_at < now()
      OR (p.expires_at IS NULL AND p.created_at < now() - interval '5 minutes')
      OR (
        p.origin = 'agent_tool'
        AND p.agent_run_id IS NOT NULL
        AND (
          COALESCE(s.global_enabled, true) = false
          OR COALESCE(s.epoch, 0) <> r.account_epoch
        )
      )
    );

  IF v_total = 0 OR v_ids IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.companion_action_proposals
  SET status = 'expired', updated_at = now()
  WHERE id = ANY(v_ids);

  UPDATE public.companion_agent_tool_calls
  SET status = 'expired', result_safe_summary = '确认已过期', updated_at = now()
  WHERE proposal_id = ANY(v_ids)
    AND status = 'waiting_confirmation';

  UPDATE public.companion_turn_runs
  SET status = 'failed', error_code = 'ACTION_EXPIRED',
      waiting_proposal_id = NULL, finished_at = now(), updated_at = now()
  WHERE waiting_proposal_id = ANY(v_ids)
    AND status = 'waiting_for_confirmation';

  FOR v_conv IN
    SELECT p.conversation_id AS cid, count(*)::int AS n
    FROM public.companion_action_proposals p
    WHERE p.id = ANY(v_ids)
    GROUP BY p.conversation_id
  LOOP
    UPDATE public.companion_conversations
    SET next_event_seq = next_event_seq + v_conv.n
    WHERE id = v_conv.cid
    RETURNING next_event_seq - v_conv.n INTO v_start_seq;

    INSERT INTO public.companion_stream_events
      (conversation_id, seq, workspace_id, user_id, run_id, generation,
       account_epoch, type, payload, expires_at)
    SELECT p.conversation_id,
           v_start_seq + (row_number() OVER (ORDER BY p.id)) - 1,
           p.workspace_id,
           p.user_id,
           NULL,
           0,
           COALESCE((
             SELECT MAX(s.epoch) FROM public.user_companion_account_state s
             WHERE s.user_id = p.user_id
           ), 0),
           'action.expired',
           jsonb_build_object('proposalId', p.id),
           now() + interval '24 hours'
    FROM public.companion_action_proposals p
    WHERE p.id = ANY(v_ids)
      AND p.conversation_id = v_conv.cid;

    PERFORM pg_notify(
      'astella_companion_events_v1',
      json_build_object(
        'conversationId', v_conv.cid,
        'maxSeq', v_start_seq + v_conv.n - 1
      )::text
    );
  END LOOP;

  RETURN v_total;
END;
$$;

ALTER FUNCTION public.astella_reclaim_stale_companion_proposals() OWNER TO astella_migrator;
REVOKE ALL ON FUNCTION public.astella_reclaim_stale_companion_proposals() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'astella_worker') THEN
    GRANT EXECUTE ON FUNCTION public.astella_reclaim_stale_companion_proposals() TO astella_worker;
  END IF;
END $$;
