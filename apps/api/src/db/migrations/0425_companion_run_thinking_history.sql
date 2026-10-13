-- 0425: 完成回复后仍能从对话手记读取对应思考记录。
--
-- 思考独立于 companion_messages 保存，不进入回答正文、复制文本或语音；
-- companion_stream_events 仍负责实时流式传递并按原 TTL 清理。

ALTER TABLE public.companion_turn_runs
  ADD COLUMN IF NOT EXISTS thinking_text text;

-- 0422 已上线且仍在 TTL 内的思考事件也一并补进历史栏，避免这次升级前刚完成的
-- 对话出现“新对话有思考记录，上一条却没有”的断层。
UPDATE public.companion_turn_runs AS run
SET thinking_text = events.text
FROM (
  SELECT run_id, right(string_agg(payload->>'text', '' ORDER BY seq), 60000) AS text
  FROM public.companion_stream_events
  WHERE type = 'assistant.thinking'
    AND run_id IS NOT NULL
    AND expires_at > now()
  GROUP BY run_id
) AS events
WHERE run.id = events.run_id
  AND run.thinking_text IS NULL;
