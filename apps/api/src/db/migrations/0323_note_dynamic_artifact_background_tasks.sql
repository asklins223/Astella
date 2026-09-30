-- Dynamic learning pages are note-owned background results. Companion chat may be recorded as optional provenance.
ALTER TABLE public.note_companion_artifacts RENAME TO note_learning_artifacts;

ALTER TABLE public.note_learning_artifacts
  ALTER COLUMN source_message_id DROP NOT NULL,
  ALTER COLUMN conversation_id DROP NOT NULL,
  ADD COLUMN request_id uuid,
  ADD COLUMN generation_job_id uuid;

-- Chat rows can be cleared without deleting a note's saved learning record.
ALTER TABLE public.note_learning_artifacts
  DROP CONSTRAINT IF EXISTS note_companion_artifacts_source_message_id_fkey,
  DROP CONSTRAINT IF EXISTS note_companion_artifacts_conversation_id_fkey;
ALTER TABLE public.note_learning_artifacts
  RENAME CONSTRAINT note_companion_artifacts_version_note_fk TO note_learning_artifacts_version_note_fk;

ALTER TABLE public.note_learning_artifacts
  RENAME CONSTRAINT note_companion_artifacts_source_kind_check TO note_learning_artifacts_source_kind_check;
ALTER TABLE public.note_learning_artifacts
  RENAME CONSTRAINT note_companion_artifacts_selection_text_check TO note_learning_artifacts_selection_length_check;
ALTER TABLE public.note_learning_artifacts
  RENAME CONSTRAINT note_companion_artifacts_selection_anchor_shape_check TO note_learning_artifacts_selection_anchor_shape_check;
ALTER TABLE public.note_learning_artifacts
  RENAME CONSTRAINT note_companion_artifacts_overview_selection_check TO note_learning_artifacts_overview_selection_check;
ALTER TABLE public.note_learning_artifacts
  ALTER COLUMN source_content_hash TYPE text USING btrim(source_content_hash::text);
ALTER TABLE public.note_learning_artifacts
  ADD CONSTRAINT note_learning_artifacts_hash_length_check
    CHECK (char_length(source_content_hash) = 64);
ALTER TABLE public.note_learning_artifacts
  RENAME CONSTRAINT note_companion_artifacts_html_check TO note_learning_artifacts_html_length_check;

ALTER TABLE public.note_learning_artifacts
  ADD CONSTRAINT note_learning_artifacts_generation_job_workspace_fk
    FOREIGN KEY (generation_job_id, workspace_id)
    REFERENCES public.jobs(id, workspace_id) ON DELETE RESTRICT;

DROP INDEX IF EXISTS public.note_companion_artifacts_source_unique_idx;
CREATE UNIQUE INDEX note_learning_artifacts_source_unique_idx
  ON public.note_learning_artifacts(workspace_id, user_id, note_id, source_message_id)
  WHERE source_message_id IS NOT NULL;
CREATE UNIQUE INDEX note_learning_artifacts_generation_job_unique_idx
  ON public.note_learning_artifacts(workspace_id, generation_job_id)
  WHERE generation_job_id IS NOT NULL;
CREATE UNIQUE INDEX note_learning_artifacts_request_unique_idx
  ON public.note_learning_artifacts(workspace_id, user_id, note_id, request_id)
  WHERE request_id IS NOT NULL;

ALTER INDEX public.note_companion_artifacts_workspace_id_unique_idx RENAME TO note_learning_artifacts_workspace_id_unique_idx;
ALTER INDEX public.note_companion_artifacts_history_idx RENAME TO note_learning_artifacts_history_idx;

GRANT SELECT, INSERT ON public.note_learning_artifacts TO ailearn_worker;
