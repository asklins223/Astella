-- A self-directed, note-version-bound recall attempt. Hints, reveals and self-reports
-- stay attached to this record; a later attempt creates another row.
CREATE TABLE public.note_recall_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES public.notes(id) ON DELETE CASCADE,
  note_version_id uuid NOT NULL,
  request_id uuid NOT NULL,
  section_ordinal integer NOT NULL CHECK (section_ordinal > 0),
  section_title text CHECK (section_title IS NULL OR char_length(section_title) <= 200),
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 500),
  hint_snapshot text NOT NULL CHECK (char_length(hint_snapshot) BETWEEN 1 AND 1000),
  answer_snapshot text NOT NULL CHECK (char_length(answer_snapshot) BETWEEN 1 AND 20000),
  answer_truncated boolean NOT NULL DEFAULT false,
  self_report text CHECK (self_report IS NULL OR self_report IN ('remembered', 'partly', 'not_yet')),
  reflection text CHECK (reflection IS NULL OR char_length(reflection) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  hint_viewed_at timestamptz,
  revealed_at timestamptz,
  reported_at timestamptz,
  CONSTRAINT note_recall_records_version_note_fk
    FOREIGN KEY (workspace_id, note_id, note_version_id)
    REFERENCES public.note_versions(workspace_id, note_id, id) ON DELETE CASCADE,
  CONSTRAINT note_recall_report_after_reveal CHECK (reported_at IS NULL OR revealed_at IS NOT NULL)
);

CREATE INDEX note_recall_records_history_idx
  ON public.note_recall_records(workspace_id, user_id, note_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX note_recall_records_request_unique_idx
  ON public.note_recall_records(workspace_id, user_id, request_id);

ALTER TABLE public.note_recall_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_recall_records FORCE ROW LEVEL SECURITY;
CREATE POLICY note_recall_records_owner ON public.note_recall_records FOR ALL TO PUBLIC
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.notes visible_note
      WHERE visible_note.id = note_recall_records.note_id
        AND visible_note.workspace_id = note_recall_records.workspace_id
        AND visible_note.deleted_at IS NULL
        AND (visible_note.share_scope = 'shared' OR visible_note.created_by = note_recall_records.user_id)
    ))
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.notes visible_note
      WHERE visible_note.id = note_recall_records.note_id
        AND visible_note.workspace_id = note_recall_records.workspace_id
        AND visible_note.deleted_at IS NULL
        AND (visible_note.share_scope = 'shared' OR visible_note.created_by = note_recall_records.user_id)
    ));

GRANT SELECT, INSERT, UPDATE ON public.note_recall_records TO ailearn_api;
GRANT ALL PRIVILEGES ON public.note_recall_records TO ailearn_migrator;
