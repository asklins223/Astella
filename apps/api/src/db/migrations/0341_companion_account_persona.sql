-- 0341: separate cross-space account persona from workspace-local relationship state.

CREATE TABLE public.companion_persona_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  profile jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_persona_profiles_profile_shape_check CHECK (
    profile IS NULL OR (
      jsonb_typeof(profile) = 'object'
      AND profile ?& ARRAY['presetId', 'name', 'personalityTags', 'speakingStyle', 'examples', 'activeness', 'boundaries']
    )
  )
);

--> statement-breakpoint

CREATE UNIQUE INDEX companion_persona_profiles_user_unique
  ON public.companion_persona_profiles (user_id);

--> statement-breakpoint

CREATE TABLE public.companion_persona_profile_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  examples_revision integer NOT NULL CHECK (examples_revision > 0),
  author text NOT NULL CHECK (author IN ('user', 'assistant_tool', 'restore', 'migration')),
  action text NOT NULL CHECK (action IN ('update', 'reset', 'restore', 'migration')),
  reason text,
  module_scope text[] NOT NULL DEFAULT ARRAY['companion']::text[],
  source_workspace_id uuid,
  profile jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_persona_profile_versions_user_revision_unique UNIQUE (user_id, revision),
  CONSTRAINT companion_persona_profile_versions_profile_shape_check CHECK (
    profile IS NULL OR (
      jsonb_typeof(profile) = 'object'
      AND profile ?& ARRAY['presetId', 'name', 'personalityTags', 'speakingStyle', 'examples', 'activeness', 'boundaries']
    )
  ),
  CONSTRAINT companion_persona_profile_versions_action_shape_check CHECK (
    (profile IS NOT NULL OR action IN ('reset', 'restore'))
    AND (action <> 'reset' OR profile IS NULL)
  )
);

--> statement-breakpoint

CREATE INDEX companion_persona_profile_versions_user_created_idx
  ON public.companion_persona_profile_versions (user_id, created_at DESC, revision DESC);

--> statement-breakpoint

-- Each old workspace-local profile is preserved as a private version. If a user's
-- old spaces disagree, the most recently updated row becomes the account profile;
-- every prior variant remains recoverable from this owner-only history.
WITH legacy_profiles AS (
  SELECT
    p.*,
    row_number() OVER (PARTITION BY p.user_id ORDER BY p.updated_at, p.workspace_id)::integer AS migrated_revision,
    jsonb_build_object(
      'presetId', p.preset_id,
      'name', p.name,
      'personalityTags', p.personality_tags,
      'speakingStyle', p.speaking_style,
      'examples', p.examples,
      'activeness', p.activeness,
      'boundaries', p.boundaries
    ) AS persona
  FROM public.pet_profiles AS p
)
INSERT INTO public.companion_persona_profile_versions (
  user_id, revision, examples_revision, author, action, reason,
  source_workspace_id, profile, created_at
)
SELECT user_id, migrated_revision, migrated_revision, 'migration', 'migration',
       'Imported from a workspace-scoped persona profile.', workspace_id, persona, updated_at
FROM legacy_profiles
ON CONFLICT (user_id, revision) DO NOTHING;

--> statement-breakpoint

WITH latest_profile AS (
  SELECT DISTINCT ON (p.user_id)
    p.user_id,
    p.updated_at,
    jsonb_build_object(
      'presetId', p.preset_id,
      'name', p.name,
      'personalityTags', p.personality_tags,
      'speakingStyle', p.speaking_style,
      'examples', p.examples,
      'activeness', p.activeness,
      'boundaries', p.boundaries
    ) AS persona,
    (SELECT count(*)::integer FROM public.pet_profiles q WHERE q.user_id = p.user_id) AS final_revision
  FROM public.pet_profiles AS p
  ORDER BY p.user_id, p.updated_at DESC, p.workspace_id ASC
)
INSERT INTO public.companion_persona_profiles (user_id, revision, profile, created_at, updated_at)
SELECT user_id, final_revision, persona, updated_at, updated_at
FROM latest_profile
ON CONFLICT (user_id) DO NOTHING;

--> statement-breakpoint

ALTER TABLE public.companion_persona_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_persona_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY companion_persona_profiles_user_isolation
  ON public.companion_persona_profiles FOR ALL
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE public.companion_persona_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_persona_profile_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY companion_persona_profile_versions_user_isolation
  ON public.companion_persona_profile_versions FOR ALL
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

--> statement-breakpoint

-- Workspace relationship state remains workspace+user isolated even for workers.
DROP POLICY IF EXISTS pet_profiles_workspace_user_isolation ON public.pet_profiles;
CREATE POLICY pet_profiles_workspace_user_isolation
  ON public.pet_profiles FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

ALTER TABLE public.pet_profiles
  DROP COLUMN IF EXISTS preset_id,
  DROP COLUMN IF EXISTS name,
  DROP COLUMN IF EXISTS personality_tags,
  DROP COLUMN IF EXISTS speaking_style,
  DROP COLUMN IF EXISTS examples,
  DROP COLUMN IF EXISTS activeness,
  DROP COLUMN IF EXISTS boundaries,
  DROP COLUMN IF EXISTS revision;

--> statement-breakpoint

ALTER TABLE public.companion_turn_runs
  ADD COLUMN persona_profile_revision integer,
  ADD COLUMN persona_examples_revision integer,
  ADD COLUMN default_expression_version text;

ALTER TABLE public.companion_diary_generation_checkpoints
  ADD COLUMN persona_profile_revision integer,
  ADD COLUMN persona_examples_revision integer,
  ADD COLUMN default_expression_version text;

ALTER TABLE public.companion_daily_summaries
  ADD COLUMN persona_profile_revision integer,
  ADD COLUMN persona_examples_revision integer,
  ADD COLUMN default_expression_version text;

ALTER TABLE public.assistant_thoughts
  ADD COLUMN persona_profile_revision integer,
  ADD COLUMN persona_examples_revision integer,
  ADD COLUMN default_expression_version text,
  ADD CONSTRAINT assistant_thoughts_persona_revision_shape_check CHECK (
    (persona_profile_revision IS NULL AND persona_examples_revision IS NULL AND default_expression_version IS NULL)
    OR (
      persona_profile_revision >= 0
      AND persona_examples_revision >= 0
      AND nullif(default_expression_version, '') IS NOT NULL
    )
  );

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_persona_profiles TO ailearn_api;
GRANT SELECT, INSERT ON public.companion_persona_profile_versions TO ailearn_api;
GRANT SELECT, INSERT, UPDATE ON public.companion_persona_profiles TO ailearn_worker;
GRANT SELECT, INSERT ON public.companion_persona_profile_versions TO ailearn_worker;
GRANT SELECT, INSERT, UPDATE ON public.pet_profiles TO ailearn_worker;
