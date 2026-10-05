-- Intent remains in confirmed workspace goal memory; runs bind its exact version.
ALTER TABLE public.agent_runs ADD COLUMN long_goal_ref jsonb;
ALTER TABLE public.agent_run_revisions ADD COLUMN long_goal_ref jsonb;
ALTER TABLE public.agent_runs ADD CONSTRAINT agent_runs_long_goal_shape CHECK(
  long_goal_ref IS NULL OR (jsonb_typeof(long_goal_ref)='object'
    AND long_goal_ref ?& ARRAY['memoryId','revision']
    AND long_goal_ref-ARRAY['memoryId','revision']='{}'::jsonb
    AND long_goal_ref->>'memoryId' ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    AND jsonb_typeof(long_goal_ref->'revision')='number'
    AND (long_goal_ref->>'revision')::numeric BETWEEN 1 AND 2147483647
    AND trunc((long_goal_ref->>'revision')::numeric)=(long_goal_ref->>'revision')::numeric));
