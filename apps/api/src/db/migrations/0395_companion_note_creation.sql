-- One scoped initial writer for API creation and explicit companion creation.
-- The worker remains unable to insert/update/delete notes directly.
CREATE OR REPLACE FUNCTION public.astella_note_creation_scope_current(p_workspace_id uuid,p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
BEGIN
  IF p_workspace_id IS DISTINCT FROM nullif(current_setting('app.workspace_id',true),'')::uuid
    OR p_user_id IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN RETURN false; END IF;
  -- This is also the lock used by the writer: role changes cannot slip between
  -- the permission check and initial persistence. No table data is returned.
  PERFORM w.id FROM public.workspaces w JOIN public.workspace_members m ON m.workspace_id=w.id
    WHERE w.id=p_workspace_id AND m.user_id=p_user_id AND m.left_at IS NULL
      AND (m.role='owner' OR w.owner_id=p_user_id) FOR SHARE OF w,m;
  RETURN FOUND;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.astella_note_creation_scope_current(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.astella_create_private_note_v1(
  p_workspace_id uuid, p_user_id uuid, p_note_id uuid, p_version_id uuid,
  p_title text, p_title_source text, p_blocks jsonb, p_companion_run_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  snapshot jsonb;
  blocks jsonb := p_blocks->'blocks';
  link_refs jsonb := p_blocks->'linkRefs';
  link_ref jsonb;
  linked_note_id uuid;
BEGIN
  IF NOT public.astella_note_creation_scope_current(p_workspace_id,p_user_id)
  THEN RAISE EXCEPTION 'note creation scope unavailable' USING ERRCODE='42501'; END IF;
  IF p_title IS NULL OR length(btrim(p_title))=0 OR length(p_title)>200
    OR p_title_source NOT IN ('manual','auto') OR jsonb_typeof(blocks) IS DISTINCT FROM 'array'
    OR jsonb_typeof(link_refs) IS DISTINCT FROM 'array' OR jsonb_array_length(link_refs)>6
    OR octet_length(p_blocks::text)>2097152
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(blocks) b
      WHERE b->>'type' IS NULL OR b->>'type' NOT IN ('paragraph','heading','code','list','quote','image')
        OR jsonb_typeof(b->'content') IS DISTINCT FROM 'string')
  THEN RAISE EXCEPTION 'invalid initial note content' USING ERRCODE='22023'; END IF;
  IF session_user='astella_worker' THEN
    IF p_companion_run_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM public.companion_turn_runs r
      JOIN public.user_companion_account_state a ON a.user_id=r.user_id
      JOIN public.jobs j ON j.id=r.job_id
      WHERE r.id=p_companion_run_id AND r.workspace_id=p_workspace_id AND r.user_id=p_user_id
        AND r.status IN ('accepted','running') AND r.cancel_requested_at IS NULL
        AND a.global_enabled AND a.epoch=r.account_epoch AND r.permission_level<>'read_only'
        AND j.type='companion_agent' AND j.status='running' AND j.requested_by=p_user_id
        AND j.workspace_id=p_workspace_id AND j.payload->>'runId'=r.id::text
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.permission_snapshot->'offeredTools') t
          WHERE t->>'name'='companion_create_note')
        AND EXISTS(SELECT 1 FROM public.companion_agent_tool_calls c WHERE c.run_id=r.id
          AND c.workspace_id=p_workspace_id AND c.user_id=p_user_id
          AND c.name='companion_create_note' AND c.status='executing')
    ) THEN RAISE EXCEPTION 'companion note creation request unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  IF session_user='astella_worker' THEN
    -- Lock the owning request/account and every selected material in the
    -- narrow definer; the worker has no UPDATE privilege to obtain these locks.
    PERFORM r.id FROM public.companion_turn_runs r JOIN public.user_companion_account_state a ON a.user_id=r.user_id
      WHERE r.id=p_companion_run_id AND r.workspace_id=p_workspace_id AND r.user_id=p_user_id
        AND r.status IN ('accepted','running') AND r.cancel_requested_at IS NULL
        AND a.global_enabled AND a.epoch=r.account_epoch AND r.permission_level<>'read_only'
      FOR UPDATE OF r,a;
    IF NOT FOUND THEN RAISE EXCEPTION 'companion note creation request unavailable' USING ERRCODE='42501'; END IF;
    FOR link_ref IN SELECT value FROM jsonb_array_elements(link_refs) LOOP
      linked_note_id := NULL;
      SELECT n.id INTO linked_note_id FROM public.notes n
        WHERE n.id=(link_ref->>'noteId')::uuid AND n.workspace_id=p_workspace_id AND n.deleted_at IS NULL
          AND (n.share_scope='shared' OR n.created_by=p_user_id)
          AND n.current_version_id=(link_ref->>'noteVersionId')::uuid
          AND EXISTS(SELECT 1 FROM public.companion_agent_tool_calls c WHERE c.run_id=p_companion_run_id
            AND c.workspace_id=p_workspace_id AND c.user_id=p_user_id AND c.name='companion_read_note'
            AND c.status='succeeded' AND c.result_ref='{"kind":"note_read","noteId":"' || n.id::text
              || '","noteVersionId":"' || n.current_version_id::text || '"}') FOR SHARE OF n;
      IF linked_note_id IS NULL THEN
        RAISE EXCEPTION 'verified note link unavailable' USING ERRCODE='42501';
      END IF;
    END LOOP;
  END IF;
  SELECT jsonb_build_object('blocks',coalesce(jsonb_agg(jsonb_build_object('type',b->>'type','content',b->>'content')
    ORDER BY ordinal),'[]'::jsonb)) INTO snapshot FROM jsonb_array_elements(blocks) WITH ORDINALITY t(b,ordinal);
  INSERT INTO public.notes(id,workspace_id,title,title_source,created_by,share_scope)
    VALUES(p_note_id,p_workspace_id,p_title,p_title_source,p_user_id,'private');
  INSERT INTO public.note_versions(id,note_id,workspace_id,version_no,content_json,content_hash,created_by)
    VALUES(p_version_id,p_note_id,p_workspace_id,1,snapshot,md5(snapshot::text),p_user_id);
  INSERT INTO public.note_blocks(workspace_id,version_id,ordinal,type,content,source_ref,image_asset_id)
    SELECT p_workspace_id,p_version_id,ordinal,b->>'type',b->>'content',b->'sourceRef',nullif(b->>'imageAssetId','')::uuid
    FROM jsonb_array_elements(blocks) WITH ORDINALITY t(b,ordinal);
  UPDATE public.notes SET current_version_id=p_version_id,updated_at=now()
    WHERE id=p_note_id AND workspace_id=p_workspace_id;
  BEGIN
    INSERT INTO public.search_documents(workspace_id,object_type,object_id,title,body,metadata,indexed_at)
      SELECT p_workspace_id,'note',p_note_id,p_title,coalesce(string_agg(b->>'content',E'\n' ORDER BY ordinal),''),'{}',now()
      FROM jsonb_array_elements(blocks) WITH ORDINALITY t(b,ordinal) WHERE b->>'type'<>'image';
  EXCEPTION WHEN OTHERS THEN
    -- Search remains a recoverable projection, as in the existing note service.
    RAISE WARNING 'initial note search projection unavailable';
  END;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.astella_create_private_note_v1(uuid,uuid,uuid,uuid,text,text,jsonb,uuid) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='astella_api') THEN
    GRANT EXECUTE ON FUNCTION public.astella_note_creation_scope_current(uuid,uuid) TO astella_api;
    GRANT EXECUTE ON FUNCTION public.astella_create_private_note_v1(uuid,uuid,uuid,uuid,text,text,jsonb,uuid) TO astella_api;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='astella_worker') THEN
    GRANT EXECUTE ON FUNCTION public.astella_note_creation_scope_current(uuid,uuid) TO astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_create_private_note_v1(uuid,uuid,uuid,uuid,text,text,jsonb,uuid) TO astella_worker;
  END IF;
END $$;
