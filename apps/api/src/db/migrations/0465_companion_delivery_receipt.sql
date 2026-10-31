-- 0465: Record what the run itself claimed to deliver.
--
-- companion_finish validates the model's own account of the turn (outcome plus
-- one requirement per ask, each fulfilled requirement citing a receipt from
-- this run). Until now that account was checked and then discarded, so "who
-- did what" could only be reconstructed from the ledger. Keep it on the run.
--
-- Only the validated value is stored: a finish that failed validation never
-- reaches this column. Null means the turn settled without a structured
-- account (a read-only or greeting turn), never "everything succeeded".
ALTER TABLE companion_turn_runs ADD COLUMN IF NOT EXISTS delivery_receipt jsonb;

COMMENT ON COLUMN companion_turn_runs.delivery_receipt IS
  'companion_finish 校验通过后的自述：outcome 与逐条 requirement（含引用的本轮回执 id）。null = 本轮没有结构化自述，不代表全部完成。';
