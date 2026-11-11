-- Usage is not a content revision: the history trigger snapshots only when
-- revision changes, so touching last_used_at does not create a version.
ALTER TABLE public.companion_self_notes ADD COLUMN last_used_at timestamptz;
