-- New workspace-scoped records must have a parent. NOT VALID avoids silently
-- deleting historical orphans on upgrade while enforcing all future writes.
-- Validate when the existing data permits; otherwise operators receive a
-- warning and can reconcile those rows before validating the constraints.
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('companion_reflections', 'companion_reflections_workspace_fk'),
    ('companion_reflection_sources', 'companion_reflection_sources_workspace_fk'),
    ('companion_reflection_checkpoints', 'companion_reflection_checkpoints_workspace_fk'),
    ('companion_release_router_samples', 'companion_release_router_samples_workspace_fk'),
    ('note_mind_map_stages', 'note_mind_map_stages_workspace_fk')
  ) AS targets(table_name, constraint_name)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = format('public.%I', item.table_name)::regclass
        AND conname = item.constraint_name) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE NOT VALID',
        item.table_name, item.constraint_name);
    END IF;
    BEGIN
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', item.table_name, item.constraint_name);
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE WARNING 'Constraint % remains NOT VALID: historical orphan rows need reconciliation', item.constraint_name;
    END;
  END LOOP;
END $$;

--> statement-breakpoint

-- learning_runs was retired in 0449. Retain the old response column for
-- compatible clients, but report zero rather than query a dropped table.
CREATE OR REPLACE FUNCTION public.astella_admin_platform_counts()
RETURNS TABLE (users_total integer, workspaces_total integer, notes_active integer,
  jobs_total integer, runs_total integer, sessions_active integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
  SELECT (SELECT count(*)::integer FROM public.users),
    (SELECT count(*)::integer FROM public.workspaces),
    (SELECT count(*)::integer FROM public.notes WHERE deleted_at IS NULL),
    (SELECT count(*)::integer FROM public.jobs),
    0::integer,
    (SELECT count(*)::integer FROM public.sessions WHERE expires_at > now());
$function$;
