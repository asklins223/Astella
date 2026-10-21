-- 0446: controlled operation-question payloads for note learning cards (Plan 57).
--
-- Operation questions use trusted templates, not model-authored scripts: the model
-- supplies content + expected state, the host renders a fixed template, and the host
-- grades the returned state. Keeping the HTML here (not in note_learning_artifacts)
-- avoids reusing the dynamic-explainer table whose source_kind CHECK only allows
-- overview/annotation.

CREATE TABLE public.note_learning_card_operation_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  card_id uuid NOT NULL REFERENCES public.note_learning_cards(id) ON DELETE CASCADE,
  question_ordinal int NOT NULL,
  template text NOT NULL CHECK (template IN ('parameter_experiment', 'repair_steps')),
  spec jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
  html text NOT NULL CHECK (char_length(html) >= 1),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX note_learning_card_operation_artifacts_question_idx
  ON public.note_learning_card_operation_artifacts(card_id, question_ordinal);

ALTER TABLE public.note_learning_card_operation_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_learning_card_operation_artifacts FORCE ROW LEVEL SECURITY;

CREATE POLICY note_learning_card_operation_artifacts_worker_scope
  ON public.note_learning_card_operation_artifacts FOR ALL TO astella_worker
  USING (EXISTS (
    SELECT 1 FROM public.note_learning_cards c
    WHERE c.id = note_learning_card_operation_artifacts.card_id
      AND c.workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND EXISTS (
        SELECT 1 FROM public.workspace_members m
        WHERE m.workspace_id = c.workspace_id
          AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.note_learning_cards c
    WHERE c.id = note_learning_card_operation_artifacts.card_id
      AND c.workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND EXISTS (
        SELECT 1 FROM public.workspace_members m
        WHERE m.workspace_id = c.workspace_id
          AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      )
  ));

REVOKE ALL PRIVILEGES ON public.note_learning_card_operation_artifacts FROM PUBLIC, astella_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.note_learning_card_operation_artifacts TO astella_worker;
GRANT ALL PRIVILEGES ON public.note_learning_card_operation_artifacts TO astella_migrator;

COMMENT ON TABLE public.note_learning_card_operation_artifacts IS
  'Plan 57: trusted-template operation questions. The model fills spec; the host renders and grades — no model-authored scripts.';
