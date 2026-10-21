-- Plan 57 follow-up (2026-10-20): retire the orphaned note learning reflections.
--
-- 0449 dropped note_learning_rounds with CASCADE. The reflections table kept its
-- foreign key to that table, so the drop removed the reflection's only policy
-- (its USING clause reads note_learning_rounds) while leaving the table itself
-- with RLS enabled and no policy. A fresh database then fails its bootstrap RLS
-- completeness check, and the table has no reader left: its schema definition
-- was the only remaining reference in source.

DROP TABLE IF EXISTS public.note_learning_reflections CASCADE;
