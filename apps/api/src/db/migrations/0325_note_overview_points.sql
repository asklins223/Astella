-- Keep each short takeaway paired with the exact passage it came from.
-- Earlier companion replies and generated overviews retain their original body.
ALTER TABLE public.note_overviews
  ADD COLUMN overview_points jsonb,
  ADD CONSTRAINT note_overviews_overview_points_shape_check
    CHECK (overview_points IS NULL OR (
      jsonb_typeof(overview_points) = 'array'
      AND jsonb_array_length(overview_points) BETWEEN 1 AND 6
    ));
