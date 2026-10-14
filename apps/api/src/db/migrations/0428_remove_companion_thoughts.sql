-- Remove the retired scheduled thought feature, including its stored history.
-- The new proactive conversation path persists ordinary companion messages instead.

-- `agent_operations.job_id` 以 ON DELETE RESTRICT 指着 jobs：真有一行被引用时这条 DELETE
-- 会让整个迁移中止，连带 role-grants 与 api 容器起不来。宁可把这一行留给人工核对。
DELETE FROM public.jobs j WHERE j.type = 'companion_thought'
  AND NOT EXISTS (SELECT 1 FROM public.agent_operations o WHERE o.job_id = j.id);

--> statement-breakpoint

-- 只清已经过了展示窗口的旧念头气泡。删掉某人的最大 inbox_sequence 会让下一条送达
-- 复用同一个序号，而客户端按序号判新旧——所以还没过期的那一行留着。
DELETE FROM public.assistant_deliveries
WHERE expires_at < now()
  AND kind = 'system_event'
  AND payload_ref->>'systemEventId' ~ '^thought:[0-9a-fA-F-]{36}$';

--> statement-breakpoint

DROP FUNCTION IF EXISTS public.astella_enqueue_companion_thoughts();

--> statement-breakpoint

DROP TABLE IF EXISTS public.assistant_thoughts CASCADE;
