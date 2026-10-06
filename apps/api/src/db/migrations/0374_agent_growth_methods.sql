-- 42: experience methods reuse the existing Procedural domain.
ALTER TABLE public.companion_procedural_playbooks
  ADD COLUMN method_state text NOT NULL DEFAULT 'candidate' CHECK (method_state IN ('candidate','active','disabled','disputed')),
  ADD COLUMN user_controlled boolean NOT NULL DEFAULT false,
  ADD COLUMN capability_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(capability_refs) = 'array'),
  ADD COLUMN source_run_id uuid REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  ADD COLUMN source_run_revision integer,
  ADD COLUMN change_reason text CHECK (char_length(change_reason) <= 500),
  ADD CONSTRAINT companion_method_source_pair CHECK (
    (source_run_id IS NULL AND source_run_revision IS NULL)
    OR (source_run_id IS NOT NULL AND source_run_revision > 0)
  );
ALTER TABLE public.companion_procedural_playbooks DROP CONSTRAINT companion_procedural_playbooks_author_check;
ALTER TABLE public.companion_procedural_playbooks ADD CONSTRAINT companion_procedural_playbooks_author_check
  CHECK (author IN ('user','companion','extractor','maintenance'));
UPDATE public.companion_procedural_playbooks SET method_state='disputed' WHERE epistemic_status='disputed';
--> statement-breakpoint
CREATE TABLE public.companion_method_revisions (
  method_id uuid NOT NULL REFERENCES public.companion_procedural_playbooks(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (method_id,revision)
);
CREATE TABLE public.companion_method_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  method_id uuid NOT NULL REFERENCES public.companion_procedural_playbooks(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  method_revision integer NOT NULL CHECK (method_revision > 0),
  context_kind text NOT NULL CHECK (context_kind IN ('agent_goal','conversation')),
  context_id uuid NOT NULL,
  context_revision integer NOT NULL CHECK (context_revision > 0),
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 240),
  feedback text CHECK (feedback IN ('helpful','unhelpful')),
  comment text CHECK (char_length(comment) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  feedback_at timestamptz,
  UNIQUE (workspace_id,user_id,method_id,method_revision,source_key)
);
CREATE INDEX companion_method_uses_owner_idx ON public.companion_method_uses(workspace_id,user_id,method_id,created_at DESC);
--> statement-breakpoint
ALTER TABLE public.companion_method_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_method_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.companion_method_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_method_uses FORCE ROW LEVEL SECURITY;
CREATE POLICY companion_method_revisions_scope ON public.companion_method_revisions FOR ALL
  USING (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY companion_method_uses_scope ON public.companion_method_uses FOR ALL
  USING (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT ON public.companion_method_revisions TO astella_api,astella_worker;
GRANT SELECT,INSERT,UPDATE ON public.companion_method_uses TO astella_api;
GRANT SELECT,INSERT ON public.companion_method_uses TO astella_worker;
--> statement-breakpoint
CREATE FUNCTION public.astella_archive_companion_method_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW)-'updated_at' IS DISTINCT FROM to_jsonb(OLD)-'updated_at' THEN
    INSERT INTO public.companion_method_revisions(method_id,workspace_id,user_id,revision,snapshot)
      VALUES(OLD.id,OLD.workspace_id,OLD.user_id,OLD.version,to_jsonb(OLD));
    NEW.version := OLD.version+1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER companion_method_revision_archive BEFORE UPDATE ON public.companion_procedural_playbooks
  FOR EACH ROW EXECUTE FUNCTION public.astella_archive_companion_method_revision();
REVOKE ALL ON FUNCTION public.astella_archive_companion_method_revision() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.astella_propagate_playbook_evidence_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed boolean;
BEGIN
  IF TG_OP='DELETE' THEN changed := true;
  ELSE changed := NEW.deleted_at IS NOT NULL OR NEW.dismissed_at IS NOT NULL OR NEW.archived_at IS NOT NULL
     OR NEW.revision<>OLD.revision OR NEW.content<>OLD.content
     OR NEW.epistemic_status IN ('disputed','superseded');
  END IF;
  IF changed THEN
    UPDATE public.companion_procedural_playbooks
       SET epistemic_status='disputed',
           method_state=CASE WHEN method_state='disabled' THEN 'disabled' ELSE 'disputed' END,
           change_reason='依据已被纠正、停用或遗忘，需要重新核对。', updated_at=now()
     WHERE workspace_id=OLD.workspace_id AND user_id=OLD.user_id
       AND evidence @> jsonb_build_array(jsonb_build_object('memoryId',OLD.id::text))
       AND epistemic_status<>'disputed';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER assistant_memory_playbook_delete_guard AFTER DELETE ON public.assistant_memory_items
  FOR EACH ROW EXECUTE FUNCTION public.astella_propagate_playbook_evidence_change();
REVOKE ALL ON FUNCTION public.astella_propagate_playbook_evidence_change() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.astella_agent_method_sources_current(p_id uuid,p_workspace uuid,p_user uuid)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE method record; ref jsonb; material jsonb; input_refs jsonb; valid boolean;
BEGIN
  IF p_workspace IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'')::uuid
     OR p_user IS DISTINCT FROM NULLIF(current_setting('app.user_id',true),'')::uuid THEN RETURN false; END IF;
  SELECT * INTO method FROM public.companion_procedural_playbooks
    WHERE id=p_id AND workspace_id=p_workspace AND user_id=p_user;
  IF NOT FOUND OR jsonb_array_length(method.evidence)=0 THEN RETURN false; END IF;
  FOR ref IN SELECT value FROM pg_catalog.jsonb_array_elements(method.evidence) LOOP
    IF ref ? 'memoryId' THEN
      IF NOT (ref ? 'memoryRevision') THEN RETURN false; END IF;
      SELECT EXISTS(SELECT 1 FROM public.assistant_memory_items m
        WHERE m.id=(ref->>'memoryId')::uuid AND m.workspace_id=p_workspace AND m.user_id=p_user
          AND m.revision=(ref->>'memoryRevision')::integer
          AND m.deleted_at IS NULL AND m.dismissed_at IS NULL AND m.archived_at IS NULL
          AND m.epistemic_status NOT IN ('disputed','superseded')
          AND (m.valid_from IS NULL OR m.valid_from<=now())
          AND (m.valid_until IS NULL OR m.valid_until>now())) INTO valid;
      IF NOT valid THEN RETURN false; END IF;
    ELSIF ref ? 'runId' THEN
      input_refs := NULL;
      SELECT r.inputs INTO input_refs FROM public.agent_runs r
        WHERE r.id=(ref->>'runId')::uuid AND r.workspace_id=p_workspace AND r.user_id=p_user
          AND r.revision=(ref->>'runRevision')::integer AND r.status='completed';
      IF input_refs IS NULL THEN
        SELECT r.inputs INTO input_refs FROM public.agent_run_revisions r
          WHERE r.run_id=(ref->>'runId')::uuid AND r.workspace_id=p_workspace AND r.user_id=p_user
            AND r.revision=(ref->>'runRevision')::integer AND r.status='completed';
      END IF;
      IF input_refs IS NULL THEN RETURN false; END IF;
      FOR material IN SELECT value FROM pg_catalog.jsonb_array_elements(input_refs) LOOP
        SELECT EXISTS(SELECT 1 FROM public.note_versions v JOIN public.notes n ON n.id=v.note_id AND n.workspace_id=v.workspace_id
          WHERE v.id=(material->>'noteVersionId')::uuid AND n.id=(material->>'noteId')::uuid
            AND n.workspace_id=p_workspace AND n.deleted_at IS NULL
            AND (n.share_scope='shared' OR n.created_by=p_user)) INTO valid;
        IF NOT valid THEN RETURN false; END IF;
      END LOOP;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.astella_agent_method_sources_current(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_agent_method_sources_current(uuid,uuid,uuid) TO astella_api,astella_worker;
