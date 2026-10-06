-- Annotation deletion removes the matching source-anchored demonstrations in
-- the same transaction. Keep the API grant explicit for migration-only setups;
-- the existing owner RLS policy still limits deletion to visible, owned records.
GRANT DELETE ON public.note_learning_artifacts TO astella_api;
