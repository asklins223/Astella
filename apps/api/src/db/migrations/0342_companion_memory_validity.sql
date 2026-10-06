-- 0342: persist memory provenance, applicability, and validity for safe retrieval.

ALTER TABLE public.assistant_memory_items
  ADD COLUMN source_speaker text,
  ADD COLUMN source_basis text,
  ADD COLUMN applies_when text,
  ADD COLUMN valid_from timestamptz,
  ADD COLUMN valid_until timestamptz,
  ADD CONSTRAINT assistant_memory_items_source_speaker_check
    CHECK (source_speaker IS NULL OR source_speaker IN ('user', 'assistant')),
  ADD CONSTRAINT assistant_memory_items_source_basis_check
    CHECK (source_basis IS NULL OR source_basis IN ('direct_statement', 'inferred_from_statement')),
  ADD CONSTRAINT assistant_memory_items_applies_when_length_check
    CHECK (applies_when IS NULL OR char_length(applies_when) <= 200),
  ADD CONSTRAINT assistant_memory_items_valid_window_check
    CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until > valid_from);

--> statement-breakpoint

CREATE INDEX assistant_memory_items_valid_until_idx
  ON public.assistant_memory_items (workspace_id, user_id, valid_until)
  WHERE valid_until IS NOT NULL AND deleted_at IS NULL;

--> statement-breakpoint

ALTER TABLE public.assistant_memory_item_revisions
  ADD COLUMN source_speaker text,
  ADD COLUMN source_basis text,
  ADD COLUMN applies_when text,
  ADD COLUMN valid_from timestamptz,
  ADD COLUMN valid_until timestamptz,
  ADD CONSTRAINT assistant_memory_revisions_source_speaker_check
    CHECK (source_speaker IS NULL OR source_speaker IN ('user', 'assistant')),
  ADD CONSTRAINT assistant_memory_revisions_source_basis_check
    CHECK (source_basis IS NULL OR source_basis IN ('direct_statement', 'inferred_from_statement')),
  ADD CONSTRAINT assistant_memory_revisions_applies_when_length_check
    CHECK (applies_when IS NULL OR char_length(applies_when) <= 200),
  ADD CONSTRAINT assistant_memory_revisions_valid_window_check
    CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until > valid_from);

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.capture_assistant_memory_item_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF ROW(
    NEW.kind,
    NEW.content,
    NEW.source_event_id,
    NEW.source_session_id,
    NEW.source_speaker,
    NEW.source_basis,
    NEW.applies_when,
    NEW.valid_from,
    NEW.valid_until,
    NEW.user_stated,
    NEW.user_confirmed,
    NEW.importance,
    NEW.confidence,
    NEW.scope,
    NEW.source_type,
    NEW.author_type,
    NEW.author_id,
    NEW.epistemic_status
  ) IS DISTINCT FROM ROW(
    OLD.kind,
    OLD.content,
    OLD.source_event_id,
    OLD.source_session_id,
    OLD.source_speaker,
    OLD.source_basis,
    OLD.applies_when,
    OLD.valid_from,
    OLD.valid_until,
    OLD.user_stated,
    OLD.user_confirmed,
    OLD.importance,
    OLD.confidence,
    OLD.scope,
    OLD.source_type,
    OLD.author_type,
    OLD.author_id,
    OLD.epistemic_status
  ) THEN
    INSERT INTO public.assistant_memory_item_revisions (
      memory_id,
      workspace_id,
      user_id,
      revision,
      kind,
      content,
      source_event_id,
      source_session_id,
      source_speaker,
      source_basis,
      applies_when,
      valid_from,
      valid_until,
      user_stated,
      user_confirmed,
      importance,
      confidence,
      scope,
      source_type,
      author_type,
      author_id,
      epistemic_status
    ) VALUES (
      OLD.id,
      OLD.workspace_id,
      OLD.user_id,
      OLD.revision,
      OLD.kind,
      OLD.content,
      OLD.source_event_id,
      OLD.source_session_id,
      OLD.source_speaker,
      OLD.source_basis,
      OLD.applies_when,
      OLD.valid_from,
      OLD.valid_until,
      OLD.user_stated,
      OLD.user_confirmed,
      OLD.importance,
      OLD.confidence,
      OLD.scope,
      OLD.source_type,
      OLD.author_type,
      OLD.author_id,
      OLD.epistemic_status
    );
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
  END;
$$;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.astella_sync_global_companion_memory_copies()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_syncing text;
  v_key uuid;
BEGIN
  v_syncing := NULLIF(current_setting('app.memory_sync', true), '');
  IF v_syncing = 'on' THEN
    RETURN NULL;
  END IF;

  v_key := COALESCE(NEW.global_key, OLD.global_key);
  IF v_key IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM set_config('app.memory_sync', 'on', true);

  UPDATE public.assistant_memory_items
     SET content = NEW.content,
         deleted_at = NEW.deleted_at,
         archived_at = NEW.archived_at,
         pinned = NEW.pinned,
         dismissed_at = NEW.dismissed_at,
         importance = NEW.importance,
         confidence = NEW.confidence,
         source_speaker = NEW.source_speaker,
         source_basis = NEW.source_basis,
         applies_when = NEW.applies_when,
         valid_from = NEW.valid_from,
         valid_until = NEW.valid_until,
         candidate = NEW.candidate,
         updated_at = now()
   WHERE user_id = NEW.user_id
     AND global_key = v_key
     AND id <> NEW.id;

  PERFORM set_config('app.memory_sync', '', true);
  RETURN NULL;
END;
$function$;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.astella_fanout_global_companion_memory(
  p_source_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  src record;
  target record;
  v_inserted integer := 0;
  v_key uuid;
BEGIN
  SELECT id, workspace_id, user_id, kind, content, scope, importance, confidence,
         user_stated, user_confirmed, source_event_id, source_session_id, source_type,
         source_speaker, source_basis, applies_when, valid_from, valid_until,
         pinned, global_key
    INTO src
    FROM public.assistant_memory_items
   WHERE id = p_source_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  IF src.scope <> 'global' THEN
    RETURN 0;
  END IF;

  v_key := COALESCE(src.global_key, src.id);
  IF src.global_key IS DISTINCT FROM v_key THEN
    UPDATE public.assistant_memory_items SET global_key = v_key WHERE id = src.id;
  END IF;

  FOR target IN
    SELECT m.workspace_id
      FROM public.workspace_members m
     WHERE m.user_id = src.user_id
       AND m.left_at IS NULL
       AND m.workspace_id <> src.workspace_id
  LOOP
    INSERT INTO public.assistant_memory_items
      (workspace_id, user_id, kind, content, source_event_id, source_session_id,
       source_speaker, source_basis, applies_when, valid_from, valid_until,
       user_stated, user_confirmed, candidate, importance, confidence, scope,
       source_type, embedding_status, global_key, pinned, created_at, updated_at)
    VALUES
      (target.workspace_id, src.user_id, src.kind, src.content, src.source_event_id,
       src.source_session_id, src.source_speaker, src.source_basis, src.applies_when,
       src.valid_from, src.valid_until, src.user_stated, src.user_confirmed, false,
       src.importance, src.confidence, 'global', src.source_type, 'pending',
       v_key, src.pinned, now(), now())
    ON CONFLICT (workspace_id, global_key) WHERE global_key IS NOT NULL AND deleted_at IS NULL
      DO NOTHING;
    IF FOUND THEN
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  RETURN v_inserted;
END;
$function$;

--> statement-breakpoint

COMMENT ON COLUMN public.assistant_memory_items.applies_when IS
  'Memory applicability condition, captured from the cited source; never grants extra authority.';
COMMENT ON COLUMN public.assistant_memory_items.valid_until IS
  'Exclusive validity end. Retrieval paths must exclude rows at or after this timestamp.';

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'assistant_memory_items'
       AND column_name = 'valid_until'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'assistant_memory_item_revisions'
       AND column_name = 'applies_when'
  ) THEN
    RAISE EXCEPTION 'companion memory validity metadata is incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'assistant_memory_items_capture_revision'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'assistant memory revision trigger is missing';
  END IF;
  END;
$$;
