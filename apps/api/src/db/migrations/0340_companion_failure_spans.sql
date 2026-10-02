-- Keep one bounded, private aggregate per workspace/user/failure class. This
-- stores operational metadata only; no provider text, prompt, or user content.
CREATE TABLE public.companion_run_failure_spans (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  failure_class text NOT NULL CHECK (
    failure_class IN ('transport', 'output', 'tool', 'delivery', 'tts', 'execution', 'state')
  ),
  span_started_at timestamptz NOT NULL,
  last_failure_at timestamptz NOT NULL,
  failure_count integer NOT NULL CHECK (failure_count BETWEEN 1 AND 1000000000),
  first_run_id uuid REFERENCES public.companion_turn_runs(id) ON DELETE SET NULL,
  last_run_id uuid REFERENCES public.companion_turn_runs(id) ON DELETE SET NULL,
  recovered_at timestamptz,
  recovery_run_id uuid REFERENCES public.companion_turn_runs(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, failure_class),
  CHECK (recovery_run_id IS NULL OR recovered_at IS NOT NULL)
);

CREATE INDEX companion_run_failure_spans_scope_latest_idx
  ON public.companion_run_failure_spans(workspace_id, user_id, last_failure_at DESC);

ALTER TABLE public.companion_run_failure_spans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_run_failure_spans FORCE ROW LEVEL SECURITY;

CREATE POLICY companion_run_failure_spans_worker_scope
  ON public.companion_run_failure_spans FOR ALL TO ailearn_worker
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

CREATE POLICY companion_run_failure_spans_api_read_scope
  ON public.companion_run_failure_spans FOR SELECT TO ailearn_api
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

REVOKE ALL PRIVILEGES ON public.companion_run_failure_spans FROM PUBLIC, ailearn_api, ailearn_worker;
GRANT SELECT ON public.companion_run_failure_spans TO ailearn_api;
GRANT SELECT, INSERT, UPDATE ON public.companion_run_failure_spans TO ailearn_worker;
GRANT ALL PRIVILEGES ON public.companion_run_failure_spans TO ailearn_migrator;

-- Reuse the existing companion audit retention job. Even an open failure span
-- is operational metadata subject to the same retention ceiling.
CREATE OR REPLACE FUNCTION public.ailearn_purge_companion_audit_ttl(
  p_retention_days integer DEFAULT 30,
  p_limit integer DEFAULT 200
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH target AS (
    SELECT id
    FROM public.companion_audit
    WHERE created_at < now() - make_interval(days => p_retention_days)
      AND tombstoned_at IS NULL
    LIMIT p_limit
  ), updated AS (
    UPDATE public.companion_audit
    SET page_opaque_id = NULL,
        action_opaque_id = NULL,
        entity_opaque_ids = '{}',
        context_permission_hashes = NULL,
        tombstoned_at = now()
    WHERE id IN (SELECT id FROM target)
    RETURNING id
  ), remaining AS (
    SELECT GREATEST(p_limit - (SELECT count(*) FROM updated), 0)::integer AS remaining_rows
  ), stale_spans AS (
    SELECT workspace_id, user_id, failure_class
    FROM public.companion_run_failure_spans
    WHERE last_failure_at < now() - make_interval(days => p_retention_days)
    ORDER BY last_failure_at
    LIMIT (SELECT remaining_rows FROM remaining)
  ), deleted_spans AS (
    DELETE FROM public.companion_run_failure_spans AS spans
    USING stale_spans
    WHERE spans.workspace_id = stale_spans.workspace_id
      AND spans.user_id = stale_spans.user_id
      AND spans.failure_class = stale_spans.failure_class
    RETURNING 1
  )
  SELECT ((SELECT count(*) FROM updated) + (SELECT count(*) FROM deleted_spans))::integer;
$function$;

ALTER FUNCTION public.ailearn_purge_companion_audit_ttl(integer, integer)
  OWNER TO ailearn_migrator;
ALTER FUNCTION public.ailearn_purge_companion_audit_ttl(integer, integer)
  SET search_path = pg_catalog, public;
