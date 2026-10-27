-- Chat originals expire independently of immutable message text. A note reference
-- promotes the same object atomically, including references in historical versions.
CREATE TABLE public.chat_upload_objects (
  object_key text PRIMARY KEY,
  -- Keep cleanup metadata after account/workspace deletion so bytes cannot become orphaned.
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  retained_at timestamptz,
  backup_requested_at timestamptz,
  purge_started_at timestamptz,
  purged_at timestamptz,
  CHECK (object_key LIKE workspace_id::text || '/companion/%'
    OR object_key LIKE workspace_id::text || '/companion-files/' || user_id::text || '/%')
);
CREATE INDEX chat_upload_objects_expiry_idx ON public.chat_upload_objects(expires_at)
  WHERE retained_at IS NULL AND purged_at IS NULL;
ALTER TABLE public.chat_upload_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_upload_objects FORCE ROW LEVEL SECURITY;
CREATE POLICY chat_upload_objects_actor ON public.chat_upload_objects FOR ALL
  USING (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT, INSERT ON public.chat_upload_objects TO astella_api;

INSERT INTO public.chat_upload_objects(object_key,workspace_id,user_id,created_at,expires_at)
SELECT object_key,workspace_id,created_by,created_at,created_at+interval '30 days'
FROM public.note_image_assets WHERE object_key LIKE workspace_id::text || '/companion/%'
ON CONFLICT DO NOTHING;

CREATE FUNCTION public.astella_retain_chat_upload(p_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item public.chat_upload_objects;
BEGIN
  SELECT * INTO item FROM public.chat_upload_objects WHERE object_key=p_key FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF item.purge_started_at IS NOT NULL OR item.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'This chat attachment has expired; upload it again before saving to a note';
  END IF;
  UPDATE public.chat_upload_objects SET retained_at=COALESCE(retained_at,now()) WHERE object_key=p_key;
END $$;
REVOKE ALL ON FUNCTION public.astella_retain_chat_upload(text) FROM PUBLIC;

CREATE FUNCTION public.astella_note_retains_chat_upload() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p_key text;
BEGIN
  IF NEW.image_asset_id IS NOT NULL THEN
    SELECT object_key INTO p_key FROM public.note_image_assets
      WHERE id=NEW.image_asset_id AND workspace_id=NEW.workspace_id;
  ELSIF NEW.type='image' THEN
    p_key := substring(NEW.content FROM '/api/uploads/([^[:space:])<>]+)');
  END IF;
  IF p_key LIKE NEW.workspace_id::text || '/companion/%' THEN
    PERFORM public.astella_retain_chat_upload(p_key);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.astella_note_retains_chat_upload() FROM PUBLIC;
CREATE TRIGGER note_blocks_retain_chat_upload BEFORE INSERT OR UPDATE OF image_asset_id,content
  ON public.note_blocks FOR EACH ROW EXECUTE FUNCTION public.astella_note_retains_chat_upload();

CREATE FUNCTION public.astella_source_retains_chat_upload() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p_key text := NEW.metadata->>'storageObjectKey';
BEGIN
  IF p_key LIKE NEW.workspace_id::text || '/companion-files/%' THEN
    PERFORM public.astella_retain_chat_upload(p_key);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.astella_source_retains_chat_upload() FROM PUBLIC;
CREATE TRIGGER sources_retain_chat_upload BEFORE INSERT OR UPDATE OF metadata
  ON public.sources FOR EACH ROW EXECUTE FUNCTION public.astella_source_retains_chat_upload();

UPDATE public.chat_upload_objects c SET retained_at=now()
WHERE EXISTS (SELECT 1 FROM public.note_image_assets a
  JOIN public.note_blocks b ON b.image_asset_id=a.id AND b.workspace_id=a.workspace_id
  WHERE a.object_key=c.object_key AND a.workspace_id=c.workspace_id)
OR EXISTS (SELECT 1 FROM public.note_blocks b WHERE b.workspace_id=c.workspace_id
  AND b.type='image' AND b.content LIKE '%/api/uploads/' || c.object_key || '%')
OR EXISTS (SELECT 1 FROM public.sources s WHERE s.workspace_id=c.workspace_id
  AND s.metadata->>'storageObjectKey'=c.object_key);

CREATE FUNCTION public.astella_chat_upload_retained(p_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS (SELECT 1 FROM public.chat_upload_objects WHERE object_key=p_key AND retained_at IS NOT NULL AND purged_at IS NULL);
$$;
REVOKE ALL ON FUNCTION public.astella_chat_upload_retained(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_chat_upload_retained(text) TO astella_api;

-- No bucket bytes are read during legacy registration. S3 LastModified supplies
-- creation time for old file uploads that predate the receipt/expiry ledger.
CREATE FUNCTION public.astella_register_legacy_chat_upload(p_key text,p_created timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p_workspace uuid; p_user uuid;
BEGIN
  IF p_key ~ '^[0-9a-f-]{36}/companion-files/[0-9a-f-]{36}/[^/]+$' THEN
    p_workspace:=split_part(p_key,'/',1)::uuid; p_user:=split_part(p_key,'/',3)::uuid;
  ELSE RETURN; END IF;
  INSERT INTO public.chat_upload_objects(object_key,workspace_id,user_id,created_at,expires_at)
    VALUES(p_key,p_workspace,p_user,p_created,p_created+interval '30 days') ON CONFLICT DO NOTHING;
  IF EXISTS(SELECT 1 FROM public.sources WHERE workspace_id=p_workspace AND metadata->>'storageObjectKey'=p_key) THEN
    PERFORM public.astella_retain_chat_upload(p_key);
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.astella_register_legacy_chat_upload(text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_register_legacy_chat_upload(text,timestamptz) TO astella_api;

-- Atomic claims fence note promotion against deletion, and retry after a crash.
CREATE FUNCTION public.astella_claim_expired_chat_uploads(p_limit integer DEFAULT 10)
RETURNS TABLE(object_key text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  UPDATE public.chat_upload_objects c SET purge_started_at=now()
  WHERE c.object_key IN (SELECT q.object_key FROM public.chat_upload_objects q
    WHERE q.retained_at IS NULL AND q.purged_at IS NULL AND q.expires_at<=now()
      AND (q.purge_started_at IS NULL OR q.purge_started_at<now()-interval '10 minutes')
    ORDER BY q.expires_at LIMIT LEAST(GREATEST(p_limit,1),50) FOR UPDATE SKIP LOCKED)
  RETURNING c.object_key;
$$;
REVOKE ALL ON FUNCTION public.astella_claim_expired_chat_uploads(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_claim_expired_chat_uploads(integer) TO astella_api;

CREATE FUNCTION public.astella_finish_chat_upload_purge(p_key text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  UPDATE public.chat_upload_objects SET purged_at=now()
  WHERE object_key=p_key AND retained_at IS NULL AND purge_started_at IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.astella_finish_chat_upload_purge(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_finish_chat_upload_purge(text) TO astella_api;

CREATE FUNCTION public.astella_pending_chat_upload_promotions(p_limit integer DEFAULT 50)
RETURNS TABLE(object_key text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT c.object_key FROM public.chat_upload_objects c WHERE retained_at IS NOT NULL
    AND backup_requested_at IS NULL AND purged_at IS NULL ORDER BY retained_at LIMIT LEAST(GREATEST(p_limit,1),100);
$$;
REVOKE ALL ON FUNCTION public.astella_pending_chat_upload_promotions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_pending_chat_upload_promotions(integer) TO astella_api;
CREATE FUNCTION public.astella_ack_chat_upload_promotion(p_key text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  UPDATE public.chat_upload_objects SET backup_requested_at=now() WHERE object_key=p_key AND retained_at IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.astella_ack_chat_upload_promotion(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_ack_chat_upload_promotion(text) TO astella_api;
