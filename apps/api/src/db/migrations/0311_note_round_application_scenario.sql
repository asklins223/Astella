-- A source-grounded, independently checked new context is frozen with the
-- question's target. Append-only target rows keep old task settings auditable.
ALTER TABLE public.note_learning_round_targets
  ADD COLUMN application_scenario text;
--> statement-breakpoint

ALTER TABLE public.note_learning_round_targets
  ADD CONSTRAINT nlrtarget_application_scenario_len_chk
  CHECK (application_scenario IS NULL OR char_length(application_scenario) BETWEEN 10 AND 600);
