ALTER TABLE public.assistant_memory_items
  ADD COLUMN revision integer NOT NULL DEFAULT 1,
  ADD COLUMN author_type text NOT NULL DEFAULT 'model',
  ADD COLUMN author_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN epistemic_status text NOT NULL DEFAULT 'tentative';

--> statement-breakpoint

UPDATE public.assistant_memory_items
   SET author_type = CASE
     WHEN source_type = 'user_stated' THEN 'user'
     WHEN source_type = 'summary' THEN 'background'
     ELSE 'model'
   END,
       author_id = CASE
         WHEN source_type = 'user_stated' THEN user_id
         ELSE NULL
       END,
       epistemic_status = CASE
         WHEN user_stated OR user_confirmed THEN 'supported'
         ELSE 'tentative'
       END;

--> statement-breakpoint

ALTER TABLE public.assistant_memory_items
  ADD CONSTRAINT assistant_memory_items_revision_positive CHECK (revision >= 1),
  ADD CONSTRAINT assistant_memory_items_author_type_check CHECK (author_type IN ('user', 'model', 'background')),
  ADD CONSTRAINT assistant_memory_items_epistemic_status_check CHECK (
    epistemic_status IN ('supported', 'tentative', 'disputed')
  );

--> statement-breakpoint

CREATE TABLE public.assistant_memory_item_revisions (
  memory_id uuid NOT NULL REFERENCES public.assistant_memory_items(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  kind text NOT NULL,
  content text NOT NULL,
  source_event_id text,
  source_session_id uuid,
  user_stated boolean NOT NULL,
  user_confirmed boolean NOT NULL,
  importance real NOT NULL,
  confidence real NOT NULL,
  scope text NOT NULL,
  source_type text NOT NULL,
  author_type text NOT NULL CHECK (author_type IN ('user', 'model', 'background')),
  author_id uuid,
  epistemic_status text NOT NULL CHECK (epistemic_status IN ('supported', 'tentative', 'disputed')),
  superseded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, revision)
);

--> statement-breakpoint

CREATE INDEX assistant_memory_item_revisions_owner_idx
  ON public.assistant_memory_item_revisions (workspace_id, user_id, memory_id, revision DESC);

--> statement-breakpoint

CREATE FUNCTION public.prepare_assistant_memory_item_authorship()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.source_type = 'user_stated' OR NEW.user_stated THEN
    NEW.author_type := 'user';
    NEW.author_id := NEW.user_id;
    NEW.epistemic_status := 'supported';
  ELSIF NEW.source_type = 'summary' THEN
    NEW.author_type := 'background';
    NEW.author_id := NULL;
  END IF;
  RETURN NEW;
END
$$;

--> statement-breakpoint

CREATE TRIGGER assistant_memory_items_prepare_authorship
  BEFORE INSERT ON public.assistant_memory_items
  FOR EACH ROW EXECUTE FUNCTION public.prepare_assistant_memory_item_authorship();

--> statement-breakpoint

ALTER TABLE public.assistant_memory_item_revisions ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.assistant_memory_item_revisions FORCE ROW LEVEL SECURITY;

--> statement-breakpoint
CREATE POLICY assistant_memory_item_revisions_workspace_user_isolation
  ON public.assistant_memory_item_revisions FOR ALL
  USING (
    CURRENT_USER = 'astella_worker'
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    CURRENT_USER = 'astella_worker'
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

--> statement-breakpoint

GRANT SELECT, INSERT ON public.assistant_memory_item_revisions TO astella_api, astella_worker;

--> statement-breakpoint

REVOKE UPDATE, DELETE, TRUNCATE ON public.assistant_memory_item_revisions FROM astella_api, astella_worker;

--> statement-breakpoint

CREATE FUNCTION public.capture_assistant_memory_item_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF ROW(
    NEW.kind,
    NEW.content,
    NEW.source_event_id,
    NEW.source_session_id,
    NEW.user_stated,
    NEW.user_confirmed,
    NEW.importance,
    NEW.confidence,
    NEW.scope,
    NEW.source_type,
    NEW.author_type,
    NEW.author_id,
    NEW.epistemic_status
  ) IS DISTINCT FROM ROW(
    OLD.kind,
    OLD.content,
    OLD.source_event_id,
    OLD.source_session_id,
    OLD.user_stated,
    OLD.user_confirmed,
    OLD.importance,
    OLD.confidence,
    OLD.scope,
    OLD.source_type,
    OLD.author_type,
    OLD.author_id,
    OLD.epistemic_status
  ) THEN
    INSERT INTO public.assistant_memory_item_revisions (
      memory_id,
      workspace_id,
      user_id,
      revision,
      kind,
      content,
      source_event_id,
      source_session_id,
      user_stated,
      user_confirmed,
      importance,
      confidence,
      scope,
      source_type,
      author_type,
      author_id,
      epistemic_status
    ) VALUES (
      OLD.id,
      OLD.workspace_id,
      OLD.user_id,
      OLD.revision,
      OLD.kind,
      OLD.content,
      OLD.source_event_id,
      OLD.source_session_id,
      OLD.user_stated,
      OLD.user_confirmed,
      OLD.importance,
      OLD.confidence,
      OLD.scope,
      OLD.source_type,
      OLD.author_type,
      OLD.author_id,
      OLD.epistemic_status
    );
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END
$$;

--> statement-breakpoint

CREATE TRIGGER assistant_memory_items_capture_revision
  BEFORE UPDATE ON public.assistant_memory_items
  FOR EACH ROW EXECUTE FUNCTION public.capture_assistant_memory_item_revision();
