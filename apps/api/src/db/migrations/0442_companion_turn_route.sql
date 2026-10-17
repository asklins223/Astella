-- 0442: per-turn routing facts for the companion release gate (`companion_turn_runs.route`).
--
-- The release gate decides when the already-generated opening may be shown, so the
-- per-turn latency split ("gateway first token" vs "router/release increment") cannot
-- live only in logs: the two numbers must be joinable against the stream event times.
-- Open JSONB on purpose — the L1 router's source/probability/similarity fields are added
-- to the same object later, without another column. Diagnostics only; no conversation text.

ALTER TABLE public.companion_turn_runs
  ADD COLUMN IF NOT EXISTS route jsonb;

COMMENT ON COLUMN public.companion_turn_runs.route IS
  'Per-turn routing facts for the companion release gate: classifier source/elapsed/hedged and release wait. Diagnostics only; contains no conversation text.';
