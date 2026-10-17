-- 0443: durable sample store for the L1 release router (`COMPANION_RELEASE_ROUTER`).
--
-- Before this, the online kNN index lived only in worker process memory: a restart
-- dropped it back to "cold" and the coalesced coverage curve fell for a while. Storing
-- the (text digest, L2 labels, embedding) row lets a restart load the index without
-- paying embedding again, and gives the shadow curve a stable sample base.
--
-- Only the digest and the vector are stored — never the utterance text. `text_sha256`
-- also carries the dedupe key together with the labels.

CREATE TABLE public.companion_release_router_samples (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  text_sha256 char(64) NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  intent text NOT NULL,
  tool_use text NOT NULL,
  embedding jsonb NOT NULL CHECK (jsonb_typeof(embedding) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX companion_release_router_samples_key_idx
  ON public.companion_release_router_samples(workspace_id, user_id, text_sha256, intent, tool_use);

CREATE INDEX companion_release_router_samples_scope_idx
  ON public.companion_release_router_samples(workspace_id, user_id, updated_at DESC);

ALTER TABLE public.companion_release_router_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_release_router_samples FORCE ROW LEVEL SECURITY;

CREATE POLICY companion_release_router_samples_worker_scope
  ON public.companion_release_router_samples FOR ALL TO astella_worker
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

REVOKE ALL PRIVILEGES ON public.companion_release_router_samples FROM PUBLIC, astella_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_release_router_samples TO astella_worker;
GRANT ALL PRIVILEGES ON public.companion_release_router_samples TO astella_migrator;

COMMENT ON TABLE public.companion_release_router_samples IS
  'L1 release-router kNN samples: text digest + L2 labels + embedding. No utterance text; worker-scoped RLS.';

COMMENT ON COLUMN public.companion_release_router_samples.text_sha256 IS
  'sha256 of the normalized utterance; dedupe key with (intent, tool_use). Plain text is never stored.';
