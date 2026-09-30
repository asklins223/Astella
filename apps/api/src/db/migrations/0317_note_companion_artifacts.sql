-- AI-authored, note-anchored interactive explanations created from Companion replies.
CREATE TABLE public.note_companion_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES public.notes(id) ON DELETE CASCADE,
  note_version_id uuid NOT NULL,
  source_message_id uuid NOT NULL REFERENCES public.companion_messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.companion_conversations(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind IN ('overview', 'annotation')),
  selection_text text CHECK (selection_text IS NULL OR char_length(selection_text) BETWEEN 1 AND 2000),
  source_content_hash char(64) NOT NULL,
  generator_ref text NOT NULL CHECK (char_length(generator_ref) BETWEEN 1 AND 200),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 40),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 60),
  caution text NOT NULL CHECK (char_length(caution) BETWEEN 1 AND 120),
  outline_json jsonb NOT NULL CHECK (jsonb_typeof(outline_json) = 'array'),
  html text NOT NULL CHECK (char_length(html) BETWEEN 1 AND 220000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT note_companion_artifacts_version_note_fk
    FOREIGN KEY (workspace_id, note_id, note_version_id)
    REFERENCES public.note_versions(workspace_id, note_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX note_companion_artifacts_workspace_id_unique_idx
  ON public.note_companion_artifacts(workspace_id, id);
CREATE UNIQUE INDEX note_companion_artifacts_source_unique_idx
  ON public.note_companion_artifacts(workspace_id, user_id, note_id, source_message_id);
CREATE INDEX note_companion_artifacts_history_idx
  ON public.note_companion_artifacts(workspace_id, user_id, note_id, created_at DESC, id DESC);

ALTER TABLE public.note_companion_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_companion_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY note_companion_artifacts_owner ON public.note_companion_artifacts FOR ALL TO PUBLIC
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.notes visible_note
      WHERE visible_note.id = note_companion_artifacts.note_id
        AND visible_note.workspace_id = note_companion_artifacts.workspace_id
        AND visible_note.deleted_at IS NULL
        AND (visible_note.share_scope = 'shared' OR visible_note.created_by = note_companion_artifacts.user_id)
    ))
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.notes visible_note
      WHERE visible_note.id = note_companion_artifacts.note_id
        AND visible_note.workspace_id = note_companion_artifacts.workspace_id
        AND visible_note.deleted_at IS NULL
        AND (visible_note.share_scope = 'shared' OR visible_note.created_by = note_companion_artifacts.user_id)
    ));

GRANT SELECT, INSERT ON public.note_companion_artifacts TO ailearn_api;
GRANT ALL PRIVILEGES ON public.note_companion_artifacts TO ailearn_migrator;
