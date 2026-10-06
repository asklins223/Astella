-- 0085: repair worker grants for learning-session tables.
--
-- 0074/0075/0081 conditionally granted these tables when the restricted
-- roles existed. Existing development volumes can have applied those
-- migrations before role-bootstrap created astella_worker, leaving the table
-- RLS policies correct but the Worker unable to claim/read/write anything.
-- Keep this migration idempotent and limited to the assessment worker set.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'astella_worker') THEN
    GRANT SELECT ON public.learning_sessions TO astella_worker;
    GRANT SELECT, UPDATE ON public.learning_episodes TO astella_worker;
    GRANT SELECT ON public.learning_session_probes TO astella_worker;
    GRANT SELECT ON public.learning_response_artifacts TO astella_worker;
    GRANT SELECT, INSERT ON public.learning_assessment_reports TO astella_worker;
    GRANT SELECT, UPDATE ON public.learning_session_processing_outbox TO astella_worker;
  END IF;
END $$;
