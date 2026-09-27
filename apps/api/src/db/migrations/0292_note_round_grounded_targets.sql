-- Semantic reports can support an objective directly, without inventing a card candidate.
ALTER TABLE public.semantic_support_reports_v2 ALTER COLUMN candidate_revision_id DROP NOT NULL;
ALTER TABLE public.semantic_support_reports_v2 ADD COLUMN objective_revision_id uuid;
ALTER TABLE public.semantic_support_reports_v2 ADD CONSTRAINT ssr_subject_exactly_one
  CHECK ((candidate_revision_id IS NOT NULL)::int + (objective_revision_id IS NOT NULL)::int = 1);
ALTER TABLE public.semantic_support_reports_v2 ADD CONSTRAINT ssr_objective_revision_fk
  FOREIGN KEY (workspace_id, objective_revision_id)
  REFERENCES public.learning_objective_revisions_v2(workspace_id, objective_revision_id);
--> statement-breakpoint
CREATE TABLE public.note_learning_round_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  round_id uuid NOT NULL REFERENCES public.note_learning_rounds(id) ON DELETE CASCADE,
  driving_question_revision integer NOT NULL CHECK (driving_question_revision >= 1),
  objective_id uuid NOT NULL,
  objective_revision_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, driving_question_revision),
  FOREIGN KEY (workspace_id, objective_revision_id)
    REFERENCES public.learning_objective_revisions_v2(workspace_id, objective_revision_id)
);
--> statement-breakpoint
ALTER TABLE public.note_learning_round_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_learning_round_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY nlrtarget_owner ON public.note_learning_round_targets FOR ALL TO PUBLIC
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
CREATE FUNCTION public.prevent_note_learning_round_target_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.note_learning_rounds WHERE id = OLD.round_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'note_learning_round_targets is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER nlrtarget_append_only BEFORE UPDATE OR DELETE ON public.note_learning_round_targets
  FOR EACH ROW EXECUTE FUNCTION public.prevent_note_learning_round_target_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT ON public.note_learning_round_targets TO ailearn_api;
GRANT ALL ON public.note_learning_round_targets TO ailearn_migrator;
