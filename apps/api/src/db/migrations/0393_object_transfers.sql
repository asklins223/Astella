-- Durable receipts for direct object uploads; staging URLs never authorize final objects.
CREATE TABLE IF NOT EXISTS public.object_transfers (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  staging_key text NOT NULL UNIQUE,
  request_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verifying','completed','failed')),
  result_json jsonb,
  result_status integer,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS object_transfers_expiry_idx ON public.object_transfers(expires_at);
ALTER TABLE public.object_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY object_transfers_actor_isolation ON public.object_transfers FOR ALL
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.object_transfers TO astella_api;

CREATE OR REPLACE FUNCTION public.astella_purge_expired_object_transfers() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  DELETE FROM public.object_transfers WHERE expires_at < now() - interval '1 day';
$$;
REVOKE ALL ON FUNCTION public.astella_purge_expired_object_transfers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_purge_expired_object_transfers() TO astella_api;
