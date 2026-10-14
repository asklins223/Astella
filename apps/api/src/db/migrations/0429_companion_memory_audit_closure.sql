-- Close the user-facing provenance, epistemic-state and lifecycle gaps found in
-- the long-memory audit. Existing content remains owned by its original scope.

-- 迁移器按**文件内容哈希**决定要不要重放：这份文件以后再被编辑过一次，就会在已经
-- 迁过的库上重跑一次（0423 那种 `IF NOT EXISTS` / `DROP ... IF EXISTS` 就是为了这个）。
-- 这里原先四条裸 DDL 都会在同一列/同一约束/同一触发器上直接报错，而 `migrate` 挂掉
-- 会连带 role-grants 与 api 容器起不来。
ALTER TABLE public.assistant_memory_items
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_by_id uuid;
ALTER TABLE public.assistant_memory_items
  DROP CONSTRAINT IF EXISTS assistant_memory_items_superseded_by_fk,
  DROP CONSTRAINT IF EXISTS assistant_memory_items_not_self_superseded;
ALTER TABLE public.assistant_memory_items
  ADD CONSTRAINT assistant_memory_items_superseded_by_fk
    FOREIGN KEY (superseded_by_id) REFERENCES public.assistant_memory_items(id) ON DELETE SET NULL,
  ADD CONSTRAINT assistant_memory_items_not_self_superseded
    CHECK (superseded_by_id IS NULL OR superseded_by_id <> id);

ALTER TABLE public.assistant_memory_item_revisions
  ADD COLUMN IF NOT EXISTS source_event_ids text[],
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_by_id uuid;

UPDATE public.assistant_memory_items
   SET confirmed_at = COALESCE(confirmed_at, updated_at, created_at)
 WHERE user_confirmed = true AND confirmed_at IS NULL;

UPDATE public.assistant_memory_item_revisions
   SET confirmed_at = superseded_at
 WHERE user_confirmed = true AND confirmed_at IS NULL;

CREATE INDEX IF NOT EXISTS assistant_memory_items_superseded_by_idx
  ON public.assistant_memory_items(superseded_by_id)
  WHERE superseded_by_id IS NOT NULL;

--> statement-breakpoint

-- Keep all evidence that can change what the model should believe in the
-- immutable revision snapshot, including a judgment's multi-message sources.
CREATE OR REPLACE FUNCTION public.capture_assistant_memory_item_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF ROW(
    NEW.kind, NEW.content, NEW.source_event_id, NEW.source_event_ids,
    NEW.source_session_id, NEW.source_speaker, NEW.source_basis,
    NEW.applies_when, NEW.valid_from, NEW.valid_until, NEW.user_stated,
    NEW.user_confirmed, NEW.confirmed_at, NEW.importance, NEW.confidence,
    NEW.scope, NEW.source_type, NEW.author_type, NEW.author_id,
    NEW.epistemic_status, NEW.superseded_by_id
  ) IS DISTINCT FROM ROW(
    OLD.kind, OLD.content, OLD.source_event_id, OLD.source_event_ids,
    OLD.source_session_id, OLD.source_speaker, OLD.source_basis,
    OLD.applies_when, OLD.valid_from, OLD.valid_until, OLD.user_stated,
    OLD.user_confirmed, OLD.confirmed_at, OLD.importance, OLD.confidence,
    OLD.scope, OLD.source_type, OLD.author_type, OLD.author_id,
    OLD.epistemic_status, OLD.superseded_by_id
  ) THEN
    INSERT INTO public.assistant_memory_item_revisions (
      memory_id, workspace_id, user_id, revision, kind, content,
      source_event_id, source_event_ids, source_session_id, source_speaker,
      source_basis, applies_when, valid_from, valid_until, user_stated,
      user_confirmed, confirmed_at, importance, confidence, scope, source_type,
      author_type, author_id, epistemic_status, superseded_by_id
    ) VALUES (
      OLD.id, OLD.workspace_id, OLD.user_id, OLD.revision, OLD.kind, OLD.content,
      OLD.source_event_id, OLD.source_event_ids, OLD.source_session_id, OLD.source_speaker,
      OLD.source_basis, OLD.applies_when, OLD.valid_from, OLD.valid_until, OLD.user_stated,
      OLD.user_confirmed, OLD.confirmed_at, OLD.importance, OLD.confidence, OLD.scope,
      OLD.source_type, OLD.author_type, OLD.author_id, OLD.epistemic_status, OLD.superseded_by_id
    );
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint

-- The old archived_at retirement state and the newer budget_tier='archived'
-- state now describe one cold-storage state. Backfill both directions and keep
-- future writes in sync, so archived memories are counted by retention and the
-- restore action makes them searchable again.
UPDATE public.assistant_memory_items
   SET budget_tier = 'archived'
 WHERE deleted_at IS NULL AND archived_at IS NOT NULL AND budget_tier <> 'archived';

UPDATE public.assistant_memory_items
   SET archived_at = COALESCE(updated_at, created_at, now())
 WHERE deleted_at IS NULL AND budget_tier = 'archived' AND archived_at IS NULL;

CREATE OR REPLACE FUNCTION public.astella_sync_companion_memory_archive_tier()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.archived_at IS NOT NULL THEN
      NEW.budget_tier := 'archived';
    ELSIF NEW.budget_tier = 'archived' THEN
      NEW.archived_at := COALESCE(NEW.created_at, now());
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.budget_tier IS DISTINCT FROM OLD.budget_tier
     AND NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    NEW.archived_at := CASE WHEN NEW.budget_tier = 'archived'
      THEN COALESCE(NEW.archived_at, now()) ELSE NULL END;
  ELSIF NEW.budget_tier IS DISTINCT FROM OLD.budget_tier THEN
    NEW.archived_at := CASE WHEN NEW.budget_tier = 'archived' THEN now() ELSE NULL END;
  ELSIF NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    NEW.budget_tier := CASE WHEN NEW.archived_at IS NULL THEN 'active' ELSE 'archived' END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assistant_memory_archive_tier_sync ON public.assistant_memory_items;
CREATE TRIGGER assistant_memory_archive_tier_sync
  BEFORE INSERT OR UPDATE OF budget_tier, archived_at ON public.assistant_memory_items
  FOR EACH ROW EXECUTE FUNCTION public.astella_sync_companion_memory_archive_tier();
REVOKE ALL ON FUNCTION public.astella_sync_companion_memory_archive_tier() FROM PUBLIC;

-- The existing worker-only enqueue helper writes embedding jobs directly.
-- Keep the allowlist in sync so the retry scheduler and write-side enqueue
-- paths are authorized under the restricted worker role.
DROP POLICY IF EXISTS worker_type_allowlist_insert_guard ON public.jobs;
CREATE POLICY worker_type_allowlist_insert_guard ON public.jobs AS PERMISSIVE FOR INSERT TO public
  WITH CHECK(CURRENT_USER='astella_worker'::name AND type IN (
    'companion_agent','companion_initiative','companion_followup_suggestions',
    'companion_memory_extract','companion_summarizer','companion_daily_summary',
    'companion_memory_organize','companion_reflection','companion_memory_embedding_rebuild'
  ));

-- The API exposes a scoped clear-derived-data action. Diary generation
-- checkpoints otherwise remain worker-only because they contain private drafts.
GRANT DELETE ON public.companion_diary_generation_checkpoints TO astella_api;
DROP POLICY IF EXISTS companion_diary_checkpoint_api_user_delete ON public.companion_diary_generation_checkpoints;
CREATE POLICY companion_diary_checkpoint_api_user_delete
  ON public.companion_diary_generation_checkpoints FOR DELETE TO astella_api
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

-- Retrieval telemetry contains only opaque memory/run IDs and latency, but it
-- is still derived from the user's use. The explicit clear action removes it.
GRANT DELETE ON public.memory_usage_log TO astella_api;

-- Those tables intentionally expose only read/write access for normal API
-- handlers. The explicit user initiated purge needs DELETE for exactly these
-- scoped derived records.
GRANT DELETE ON public.companion_self_note_versions TO astella_api;
GRANT DELETE ON public.companion_procedural_playbooks TO astella_api;

CREATE INDEX IF NOT EXISTS memory_usage_log_ws_user_created_idx
  ON public.memory_usage_log(workspace_id, user_id, created_at DESC);

--> statement-breakpoint

-- Leaving a shared workspace is a recoverable retirement, not a deletion with
-- NULL purge_after that can remain forever. Source tombstones prevent a late
-- extractor from recreating the same memory.
CREATE OR REPLACE FUNCTION public.astella_retire_workspace_memories_on_departure(
  p_workspace_id uuid, p_user_id uuid
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_retired integer := 0; v_now timestamptz := now();
BEGIN
  IF p_workspace_id IS NULL OR p_user_id IS NULL THEN RETURN 0; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('companion-memory-write:' || p_user_id::text, 0));
  INSERT INTO public.assistant_memory_source_suppressions(user_id, kind, source_event_id)
    SELECT DISTINCT user_id, kind, source_event_id
      FROM public.assistant_memory_items
     WHERE workspace_id = p_workspace_id AND user_id = p_user_id
       AND scope = 'workspace' AND deleted_at IS NULL AND source_event_id IS NOT NULL
    ON CONFLICT (user_id, kind, source_event_id) DO NOTHING;
  UPDATE public.assistant_memory_items
     SET deleted_at = v_now, purge_after = v_now + interval '30 days', updated_at = v_now
   WHERE workspace_id = p_workspace_id AND user_id = p_user_id
     AND scope = 'workspace' AND deleted_at IS NULL;
  GET DIAGNOSTICS v_retired = ROW_COUNT;
  RETURN v_retired;
END;
$$;
REVOKE ALL ON FUNCTION public.astella_retire_workspace_memories_on_departure(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_retire_workspace_memories_on_departure(uuid, uuid) TO astella_api, astella_migrator;

COMMENT ON COLUMN public.assistant_memory_items.confirmed_at IS
  'When a user explicitly confirmed this memory; NULL means confirmation time is unknown or it was not confirmed.';
COMMENT ON COLUMN public.assistant_memory_items.superseded_by_id IS
  'The surviving memory that replaced this row during consolidation; superseded rows are never automatically retrieved.';
