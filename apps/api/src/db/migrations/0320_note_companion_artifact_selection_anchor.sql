-- Keep local teaching artifacts attached to the exact immutable note passage they explain.
ALTER TABLE public.note_companion_artifacts
  ADD COLUMN selection_anchor jsonb;

ALTER TABLE public.note_companion_artifacts
  ADD CONSTRAINT note_companion_artifacts_selection_anchor_shape_check
    CHECK (selection_anchor IS NULL OR jsonb_typeof(selection_anchor) = 'object'),
  ADD CONSTRAINT note_companion_artifacts_overview_selection_check
    CHECK (source_kind <> 'overview' OR selection_anchor IS NULL);
