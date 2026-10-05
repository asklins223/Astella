-- Count every actual provider attempt across classifier, streaming fallback, repair and resumed turns.
ALTER TABLE public.companion_turn_runs ADD COLUMN model_call_count integer NOT NULL DEFAULT 0
  CHECK (model_call_count>=0);
