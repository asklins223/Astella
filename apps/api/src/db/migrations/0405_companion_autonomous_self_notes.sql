-- Autonomous strategies retain their epistemic status. Adoption is not proof.
ALTER TABLE public.companion_procedural_playbooks ALTER COLUMN method_state SET DEFAULT 'active';
UPDATE public.companion_procedural_playbooks SET method_state='active',version=version+1,
  change_reason='自主整理的做法，适用时采用；认识状态保持原样。',updated_at=now()
WHERE method_state='candidate' AND NOT user_controlled AND epistemic_status <> 'disputed';

--> statement-breakpoint

CREATE TABLE public.companion_self_notes (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  entry_key text NOT NULL CHECK(length(entry_key) BETWEEN 1 AND 120),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  user_disabled boolean NOT NULL DEFAULT false,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 32768),
  tier text NOT NULL CHECK(tier IN ('resident','active','archived')),
  next_review_at timestamptz, expires_at timestamptz,
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 300),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,user_id,entry_key)
);
CREATE INDEX companion_self_notes_wakes ON public.companion_self_notes(next_review_at)
  WHERE next_review_at IS NOT NULL AND tier <> 'archived';
ALTER TABLE public.companion_self_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_self_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY companion_self_notes_scope ON public.companion_self_notes FOR ALL
  USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.companion_self_notes TO astella_api,astella_worker;

--> statement-breakpoint

CREATE TABLE public.companion_self_note_versions (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  entry_key text NOT NULL,revision integer NOT NULL,snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,user_id,entry_key,revision)
);
ALTER TABLE public.companion_self_note_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_self_note_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY companion_self_note_versions_scope ON public.companion_self_note_versions FOR ALL
  USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT ON public.companion_self_note_versions TO astella_api,astella_worker;
CREATE FUNCTION public.astella_record_companion_self_note_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' OR NEW.revision IS DISTINCT FROM OLD.revision THEN
    INSERT INTO public.companion_self_note_versions(workspace_id,user_id,entry_key,revision,snapshot)
      VALUES(NEW.workspace_id,NEW.user_id,NEW.entry_key,NEW.revision,to_jsonb(NEW));
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.astella_record_companion_self_note_version() FROM PUBLIC;
CREATE TRIGGER companion_self_note_history AFTER INSERT OR UPDATE ON public.companion_self_notes
  FOR EACH ROW EXECUTE FUNCTION public.astella_record_companion_self_note_version();

--> statement-breakpoint

-- Timers cause internal reconsideration only. They never block live messages or
-- emit a delivery. Job ownership, account serial claims and AI governance stay
-- with the existing queue/kernel. A note version gets at most one wake job.
CREATE FUNCTION public.astella_enqueue_companion_self_wakes() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n record; convo record; added integer; total integer:=0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('companion-self-wake-enqueue')) THEN RETURN 0; END IF;
  FOR n IN SELECT s.* FROM public.companion_self_notes s
    JOIN public.workspace_members m ON m.workspace_id=s.workspace_id AND m.user_id=s.user_id AND m.left_at IS NULL
    JOIN public.user_companion_account_state a ON a.user_id=s.user_id AND a.global_enabled
    WHERE NOT s.user_disabled AND s.next_review_at<=now() AND s.tier <> 'archived'
      AND (s.expires_at IS NULL OR s.expires_at>now())
    ORDER BY s.next_review_at,s.user_id LIMIT 50
    FOR UPDATE OF s SKIP LOCKED
  LOOP
    IF (SELECT count(*) FROM public.jobs j WHERE j.requested_by=n.user_id
      AND j.type='companion_reflection' AND j.status IN ('pending','running')) >= 3 THEN CONTINUE; END IF;
    SELECT c.id,max(p.seq)::integer AS to_seq INTO convo FROM public.companion_conversations c
      JOIN public.companion_messages p ON p.conversation_id=c.id
      WHERE c.workspace_id=n.workspace_id AND c.user_id=n.user_id AND c.status='active'
      GROUP BY c.id ORDER BY max(p.created_at) DESC LIMIT 1;
    IF convo.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.companion_messages p
      WHERE p.conversation_id=convo.id AND p.seq=convo.to_seq AND p.role='assistant') THEN CONTINUE; END IF;
    INSERT INTO public.jobs(type,workspace_id,requested_by,payload,status,priority,resource_class,idempotency_key)
      VALUES('companion_reflection',n.workspace_id,n.user_id,
        jsonb_build_object('userId',n.user_id,'workspaceId',n.workspace_id,'conversationId',convo.id,
          'fromSeq',greatest(0,convo.to_seq-24),'toSeq',convo.to_seq,
          'selfNoteKey',n.entry_key,'selfNoteRevision',n.revision),
        'pending',30,'maintenance','companion-self-wake:'||n.user_id||':'||md5(n.entry_key)||':'||n.revision)
      ON CONFLICT(workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
    GET DIAGNOSTICS added=ROW_COUNT;
    total:=total+added;
    -- Consumed independently of revision; no-change does not schedule itself again.
    UPDATE public.companion_self_notes SET next_review_at=NULL
      WHERE workspace_id=n.workspace_id AND user_id=n.user_id AND entry_key=n.entry_key AND revision=n.revision;
  END LOOP;
  RETURN total;
END $$;
REVOKE ALL ON FUNCTION public.astella_enqueue_companion_self_wakes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_enqueue_companion_self_wakes() TO astella_worker;
