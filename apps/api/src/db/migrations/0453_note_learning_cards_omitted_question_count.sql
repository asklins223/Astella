-- 0453: report questions discarded after validation on a note learning card (Plan 57).
--
-- Plan 57 §3.3 / §7.3: a generation attempt is retried once; questions that still
-- fail validation are discarded and the card reports “有 N 道题未通过校验，没有收录”.
-- The whole card only fails when fewer than 4 valid questions remain. The worker
-- writes this count when it inserts the surviving questions, and the card read
-- route exposes it additively.
--
-- Existing rows have no recorded omissions, so the default 0 is accurate for them.

ALTER TABLE public.note_learning_cards
  ADD COLUMN omitted_question_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.note_learning_cards
  ADD CONSTRAINT note_learning_cards_omitted_question_count_check
  CHECK (omitted_question_count >= 0);

COMMENT ON COLUMN public.note_learning_cards.omitted_question_count IS
  'Plan 57: generated questions dropped after validation (including duplicates); 0 means every generated question was kept.';
