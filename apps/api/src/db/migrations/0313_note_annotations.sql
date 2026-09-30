-- Private, source-anchored explanations attached to an exact immutable note version.
CREATE TABLE public.note_annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES public.notes(id) ON DELETE CASCADE,
  note_version_id uuid NOT NULL,
  start_block_ordinal integer NOT NULL CHECK (start_block_ordinal >= 0),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_block_ordinal integer NOT NULL CHECK (end_block_ordinal >= start_block_ordinal),
  end_offset integer NOT NULL CHECK (end_offset >= 0),
  excerpt text NOT NULL CHECK (char_length(excerpt) BETWEEN 1 AND 2000),
  prefix text NOT NULL DEFAULT '' CHECK (char_length(prefix) <= 120),
  suffix text NOT NULL DEFAULT '' CHECK (char_length(suffix) <= 120),
  explanation text NOT NULL CHECK (char_length(explanation) <= 8000),
  source_message_id text CHECK (char_length(source_message_id) <= 160),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT note_annotations_version_note_fk
    FOREIGN KEY (workspace_id, note_id, note_version_id)
    REFERENCES public.note_versions(workspace_id, note_id, id) ON DELETE CASCADE,
  CONSTRAINT note_annotations_source_range_check
    CHECK (end_block_ordinal > start_block_ordinal OR end_offset > start_offset)
);
CREATE INDEX note_annotations_note_version_idx
  ON public.note_annotations(workspace_id, user_id, note_id, note_version_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX note_annotations_workspace_id_unique_idx
  ON public.note_annotations(workspace_id, id);
CREATE UNIQUE INDEX note_annotations_source_message_unique_idx
  ON public.note_annotations(workspace_id, user_id, note_id, source_message_id)
  WHERE source_message_id IS NOT NULL;

ALTER TABLE public.note_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_annotations FORCE ROW LEVEL SECURITY;
CREATE POLICY note_annotations_owner ON public.note_annotations FOR ALL TO PUBLIC
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.notes visible_note
      WHERE visible_note.id = note_annotations.note_id
        AND visible_note.workspace_id = note_annotations.workspace_id
        AND visible_note.deleted_at IS NULL
        AND (visible_note.share_scope = 'shared' OR visible_note.created_by = note_annotations.user_id)
    ))
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.notes visible_note
      WHERE visible_note.id = note_annotations.note_id
        AND visible_note.workspace_id = note_annotations.workspace_id
        AND visible_note.deleted_at IS NULL
        AND (visible_note.share_scope = 'shared' OR visible_note.created_by = note_annotations.user_id)
    ));

CREATE FUNCTION public.guard_note_annotation_update() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.id, NEW.workspace_id, NEW.user_id, NEW.note_id, NEW.note_version_id,
         NEW.start_block_ordinal, NEW.start_offset, NEW.end_block_ordinal, NEW.end_offset,
         NEW.excerpt, NEW.prefix, NEW.suffix, NEW.source_message_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.workspace_id, OLD.user_id, OLD.note_id, OLD.note_version_id,
         OLD.start_block_ordinal, OLD.start_offset, OLD.end_block_ordinal, OLD.end_offset,
         OLD.excerpt, OLD.prefix, OLD.suffix, OLD.source_message_id, OLD.created_at)
     OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'note annotation source is immutable; explanation updates require next revision';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER note_annotations_update_guard BEFORE UPDATE ON public.note_annotations
  FOR EACH ROW EXECUTE FUNCTION public.guard_note_annotation_update();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.note_annotations TO ailearn_api;
GRANT ALL PRIVILEGES ON public.note_annotations TO ailearn_migrator;
