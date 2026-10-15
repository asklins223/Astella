-- A summary contains its parent's prose as well as its own message range.
-- Invalidating only the directly covered range lets descendants repeat forgotten
-- or edited content. Invalidate every descendant, including on parent deletion
-- and replacement. Sibling summaries of unaffected ranges stay usable.
CREATE OR REPLACE FUNCTION public.astella_invalidate_summary_descendants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- ON DELETE SET NULL updates only surviving children, after the original
  -- DELETE has completed its row work. Mark them here: a BEFORE DELETE trigger
  -- updating a child also deleted by that command raises PostgreSQL 27000.
  IF TG_OP = 'UPDATE' AND OLD.parent_summary_id IS NOT NULL
    AND NEW.parent_summary_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.conversation_summaries WHERE id = OLD.parent_summary_id)
  THEN
    UPDATE public.conversation_summaries SET invalidated_at = now()
    WHERE id = NEW.id AND invalidated_at IS NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT (
    (NEW.invalidated_at IS NOT NULL AND OLD.invalidated_at IS DISTINCT FROM NEW.invalidated_at)
    OR (NEW.status NOT IN ('candidate', 'confirmed') AND NEW.status IS DISTINCT FROM OLD.status)
    OR NEW.summary IS DISTINCT FROM OLD.summary
    OR NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.coverage_source_hash IS DISTINCT FROM OLD.coverage_source_hash
  ) THEN
    RETURN NEW;
  END IF;

  WITH RECURSIVE descendants AS (
    SELECT s.id FROM public.conversation_summaries s
    WHERE s.parent_summary_id = OLD.id
      AND s.conversation_id = OLD.conversation_id
      AND s.workspace_id = OLD.workspace_id AND s.user_id = OLD.user_id
      AND s.invalidated_at IS NULL
    UNION
    SELECT s.id FROM public.conversation_summaries s
    JOIN descendants p ON s.parent_summary_id = p.id
    WHERE s.conversation_id = OLD.conversation_id
      AND s.workspace_id = OLD.workspace_id AND s.user_id = OLD.user_id
      AND s.invalidated_at IS NULL
  )
  UPDATE public.conversation_summaries s SET invalidated_at = now()
  FROM descendants d WHERE s.id = d.id AND s.invalidated_at IS NULL;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.astella_invalidate_summary_descendants() FROM PUBLIC;

--> statement-breakpoint

CREATE TRIGGER conversation_summary_invalidate_descendants
  AFTER UPDATE OF invalidated_at, status, summary, revision, coverage_source_hash, parent_summary_id
  ON public.conversation_summaries
  FOR EACH ROW EXECUTE FUNCTION public.astella_invalidate_summary_descendants();

--> statement-breakpoint

WITH RECURSIVE invalid AS (
  SELECT id, conversation_id, workspace_id, user_id
  FROM public.conversation_summaries
  WHERE invalidated_at IS NOT NULL OR status NOT IN ('candidate', 'confirmed')
  UNION
  SELECT s.id, s.conversation_id, s.workspace_id, s.user_id
  FROM public.conversation_summaries s
  JOIN invalid p ON s.parent_summary_id = p.id
    AND s.conversation_id = p.conversation_id
    AND s.workspace_id = p.workspace_id AND s.user_id = p.user_id
)
UPDATE public.conversation_summaries s SET invalidated_at = now()
FROM invalid p WHERE s.id = p.id AND s.invalidated_at IS NULL;
