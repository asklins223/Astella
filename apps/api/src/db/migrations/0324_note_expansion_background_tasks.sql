-- Expansion discovery and note drafts belong to a durable note task. Companion
-- messages may be recorded as optional context, but they are not the task result.
CREATE TABLE public.note_expansion_tasks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES public.notes(id) ON DELETE CASCADE,
  note_version_id uuid NOT NULL,
  request_id uuid NOT NULL,
  focus_anchor jsonb,
  source_message_id uuid,
  conversation_id uuid,
  drafts jsonb NOT NULL DEFAULT '[]'::jsonb,
  confirmed_candidate_ids jsonb,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT note_expansion_tasks_version_note_fk
    FOREIGN KEY (workspace_id, note_id, note_version_id)
    REFERENCES public.note_versions(workspace_id, note_id, id) ON DELETE CASCADE,
  CONSTRAINT note_expansion_tasks_job_workspace_fk
    FOREIGN KEY (id, workspace_id)
    REFERENCES public.jobs(id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT note_expansion_tasks_source_pair_check
    CHECK ((source_message_id IS NULL) = (conversation_id IS NULL)),
  CONSTRAINT note_expansion_tasks_drafts_shape_check
    CHECK (jsonb_typeof(drafts) = 'array' AND jsonb_array_length(drafts) <= 4),
  CONSTRAINT note_expansion_tasks_confirmed_ids_shape_check
    CHECK (confirmed_candidate_ids IS NULL OR
      (jsonb_typeof(confirmed_candidate_ids) = 'array' AND jsonb_array_length(confirmed_candidate_ids) BETWEEN 1 AND 4))
);

CREATE UNIQUE INDEX note_expansion_tasks_id_workspace_unique_idx
  ON public.note_expansion_tasks(id, workspace_id);
CREATE UNIQUE INDEX note_expansion_tasks_request_unique_idx
  ON public.note_expansion_tasks(workspace_id, user_id, note_id, request_id);
CREATE INDEX note_expansion_tasks_note_version_order_idx
  ON public.note_expansion_tasks(workspace_id, user_id, note_id, note_version_id, created_at, id);

ALTER TABLE public.note_expansion_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_expansion_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY note_expansion_tasks_owner ON public.note_expansion_tasks FOR ALL TO PUBLIC
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.notes source_note
      WHERE source_note.id = note_expansion_tasks.note_id
        AND source_note.workspace_id = note_expansion_tasks.workspace_id
        AND source_note.deleted_at IS NULL
        AND (source_note.share_scope = 'shared' OR source_note.created_by = note_expansion_tasks.user_id)
    ))
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.notes source_note
      WHERE source_note.id = note_expansion_tasks.note_id
        AND source_note.workspace_id = note_expansion_tasks.workspace_id
        AND source_note.deleted_at IS NULL
        AND (source_note.share_scope = 'shared' OR source_note.created_by = note_expansion_tasks.user_id)
    ));

GRANT SELECT, INSERT, UPDATE ON public.note_expansion_tasks TO ailearn_api;
GRANT SELECT, INSERT ON public.note_expansion_tasks TO ailearn_worker;
GRANT ALL PRIVILEGES ON public.note_expansion_tasks TO ailearn_migrator;

ALTER TABLE public.note_expansions
  ALTER COLUMN source_message_id DROP NOT NULL,
  ALTER COLUMN conversation_id DROP NOT NULL,
  ADD COLUMN source_task_id uuid;

ALTER TABLE public.note_expansions
  ADD CONSTRAINT note_expansions_source_task_workspace_fk
    FOREIGN KEY (source_task_id, workspace_id)
    REFERENCES public.note_expansion_tasks(id, workspace_id) ON DELETE RESTRICT,
  ADD CONSTRAINT note_expansions_source_pair_check
    CHECK ((source_message_id IS NULL) = (conversation_id IS NULL));
