ALTER TABLE public.conversation_summaries
  ADD COLUMN IF NOT EXISTS coverage_from_seq bigint,
  ADD COLUMN IF NOT EXISTS coverage_through_seq bigint,
  ADD COLUMN IF NOT EXISTS coverage_source_hash text,
  ADD CONSTRAINT conversation_summaries_coverage_range_check
    CHECK (
      (coverage_from_seq IS NULL AND coverage_through_seq IS NULL AND coverage_source_hash IS NULL)
      OR (
        coverage_from_seq IS NOT NULL
        AND coverage_through_seq IS NOT NULL
        AND coverage_from_seq <= coverage_through_seq
        AND coverage_source_hash ~ '^[0-9a-f]{64}$'
      )
    );

CREATE INDEX IF NOT EXISTS conversation_summaries_watermark_idx
  ON public.conversation_summaries
    (workspace_id, user_id, conversation_id, coverage_through_seq DESC)
  WHERE coverage_through_seq IS NOT NULL;
