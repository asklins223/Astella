-- Existing note versions use 32-character MD5 content hashes; newer snapshots may
-- use longer hashes. The learning artifact stores the version's exact hash.
ALTER TABLE public.note_learning_artifacts
  DROP CONSTRAINT note_learning_artifacts_hash_length_check;

ALTER TABLE public.note_learning_artifacts
  ADD CONSTRAINT note_learning_artifacts_hash_length_check
    CHECK (char_length(source_content_hash) BETWEEN 8 AND 128);
