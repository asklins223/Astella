CREATE TABLE public.note_mind_maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES public.notes(id) ON DELETE CASCADE,
  note_version_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  content_hash text NOT NULL,
  content jsonb NOT NULL CHECK (jsonb_typeof(content->'nodes')='array' AND jsonb_array_length(content->'nodes') BETWEEN 2 AND 120),
  coverage jsonb NOT NULL,
  generation_job_id uuid NOT NULL,
  model_id text NOT NULL, prompt_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT note_mind_maps_version_note_fk FOREIGN KEY (workspace_id,note_id,note_version_id)
    REFERENCES public.note_versions(workspace_id,note_id,id) ON DELETE CASCADE,
  CONSTRAINT note_mind_maps_job_workspace_fk FOREIGN KEY (generation_job_id,workspace_id)
    REFERENCES public.jobs(id,workspace_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX note_mind_maps_job_unique_idx ON public.note_mind_maps(workspace_id,generation_job_id);
CREATE INDEX note_mind_maps_created_idx ON public.note_mind_maps(workspace_id,user_id,note_id,created_at DESC,id DESC);
ALTER TABLE public.note_mind_maps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_mind_maps FORCE ROW LEVEL SECURITY;
CREATE POLICY note_mind_maps_owner ON public.note_mind_maps FOR ALL TO PUBLIC
  USING (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid
    AND EXISTS (SELECT 1 FROM public.notes n WHERE n.id=note_mind_maps.note_id AND n.workspace_id=note_mind_maps.workspace_id
      AND n.deleted_at IS NULL AND (n.share_scope='shared' OR n.created_by=note_mind_maps.user_id)))
  WITH CHECK (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid
    AND EXISTS (SELECT 1 FROM public.notes n WHERE n.id=note_mind_maps.note_id AND n.workspace_id=note_mind_maps.workspace_id
      AND n.deleted_at IS NULL AND (n.share_scope='shared' OR n.created_by=note_mind_maps.user_id)));
GRANT SELECT ON public.note_mind_maps TO astella_api;
GRANT SELECT,INSERT ON public.note_mind_maps TO astella_worker;
GRANT ALL ON public.note_mind_maps TO astella_migrator;

CREATE TABLE public.note_mind_map_stages (
  job_id uuid NOT NULL,workspace_id uuid NOT NULL,user_id uuid NOT NULL,
  stage text NOT NULL,input_hash text NOT NULL,output jsonb NOT NULL,
  CONSTRAINT note_mind_map_stages_key UNIQUE(job_id,stage,input_hash),
  FOREIGN KEY(job_id,workspace_id) REFERENCES public.jobs(id,workspace_id) ON DELETE CASCADE
);
ALTER TABLE public.note_mind_map_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_mind_map_stages FORCE ROW LEVEL SECURITY;
CREATE POLICY note_mind_map_stages_actor ON public.note_mind_map_stages FOR ALL TO PUBLIC
  USING (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id=note_mind_map_stages.job_id AND j.workspace_id=note_mind_map_stages.workspace_id AND j.requested_by=note_mind_map_stages.user_id AND j.type='note_mind_map_generate'))
  WITH CHECK (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id=note_mind_map_stages.job_id AND j.workspace_id=note_mind_map_stages.workspace_id AND j.requested_by=note_mind_map_stages.user_id AND j.type='note_mind_map_generate'));
GRANT SELECT,INSERT ON public.note_mind_map_stages TO astella_worker;
GRANT ALL ON public.note_mind_map_stages TO astella_migrator;
