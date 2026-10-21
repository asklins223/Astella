DROP POLICY IF EXISTS note_learning_cards_worker_scope ON public.note_learning_cards;
CREATE POLICY note_learning_cards_worker_scope ON public.note_learning_cards FOR ALL TO PUBLIC
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS note_learning_card_questions_worker_scope ON public.note_learning_card_questions;
CREATE POLICY note_learning_card_questions_worker_scope ON public.note_learning_card_questions FOR ALL TO PUBLIC
  USING (EXISTS (SELECT 1 FROM public.note_learning_cards c WHERE c.id = note_learning_card_questions.card_id AND c.workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM public.note_learning_cards c WHERE c.id = note_learning_card_questions.card_id AND c.workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid));

DROP POLICY IF EXISTS note_learning_card_attempts_worker_scope ON public.note_learning_card_attempts;
CREATE POLICY note_learning_card_attempts_worker_scope ON public.note_learning_card_attempts FOR ALL TO PUBLIC
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

DROP POLICY IF EXISTS note_learning_card_answers_worker_scope ON public.note_learning_card_answers;
CREATE POLICY note_learning_card_answers_worker_scope ON public.note_learning_card_answers FOR ALL TO PUBLIC
  USING (EXISTS (SELECT 1 FROM public.note_learning_card_attempts a WHERE a.id = note_learning_card_answers.attempt_id AND a.workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid AND a.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM public.note_learning_card_attempts a WHERE a.id = note_learning_card_answers.attempt_id AND a.workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid AND a.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid));

DROP POLICY IF EXISTS note_learning_card_operation_artifacts_worker_scope ON public.note_learning_card_operation_artifacts;
CREATE POLICY note_learning_card_operation_artifacts_worker_scope ON public.note_learning_card_operation_artifacts FOR ALL TO PUBLIC
  USING (EXISTS (SELECT 1 FROM public.note_learning_cards c WHERE c.id = note_learning_card_operation_artifacts.card_id AND c.workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM public.note_learning_cards c WHERE c.id = note_learning_card_operation_artifacts.card_id AND c.workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid));
