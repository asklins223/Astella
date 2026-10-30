-- Keep paragraph rewrite protection through an API restart. The CRDT revision
-- remains unchanged when only a lock is acquired, bound or released.
ALTER TABLE note_document_states ADD COLUMN IF NOT EXISTS rewrite_locks jsonb NOT NULL DEFAULT '[]'::jsonb;
