-- The snapshot includes exact model inputs, so keep it outside the API-readable
-- turn row. A run owns one immutable snapshot; deleting the run removes it.
CREATE TABLE public.companion_context_handoff_snapshots (
  run_id uuid PRIMARY KEY
    REFERENCES public.companion_turn_runs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL
    REFERENCES public.companion_conversations(id) ON DELETE CASCADE,
  snapshot jsonb NOT NULL,
  snapshot_sha256 char(64) NOT NULL
    CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_version integer NOT NULL CHECK (snapshot_version = 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_context_handoff_snapshot_version_check
    CHECK (
      jsonb_typeof(snapshot) = 'object'
      AND snapshot->>'version' = '1'
      AND snapshot->>'runId' = run_id::text
      AND snapshot->>'conversationId' = conversation_id::text
    )
);

CREATE INDEX companion_context_handoff_snapshots_scope_idx
  ON public.companion_context_handoff_snapshots(workspace_id, user_id, conversation_id, created_at DESC);

ALTER TABLE public.companion_context_handoff_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_context_handoff_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY companion_context_handoff_snapshots_worker_scope
  ON public.companion_context_handoff_snapshots FOR ALL TO astella_worker
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

REVOKE ALL PRIVILEGES ON public.companion_context_handoff_snapshots FROM PUBLIC, astella_api;
GRANT SELECT, INSERT ON public.companion_context_handoff_snapshots TO astella_worker;
GRANT ALL PRIVILEGES ON public.companion_context_handoff_snapshots TO astella_migrator;
