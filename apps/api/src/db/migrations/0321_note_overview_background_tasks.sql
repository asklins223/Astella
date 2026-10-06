-- Decouple saved note overviews from companion chat messages. A worker job is
-- the durable source for newly generated results; old chat-linked rows remain traceable.
ALTER TABLE public.note_overviews
  ALTER COLUMN source_message_id DROP NOT NULL,
  ALTER COLUMN conversation_id DROP NOT NULL,
  ADD COLUMN generation_job_id uuid,
  ADD COLUMN coverage jsonb,
  ADD CONSTRAINT note_overviews_source_pair_check
    CHECK ((source_message_id IS NULL) = (conversation_id IS NULL)),
  ADD CONSTRAINT note_overviews_has_origin_check
    CHECK (generation_job_id IS NOT NULL OR source_message_id IS NOT NULL),
  ADD CONSTRAINT note_overviews_generation_job_workspace_fk
    FOREIGN KEY (generation_job_id, workspace_id)
    REFERENCES public.jobs(id, workspace_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX note_overviews_generation_job_unique_idx
  ON public.note_overviews(workspace_id, generation_job_id)
  WHERE generation_job_id IS NOT NULL;

ALTER TABLE public.note_overviews
  DROP CONSTRAINT note_overviews_source_references_shape_check,
  ADD CONSTRAINT note_overviews_source_references_shape_check
    CHECK (jsonb_typeof(source_references) = 'array' AND jsonb_array_length(source_references) <= 32);

GRANT SELECT, INSERT ON public.note_overviews TO astella_worker;
