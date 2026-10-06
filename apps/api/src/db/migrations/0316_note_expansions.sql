-- A confirmed note created from a companion conversation. The exact source
-- version and the exact new-note version remain linked in both directions.
CREATE TABLE public.note_expansions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source_note_id uuid NOT NULL REFERENCES public.notes(id) ON DELETE CASCADE,
  source_note_version_id uuid NOT NULL,
  expanded_note_id uuid NOT NULL REFERENCES public.notes(id) ON DELETE CASCADE,
  expanded_note_version_id uuid NOT NULL,
  source_message_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_body_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT note_expansions_source_version_fk
    FOREIGN KEY (workspace_id, source_note_id, source_note_version_id)
    REFERENCES public.note_versions(workspace_id, note_id, id) ON DELETE CASCADE,
  CONSTRAINT note_expansions_expanded_version_fk
    FOREIGN KEY (workspace_id, expanded_note_id, expanded_note_version_id)
    REFERENCES public.note_versions(workspace_id, note_id, id) ON DELETE CASCADE,
  CONSTRAINT note_expansions_source_not_target CHECK (source_note_id <> expanded_note_id)
);

CREATE INDEX note_expansions_source_order_idx
  ON public.note_expansions(workspace_id, user_id, source_note_id, created_at DESC, id DESC);
CREATE INDEX note_expansions_expanded_order_idx
  ON public.note_expansions(workspace_id, user_id, expanded_note_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX note_expansions_request_unique_idx
  ON public.note_expansions(workspace_id, user_id, request_id);

ALTER TABLE public.note_expansions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_expansions FORCE ROW LEVEL SECURITY;
CREATE POLICY note_expansions_owner ON public.note_expansions FOR ALL TO PUBLIC
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.notes source_note
      WHERE source_note.id = note_expansions.source_note_id
        AND source_note.workspace_id = note_expansions.workspace_id
        AND source_note.deleted_at IS NULL
        AND (source_note.share_scope = 'shared' OR source_note.created_by = note_expansions.user_id)
    )
    AND EXISTS (
      SELECT 1 FROM public.notes expanded_note
      WHERE expanded_note.id = note_expansions.expanded_note_id
        AND expanded_note.workspace_id = note_expansions.workspace_id
        AND expanded_note.deleted_at IS NULL
        AND (expanded_note.share_scope = 'shared' OR expanded_note.created_by = note_expansions.user_id)
    ))
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.notes source_note
      WHERE source_note.id = note_expansions.source_note_id
        AND source_note.workspace_id = note_expansions.workspace_id
        AND source_note.deleted_at IS NULL
        AND (source_note.share_scope = 'shared' OR source_note.created_by = note_expansions.user_id)
    )
    AND EXISTS (
      SELECT 1 FROM public.notes expanded_note
      WHERE expanded_note.id = note_expansions.expanded_note_id
        AND expanded_note.workspace_id = note_expansions.workspace_id
        AND expanded_note.deleted_at IS NULL
        AND (expanded_note.share_scope = 'shared' OR expanded_note.created_by = note_expansions.user_id)
    ));

GRANT SELECT, INSERT ON public.note_expansions TO astella_api;
GRANT ALL PRIVILEGES ON public.note_expansions TO astella_migrator;
