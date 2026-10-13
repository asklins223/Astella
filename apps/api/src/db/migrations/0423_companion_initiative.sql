-- 56: user-authored prose, factual awareness, and revocable agent attention.
-- A clock wakes the same agent; it never publishes a generated line itself.
-- Reentrant DDL also supports a local hot-reload applying an earlier draft before it was frozen.
CREATE TABLE IF NOT EXISTS public.companion_participation_preferences (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  enabled boolean NOT NULL DEFAULT true,
  markdown text NOT NULL DEFAULT '' CHECK(length(markdown)<=16000),
  source jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.companion_participation_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_participation_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS companion_participation_preferences_scope ON public.companion_participation_preferences;
CREATE POLICY companion_participation_preferences_scope ON public.companion_participation_preferences FOR ALL
  USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.companion_participation_preferences TO astella_api,astella_worker;

CREATE TABLE IF NOT EXISTS public.companion_participation_preference_versions (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  revision integer NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,revision)
);
ALTER TABLE public.companion_participation_preference_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_participation_preference_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS companion_participation_preference_versions_scope ON public.companion_participation_preference_versions;
CREATE POLICY companion_participation_preference_versions_scope ON public.companion_participation_preference_versions FOR ALL
  USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
REVOKE ALL ON public.companion_participation_preference_versions FROM astella_api,astella_worker;
GRANT SELECT ON public.companion_participation_preference_versions TO astella_api,astella_worker;
CREATE OR REPLACE FUNCTION public.astella_record_participation_preferences() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
  INSERT INTO public.companion_participation_preference_versions(user_id,revision,snapshot)
    VALUES(NEW.user_id,NEW.revision,to_jsonb(NEW));
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.astella_record_participation_preferences() FROM PUBLIC;
DROP TRIGGER IF EXISTS companion_participation_history ON public.companion_participation_preferences;
CREATE TRIGGER companion_participation_history AFTER INSERT OR UPDATE ON public.companion_participation_preferences
  FOR EACH ROW EXECUTE FUNCTION public.astella_record_participation_preferences();

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.companion_awareness_sessions (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  device_session_id text NOT NULL, app_launch_id uuid NOT NULL,
  host text NOT NULL CHECK(host IN ('desktop','browser')), context jsonb NOT NULL,
  typing_until timestamptz, observed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,user_id,device_session_id)
);
ALTER TABLE public.companion_awareness_sessions ADD COLUMN IF NOT EXISTS observed_at timestamptz;
CREATE TABLE IF NOT EXISTS public.companion_awareness_observations (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL, topic text NOT NULL, device_session_id text,
  facts jsonb NOT NULL, conversation_id uuid REFERENCES public.companion_conversations(id) ON DELETE CASCADE,
  parent_run_id uuid REFERENCES public.companion_turn_runs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  UNIQUE(user_id,dedupe_key)
);
CREATE INDEX IF NOT EXISTS companion_awareness_scope_time ON public.companion_awareness_observations(workspace_id,user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS public.companion_study_spans (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  device_session_id text NOT NULL, started_at timestamptz NOT NULL, ended_at timestamptz NOT NULL,
  CHECK(ended_at>=started_at AND ended_at-started_at<=interval '45 seconds')
);
CREATE INDEX IF NOT EXISTS companion_study_spans_user_time ON public.companion_study_spans(user_id,ended_at DESC);
CREATE TABLE IF NOT EXISTS public.companion_attention_plans (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  entry_key text NOT NULL CHECK(length(entry_key) BETWEEN 1 AND 120),
  revision integer NOT NULL DEFAULT 1, intent text NOT NULL CHECK(length(intent) BETWEEN 1 AND 4000),
  topics text[] NOT NULL DEFAULT '{}', next_review_at timestamptz, expires_at timestamptz,
  preference_revision integer, self_note jsonb,
  state text NOT NULL CHECK(state IN ('active','completed')),
  conversation_id uuid REFERENCES public.companion_conversations(id) ON DELETE CASCADE,
  parent_run_id uuid REFERENCES public.companion_turn_runs(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,user_id,entry_key)
);
CREATE INDEX IF NOT EXISTS companion_attention_due ON public.companion_attention_plans(next_review_at)
  WHERE state='active' AND next_review_at IS NOT NULL;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['companion_awareness_sessions','companion_awareness_observations','companion_study_spans','companion_attention_plans'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',t||'_scope',t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''')::uuid AND user_id=NULLIF(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''')::uuid AND user_id=NULLIF(current_setting(''app.user_id'',true),'''')::uuid)',t||'_scope',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO astella_api,astella_worker',t);
  END LOOP;
END $$;

--> statement-breakpoint

ALTER TABLE public.companion_turn_runs ALTER COLUMN user_message_id DROP NOT NULL;
ALTER TABLE public.companion_turn_runs ADD COLUMN IF NOT EXISTS input_source jsonb;
ALTER TABLE public.companion_turn_runs DROP CONSTRAINT IF EXISTS companion_turn_input_identity;
ALTER TABLE public.companion_turn_runs ADD CONSTRAINT companion_turn_input_identity CHECK (
  (user_message_id IS NOT NULL AND input_source IS NULL) OR
  (user_message_id IS NULL AND coalesce(input_source->>'kind'='initiative',false))
);
CREATE TABLE IF NOT EXISTS public.companion_run_utterances (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.companion_turn_runs(id) ON DELETE CASCADE,
  tool_call_id text NOT NULL, message_id uuid NOT NULL REFERENCES public.companion_messages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,tool_call_id), UNIQUE(message_id)
);
ALTER TABLE public.companion_run_utterances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_run_utterances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS companion_run_utterances_scope ON public.companion_run_utterances;
CREATE POLICY companion_run_utterances_scope ON public.companion_run_utterances FOR ALL
  USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
REVOKE ALL ON public.companion_run_utterances FROM astella_api,astella_worker;
GRANT SELECT,INSERT,DELETE ON public.companion_run_utterances TO astella_api,astella_worker;
ALTER TABLE public.companion_stream_events DROP CONSTRAINT IF EXISTS companion_stream_events_type_check;
ALTER TABLE public.companion_stream_events ADD CONSTRAINT companion_stream_events_type_check CHECK(type IN (
  'turn.accepted','assistant.status','assistant.thinking','assistant.delta','assistant.final',
  'assistant.utterance','turn.completed','assistant.followups.ready','agent.skill','agent.tool','character.cue',
  'action.proposed','action.decision','action.expired','action.started','action.completed','action.failed',
  'voice.segment.ready','proactive.delivery','proactive.delivery.updated','turn.cancelled','error'
));

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.astella_enqueue_companion_attention() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p record; added integer; total integer:=0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('companion-attention-enqueue')) THEN RETURN 0; END IF;
  FOR p IN SELECT n.* FROM public.companion_attention_plans n
    JOIN public.workspace_members m ON m.workspace_id=n.workspace_id AND m.user_id=n.user_id AND m.left_at IS NULL
    JOIN public.user_companion_account_state a ON a.user_id=n.user_id AND a.global_enabled
    LEFT JOIN public.companion_participation_preferences pref ON pref.user_id=n.user_id
    WHERE n.state='active' AND n.next_review_at<=now() AND (n.expires_at IS NULL OR n.expires_at>now())
      AND (n.preference_revision IS NULL OR (pref.enabled AND pref.revision=n.preference_revision))
    ORDER BY n.next_review_at LIMIT 50 FOR UPDATE OF n SKIP LOCKED
  LOOP
    INSERT INTO public.jobs(type,workspace_id,requested_by,payload,status,priority,resource_class,idempotency_key)
      VALUES('companion_initiative',p.workspace_id,p.user_id,
        jsonb_build_object('attentionKey',p.entry_key,'attentionRevision',p.revision),
        'pending',25,'maintenance','companion-attention:'||p.user_id||':'||md5(p.entry_key)||':'||p.revision||':'||extract(epoch FROM p.next_review_at))
      ON CONFLICT(workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
    GET DIAGNOSTICS added=ROW_COUNT; total:=total+added;
    UPDATE public.companion_attention_plans SET next_review_at=NULL
      WHERE workspace_id=p.workspace_id AND user_id=p.user_id AND entry_key=p.entry_key AND revision=p.revision;
  END LOOP;
  -- These are transient observations, never long-term user memories.
  DELETE FROM public.companion_awareness_observations WHERE topic<>'app.started' AND expires_at<now()-interval '1 day';
  -- Keep only the launch receipt so a long-running app's reload never greets a second time.
  UPDATE public.companion_awareness_observations SET facts='{}'::jsonb,device_session_id=NULL,conversation_id=NULL
    WHERE topic='app.started' AND expires_at<now() AND facts<>'{}'::jsonb;
  DELETE FROM public.companion_study_spans WHERE ended_at<now()-interval '1 day';
  DELETE FROM public.companion_awareness_sessions WHERE updated_at<now()-interval '1 day';
  RETURN total;
END $$;
REVOKE ALL ON FUNCTION public.astella_enqueue_companion_attention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_enqueue_companion_attention() TO astella_worker;

--> statement-breakpoint

-- Own-account duration projection across workspaces, with no page or material content.
CREATE OR REPLACE FUNCTION public.astella_companion_study_spans(p_user uuid)
RETURNS TABLE(started_at timestamptz,ended_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT s.started_at,s.ended_at FROM public.companion_study_spans s
  WHERE p_user=NULLIF(current_setting('app.user_id',true),'')::uuid AND s.user_id=p_user
    AND s.ended_at>now()-interval '4 hours'
$$;
REVOKE ALL ON FUNCTION public.astella_companion_study_spans(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_companion_study_spans(uuid) TO astella_api,astella_worker;

--> statement-breakpoint

-- Own-note wakes now advance with real tools in the same agent. They do not fabricate a user turn.
CREATE OR REPLACE FUNCTION public.astella_enqueue_companion_self_wakes() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n record; added integer; total integer:=0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('companion-self-wake-enqueue')) THEN RETURN 0; END IF;
  FOR n IN SELECT s.* FROM public.companion_self_notes s
    JOIN public.workspace_members m ON m.workspace_id=s.workspace_id AND m.user_id=s.user_id AND m.left_at IS NULL
    JOIN public.user_companion_account_state a ON a.user_id=s.user_id AND a.global_enabled
    WHERE NOT s.user_disabled AND s.next_review_at<=now() AND s.tier<>'archived'
      AND (s.expires_at IS NULL OR s.expires_at>now())
    ORDER BY s.next_review_at LIMIT 50 FOR UPDATE OF s SKIP LOCKED
  LOOP
    INSERT INTO public.jobs(type,workspace_id,requested_by,payload,status,priority,resource_class,idempotency_key)
      VALUES('companion_initiative',n.workspace_id,n.user_id,
        jsonb_build_object('selfNoteKey',n.entry_key,'selfNoteRevision',n.revision),
        'pending',25,'maintenance','companion-self-wake-v2:'||n.user_id||':'||md5(n.entry_key)||':'||n.revision||':'||extract(epoch FROM n.next_review_at))
      ON CONFLICT(workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
    GET DIAGNOSTICS added=ROW_COUNT; total:=total+added;
    UPDATE public.companion_self_notes SET next_review_at=NULL
      WHERE workspace_id=n.workspace_id AND user_id=n.user_id AND entry_key=n.entry_key AND revision=n.revision;
  END LOOP;
  RETURN total;
END $$;

--> statement-breakpoint

DROP POLICY IF EXISTS worker_type_allowlist_insert_guard ON public.jobs;
CREATE POLICY worker_type_allowlist_insert_guard ON public.jobs AS PERMISSIVE FOR INSERT TO public
  WITH CHECK(CURRENT_USER='astella_worker'::name AND type IN (
    'companion_agent','companion_initiative','companion_followup_suggestions',
    'companion_memory_extract','companion_summarizer','companion_daily_summary',
    'companion_memory_organize','companion_reflection'
  ));

--> statement-breakpoint

GRANT INSERT ON public.companion_turn_runs, public.companion_conversations TO astella_worker;
DROP POLICY IF EXISTS worker_initiative_run_origin ON public.companion_turn_runs;
CREATE POLICY worker_initiative_run_origin ON public.companion_turn_runs AS RESTRICTIVE FOR INSERT TO astella_worker
  WITH CHECK(user_message_id IS NULL AND input_source->>'kind'='initiative'
    AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid
    AND EXISTS(SELECT 1 FROM public.jobs j WHERE j.id=(input_source->>'preparationJobId')::uuid
      AND j.type='companion_initiative' AND j.status='running' AND j.workspace_id=companion_turn_runs.workspace_id
      AND j.requested_by=companion_turn_runs.user_id));
DROP POLICY IF EXISTS worker_initiative_conversation_origin ON public.companion_conversations;
CREATE POLICY worker_initiative_conversation_origin ON public.companion_conversations AS RESTRICTIVE FOR INSERT TO astella_worker
  WITH CHECK(kind='dialogue' AND title_source='placeholder' AND status='active'
    AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
