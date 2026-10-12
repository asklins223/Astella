-- Generated explanations follow their material and model profile. Keep nonempty
-- documents, while removing historical content quotas from both storage paths.
ALTER TABLE public.note_learning_artifacts
  DROP CONSTRAINT note_learning_artifacts_html_length_check,
  ADD CONSTRAINT note_learning_artifacts_html_length_check CHECK (char_length(html) >= 1);

--> statement-breakpoint
ALTER TABLE public.note_learning_round_artifacts
  DROP CONSTRAINT nlra_html_len_chk,
  ADD CONSTRAINT nlra_html_len_chk CHECK (char_length(html) >= 1);
