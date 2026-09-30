-- Store only quotations that can be matched against the immutable note version.
-- The page uses these exact block identities for a reliable jump back to source.
ALTER TABLE public.note_overviews
  ADD COLUMN source_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT note_overviews_source_references_shape_check
    CHECK (jsonb_typeof(source_references) = 'array' AND jsonb_array_length(source_references) <= 8);
