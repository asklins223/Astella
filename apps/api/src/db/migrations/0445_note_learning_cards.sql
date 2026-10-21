-- 0445: note-scoped learning cards (Plan 57, 2026-10-19).
--
-- One note + one saved version owns one card; a card owns 4–8 questions, each with
-- exactly one fixed type and its own grounding. Design decisions and the product
-- contract live in docs/plans/learning-companion/57-learning-card-and-review-reset-2026-10-19.md.
--
-- The old objective/card/review tables are intentionally NOT referenced here: this is a
-- clean chain, not a compatibility layer. `note_learning_artifacts` is still used for
-- operation-question HTML (owner kind `card_question` is added by the API, not by a FK here).

CREATE TABLE public.note_learning_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES public.notes(id) ON DELETE CASCADE,
  note_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'stale', 'archived')),
  generated_from_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX note_learning_cards_version_idx
  ON public.note_learning_cards(workspace_id, note_id, note_version_id);

CREATE UNIQUE INDEX note_learning_cards_active_idx
  ON public.note_learning_cards(workspace_id, note_id)
  WHERE status = 'active';

CREATE INDEX note_learning_cards_note_idx
  ON public.note_learning_cards(workspace_id, note_id, updated_at DESC);

ALTER TABLE public.note_learning_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_learning_cards FORCE ROW LEVEL SECURITY;

CREATE POLICY note_learning_cards_worker_scope
  ON public.note_learning_cards FOR ALL TO astella_worker
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.workspace_members m
      WHERE m.workspace_id = note_learning_cards.workspace_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.workspace_members m
      WHERE m.workspace_id = note_learning_cards.workspace_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

REVOKE ALL PRIVILEGES ON public.note_learning_cards FROM PUBLIC, astella_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.note_learning_cards TO astella_worker;
GRANT ALL PRIVILEGES ON public.note_learning_cards TO astella_migrator;

CREATE TABLE public.note_learning_card_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES public.note_learning_cards(id) ON DELETE CASCADE,
  ordinal int NOT NULL CHECK (ordinal BETWEEN 0 AND 7),
  question_type text NOT NULL
    CHECK (question_type IN (
      'single_choice', 'multi_choice', 'true_false', 'fill_blank',
      'short_answer', 'ordering', 'matching', 'operation'
    )),
  stem text NOT NULL CHECK (char_length(stem) BETWEEN 4 AND 2000),
  options jsonb,
  answer jsonb,
  rubric jsonb,
  grounding jsonb NOT NULL CHECK (jsonb_typeof(grounding) = 'object'),
  operation_artifact_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX note_learning_card_questions_ordinal_idx
  ON public.note_learning_card_questions(card_id, ordinal);

ALTER TABLE public.note_learning_card_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_learning_card_questions FORCE ROW LEVEL SECURITY;

CREATE POLICY note_learning_card_questions_worker_scope
  ON public.note_learning_card_questions FOR ALL TO astella_worker
  USING (EXISTS (
    SELECT 1 FROM public.note_learning_cards c
    WHERE c.id = note_learning_card_questions.card_id
      AND c.workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND EXISTS (
        SELECT 1 FROM public.workspace_members m
        WHERE m.workspace_id = c.workspace_id
          AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.note_learning_cards c
    WHERE c.id = note_learning_card_questions.card_id
      AND c.workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND EXISTS (
        SELECT 1 FROM public.workspace_members m
        WHERE m.workspace_id = c.workspace_id
          AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      )
  ));

REVOKE ALL PRIVILEGES ON public.note_learning_card_questions FROM PUBLIC, astella_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.note_learning_card_questions TO astella_worker;
GRANT ALL PRIVILEGES ON public.note_learning_card_questions TO astella_migrator;

CREATE TABLE public.note_learning_card_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES public.note_learning_cards(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'grading', 'completed', 'grading_failed', 'abandoned')),
  score int CHECK (score BETWEEN 0 AND 100),
  stars int CHECK (stars BETWEEN 0 AND 5),
  summary jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX note_learning_card_attempts_card_idx
  ON public.note_learning_card_attempts(card_id, user_id, completed_at DESC);

CREATE INDEX note_learning_card_attempts_scope_idx
  ON public.note_learning_card_attempts(workspace_id, user_id, started_at DESC);

ALTER TABLE public.note_learning_card_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_learning_card_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY note_learning_card_attempts_worker_scope
  ON public.note_learning_card_attempts FOR ALL TO astella_worker
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

REVOKE ALL PRIVILEGES ON public.note_learning_card_attempts FROM PUBLIC, astella_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.note_learning_card_attempts TO astella_worker;
GRANT ALL PRIVILEGES ON public.note_learning_card_attempts TO astella_migrator;

CREATE TABLE public.note_learning_card_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES public.note_learning_card_attempts(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES public.note_learning_card_questions(id) ON DELETE CASCADE,
  answer jsonb NOT NULL,
  score int CHECK (score BETWEEN 0 AND 100),
  feedback jsonb,
  grounding_snapshot jsonb NOT NULL CHECK (jsonb_typeof(grounding_snapshot) = 'object'),
  used_hint boolean NOT NULL DEFAULT false,
  graded_at timestamptz
);

CREATE UNIQUE INDEX note_learning_card_answers_question_idx
  ON public.note_learning_card_answers(attempt_id, question_id);

ALTER TABLE public.note_learning_card_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_learning_card_answers FORCE ROW LEVEL SECURITY;

CREATE POLICY note_learning_card_answers_worker_scope
  ON public.note_learning_card_answers FOR ALL TO astella_worker
  USING (EXISTS (
    SELECT 1 FROM public.note_learning_card_attempts a
    WHERE a.id = note_learning_card_answers.attempt_id
      AND a.workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND a.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.note_learning_card_attempts a
    WHERE a.id = note_learning_card_answers.attempt_id
      AND a.workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND a.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  ));

REVOKE ALL PRIVILEGES ON public.note_learning_card_answers FROM PUBLIC, astella_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.note_learning_card_answers TO astella_worker;
GRANT ALL PRIVILEGES ON public.note_learning_card_answers TO astella_migrator;

COMMENT ON TABLE public.note_learning_cards IS
  'Plan 57: one note version owns one learning card. Questions are fixed-type and grounded; no review/objective/card-library linkage.';
COMMENT ON TABLE public.note_learning_card_questions IS
  'Card questions: one fixed type, an explicit stem, and grounding (note quotes + optional extension passage).';
COMMENT ON TABLE public.note_learning_card_attempts IS
  'One complete answer to a card. Best score/stars are aggregated from completed attempts; summary is the overall evaluation.';
COMMENT ON TABLE public.note_learning_card_answers IS
  'Per-question answer, score, feedback, and the grounding snapshot used for grading.';
