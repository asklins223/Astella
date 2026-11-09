-- 0469: drop the procedure functions the retired learning chain left behind.
--
-- 0449/0452 dropped the learning-run, card-generation and note-round tables,
-- but fourteen functions kept naming them. Nothing calls them: no application
-- code, no live trigger, no policy, no view, and no other function. The ones
-- with a body would raise `relation ... does not exist` the moment anything
-- did; the rest are trigger functions whose tables no longer exist.
--
-- Ownership is checked rather than assumed: databases bootstrapped before the
-- migrator role existed may still have these owned by the superuser, and a
-- migration must not block a deploy over a dead function. Such a function is
-- left in place with a warning so the drift stays visible.
DO $$
DECLARE
  v_sig text;
  v_owner text;
  v_left text[] := ARRAY[]::text[];
BEGIN
  FOR v_sig, v_owner IN
    SELECT p.oid::regprocedure::text, pg_get_userbyid(p.proowner)
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.oid IN (
        to_regprocedure('public.astella_card_generation_outbox_notify()'),
        to_regprocedure('public.astella_claim_run_processing(text,integer,integer,timestamp with time zone)'),
        to_regprocedure('public.astella_mark_run_processing_processed(uuid,text,timestamp with time zone)'),
        to_regprocedure('public.astella_release_run_processing(uuid,text,text,timestamp with time zone)'),
        to_regprocedure('public.astella_note_rounds_idle_for_pause(integer)'),
        to_regprocedure('public.guard_note_learning_round_artifact_failure()'),
        to_regprocedure('public.prevent_immutable_v2_row_mutation()'),
        to_regprocedure('public.prevent_note_learning_round_artifact_mutation()'),
        to_regprocedure('public.prevent_note_learning_round_ownership_mutation()'),
        to_regprocedure('public.prevent_note_learning_round_plan_mutation()'),
        to_regprocedure('public.prevent_note_learning_round_target_mutation()'),
        to_regprocedure('public.prevent_note_learning_round_teaching_mutation()'),
        to_regprocedure('public.prevent_objective_revision_mutation()'),
        to_regprocedure('public.prevent_publication_revision_mutation()')
      )
  LOOP
    IF v_owner = current_user THEN
      EXECUTE format('DROP FUNCTION %s', v_sig);
    ELSE
      v_left := v_left || format('%s (owner %s)', v_sig, v_owner);
    END IF;
  END LOOP;

  IF cardinality(v_left) > 0 THEN
    RAISE WARNING
      'retired learning procedure functions left in place because they are not owned by %: %',
      current_user, array_to_string(v_left, ', ');
  END IF;
END
$$;
