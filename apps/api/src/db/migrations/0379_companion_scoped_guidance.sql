-- 43: account recognition and each workspace's recognition have distinct identities.
ALTER TABLE public.user_companion_onboarding
  ADD COLUMN scope_key text NOT NULL DEFAULT 'account',
  ADD COLUMN workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ADD COLUMN visited_step_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.user_companion_onboarding ADD CONSTRAINT companion_guidance_scope_check
  CHECK ((scope_key = 'account' AND workspace_id IS NULL)
    OR (workspace_id IS NOT NULL AND scope_key = workspace_id::text));
ALTER TABLE public.user_companion_onboarding ADD CONSTRAINT companion_guidance_steps_check
  CHECK (jsonb_typeof(visited_step_ids) = 'array' AND jsonb_array_length(visited_step_ids) <= 100);
DROP INDEX public.user_companion_onboarding_user_version_unique_idx;
CREATE UNIQUE INDEX user_companion_onboarding_user_version_unique_idx
  ON public.user_companion_onboarding(user_id, onboarding_version, scope_key);
DROP POLICY user_companion_onboarding_user_isolation ON public.user_companion_onboarding;
CREATE POLICY user_companion_onboarding_user_isolation ON public.user_companion_onboarding FOR ALL
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid))
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid));
