-- 0403：把「上一句实际播到哪」留在这一轮上（方案 50 §10.2 / §6.1）。
--
-- 为什么是一格 jsonb 而不是新表：这份背景**已经有权威行**了——
-- `companion_tts_outcomes` 的 `stage='playback'` 那段（0246/0247）就是它。
-- 新表只会造出第二份「谁播了什么」，两份不一致时没人能判哪份算。
-- 这里存的是一份**有界投影**，合同在 `companion-observation-contracts`，
-- 每条都带着它引用的是哪一个 run；权威行被删或被换版时，投影读出来就该是 null。
--
-- 为什么不让 worker 直接去读那张表：worker 对 `companion_tts_outcomes` 刻意没有读边
-- （0246 的授权矩阵），而「这一轮看到了什么」必须是可回放的事实，不能是一次临时查询的运气。
-- 因此由 API 在接受回合时算好、落在这一轮的 run 行上，与 `context_assembly_receipt` 同一味道。
--
-- null 是常态：正常播完、没有失败段、用户也没在朗读中途插话时，什么都不带。

ALTER TABLE public.companion_turn_runs
  ADD COLUMN IF NOT EXISTS delivery_observation jsonb;

--> statement-breakpoint

-- 形状由合同把住，不在库里再写一遍枚举；这里只挡最省事的那种写法：
-- 塞一个裸字符串或一个数组进来，读边会当"没有观察"静默跳过。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.companion_turn_runs'::regclass
      AND attname = 'delivery_observation'
      AND attnotnull
  ) THEN
    RAISE EXCEPTION 'delivery_observation must stay nullable: most turns carry no delivery background';
  END IF;
END $$;
