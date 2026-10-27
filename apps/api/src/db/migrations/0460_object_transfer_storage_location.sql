-- Keep completion pinned to the store that issued its signed PUT, even after recovery.
ALTER TABLE public.object_transfers ADD COLUMN IF NOT EXISTS storage_location text NOT NULL DEFAULT 'primary'
  CHECK (storage_location IN ('primary','backup'));
