-- Plan 57 hard cutover, leftover rows 2026-10-20.
--
-- 0449 dropped the main tables of the retired learning-card / review / today
-- chain, but a few survivors were missed because they had no foreign key to a
-- dropped parent (or were created by a later migration):
--   * note_learning_round_targets
--   * note_learning_round_model_attempts
--   * assessment_disputes_v2 (referenced by assessment_corrections_v2)
--   * assessment_corrections_v2
--
-- No code reads them anymore (the dispute/review modules and round handler
-- were deleted with the rest of the chain), so dropping the storage completes
-- the deletion rather than migrating it.

DROP TABLE IF EXISTS note_learning_round_targets CASCADE;
DROP TABLE IF EXISTS note_learning_round_model_attempts CASCADE;
DROP TABLE IF EXISTS assessment_corrections_v2 CASCADE;
DROP TABLE IF EXISTS assessment_disputes_v2 CASCADE;
