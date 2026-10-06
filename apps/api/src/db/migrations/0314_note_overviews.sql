-- Durable quick overviews generated with the companion. Each copy belongs to
-- the exact note version and assistant message that produced it.
CREATE TABLE public.note_overviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES public.notes(id) ON DELETE CASCADE,
  note_version_id uuid NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  source_message_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT note_overviews_version_note_fk
    FOREIGN KEY (workspace_id, note_id, note_version_id)
    REFERENCES public.note_versions(workspace_id, note_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX note_overviews_workspace_id_unique_idx
  ON public.note_overviews(workspace_id, id);
CREATE UNIQUE INDEX note_overviews_source_message_unique_idx
  ON public.note_overviews(workspace_id, user_id, note_id, source_message_id);
CREATE INDEX note_overviews_created_at_idx
  ON public.note_overviews(workspace_id, user_id, note_id, created_at DESC, id DESC);

ALTER TABLE public.note_overviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_overviews FORCE ROW LEVEL SECURITY;
CREATE POLICY note_overviews_owner ON public.note_overviews FOR ALL TO PUBLIC
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.notes visible_note
      WHERE visible_note.id = note_overviews.note_id
        AND visible_note.workspace_id = note_overviews.workspace_id
        AND visible_note.deleted_at IS NULL
        AND (visible_note.share_scope = 'shared' OR visible_note.created_by = note_overviews.user_id)
    ))
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.notes visible_note
      WHERE visible_note.id = note_overviews.note_id
        AND visible_note.workspace_id = note_overviews.workspace_id
        AND visible_note.deleted_at IS NULL
        AND (visible_note.share_scope = 'shared' OR visible_note.created_by = note_overviews.user_id)
    ));

GRANT SELECT, INSERT ON public.note_overviews TO astella_api;
GRANT ALL PRIVILEGES ON public.note_overviews TO astella_migrator;
