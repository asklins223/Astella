-- Private bookmarks of existing answers / teaching. No copied note body or review schedule.
CREATE TABLE public.note_learning_reflections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES public.notes(id) ON DELETE CASCADE,
  round_id uuid NOT NULL REFERENCES public.note_learning_rounds(id) ON DELETE CASCADE,
  teaching_id uuid REFERENCES public.note_learning_round_teachings(id) ON DELETE CASCADE,
  answer_artifact_id uuid REFERENCES public.learning_artifacts(id) ON DELETE CASCADE,
  annotation text NOT NULL DEFAULT '' CHECK (char_length(annotation) <= 4000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nlreflection_one_source CHECK ((teaching_id IS NOT NULL)::int + (answer_artifact_id IS NOT NULL)::int = 1)
);
CREATE UNIQUE INDEX nlreflection_teaching_unique ON public.note_learning_reflections(workspace_id,user_id,teaching_id);
CREATE UNIQUE INDEX nlreflection_answer_unique ON public.note_learning_reflections(workspace_id,user_id,answer_artifact_id);
CREATE INDEX nlreflection_note_idx ON public.note_learning_reflections(workspace_id,user_id,note_id,created_at,id);
--> statement-breakpoint
ALTER TABLE public.note_learning_reflections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_learning_reflections FORCE ROW LEVEL SECURITY;
CREATE POLICY nlreflection_owner ON public.note_learning_reflections FOR ALL TO PUBLIC
  USING (workspace_id = NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id = NULLIF(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id = NULLIF(current_setting('app.user_id',true),'')::uuid
    AND EXISTS (SELECT 1 FROM public.note_learning_rounds r
      WHERE r.id = round_id AND r.workspace_id = note_learning_reflections.workspace_id
        AND r.user_id = note_learning_reflections.user_id AND r.note_id = note_learning_reflections.note_id)
    AND ((teaching_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.note_learning_round_teachings t
      WHERE t.id = teaching_id AND t.round_id = note_learning_reflections.round_id))
    OR (answer_artifact_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.learning_artifacts a
      JOIN public.learning_runs r ON r.id = a.run_id
      WHERE a.id = answer_artifact_id AND a.user_id = note_learning_reflections.user_id
        AND a.workspace_id = note_learning_reflections.workspace_id AND a.status = 'locked'
        AND r.origin->>'kind' = 'note_round' AND r.origin->>'roundId' = note_learning_reflections.round_id::text))));
--> statement-breakpoint
CREATE FUNCTION public.guard_note_learning_reflection_update() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.id,NEW.workspace_id,NEW.user_id,NEW.note_id,NEW.round_id,NEW.teaching_id,NEW.answer_artifact_id,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.user_id,OLD.note_id,OLD.round_id,OLD.teaching_id,OLD.answer_artifact_id,OLD.created_at)
     OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'reflection source is immutable; annotation updates require next revision';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER nlreflection_update_guard BEFORE UPDATE ON public.note_learning_reflections
  FOR EACH ROW EXECUTE FUNCTION public.guard_note_learning_reflection_update();
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON public.note_learning_reflections TO astella_api;
GRANT ALL ON public.note_learning_reflections TO astella_migrator;
