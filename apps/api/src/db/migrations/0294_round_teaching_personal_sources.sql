-- Freeze private learner context only when the user explicitly selects it for a teaching.
ALTER TABLE public.note_learning_round_teachings
  ADD COLUMN personal_source_snapshots jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE public.note_learning_round_teachings
  ADD CONSTRAINT nlrt_personal_sources_chk
  CHECK (jsonb_typeof(personal_source_snapshots) = 'array' AND jsonb_array_length(personal_source_snapshots) <= 3);
