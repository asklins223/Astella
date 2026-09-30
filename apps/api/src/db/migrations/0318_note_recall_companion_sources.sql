-- Recall questions and hints are companion turns. Keep exact source identities while
-- preserving the note record if the user later deletes the related conversation.
ALTER TABLE public.note_recall_records
  ADD COLUMN source_message_id uuid REFERENCES public.companion_messages(id) ON DELETE SET NULL,
  ADD COLUMN conversation_id uuid REFERENCES public.companion_conversations(id) ON DELETE SET NULL,
  ADD COLUMN hint_source_message_id uuid REFERENCES public.companion_messages(id) ON DELETE SET NULL,
  ADD COLUMN hint_conversation_id uuid REFERENCES public.companion_conversations(id) ON DELETE SET NULL,
  ALTER COLUMN section_ordinal DROP NOT NULL,
  ALTER COLUMN hint_snapshot DROP NOT NULL;

ALTER TABLE public.note_recall_records
  ADD CONSTRAINT note_recall_hint_source_after_hint
    CHECK (hint_source_message_id IS NULL OR hint_viewed_at IS NOT NULL),
  ADD CONSTRAINT note_recall_hint_snapshot_after_hint
    CHECK (hint_viewed_at IS NULL OR hint_snapshot IS NOT NULL);
