-- A selected passage can become a durable explanation without a companion chat reply.
ALTER TABLE public.note_annotations
  ADD COLUMN generation_job_id uuid,
  ADD CONSTRAINT note_annotations_generation_job_workspace_fk
    FOREIGN KEY (generation_job_id, workspace_id)
    REFERENCES public.jobs(id, workspace_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX note_annotations_generation_job_unique_idx
  ON public.note_annotations(workspace_id, generation_job_id)
  WHERE generation_job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.guard_note_annotation_update() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.id, NEW.workspace_id, NEW.user_id, NEW.note_id, NEW.note_version_id,
         NEW.start_block_ordinal, NEW.start_offset, NEW.end_block_ordinal, NEW.end_offset,
         NEW.excerpt, NEW.prefix, NEW.suffix, NEW.source_message_id, NEW.generation_job_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.workspace_id, OLD.user_id, OLD.note_id, OLD.note_version_id,
         OLD.start_block_ordinal, OLD.start_offset, OLD.end_block_ordinal, OLD.end_offset,
         OLD.excerpt, OLD.prefix, OLD.suffix, OLD.source_message_id, OLD.generation_job_id, OLD.created_at)
     OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'note annotation source is immutable; explanation updates require next revision';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

GRANT SELECT, INSERT ON public.note_annotations TO astella_worker;
