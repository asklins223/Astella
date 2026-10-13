-- 0422: 让她思考时想的内容真的显示出来。
--
-- 提问轮的实测形状：网关在首个可见正文字之前有 17–26 秒只有内部思考在动
-- （`response.reasoning_text.delta`，实测 2,973–3,254 条增量、366–518KB），
-- 这段空白此前在 provider 的 SSE 读取循环里被整批丢弃，用户对着的是
-- 一句固定文案「正在思考…」。现在把它作为独立一类事件下发。
--
-- 这一类事件只有一条语义：**看得见，但不算她说过的话**。
--   - 不进 `assistant.delta`，所以朗读分段（`voice.segment.ready` 由已提交的
--     可见正文驱动）根本拿不到它；
--   - 不进 `companion_messages`，回复正文与历史仍只有答案；
--   - 随 `companion_stream_events` 既有的 TTL 一起清理，不新增留存面。
--
-- 表上没有别的改动：worker 对这张表的 INSERT 授权（0091/0094/0102）已经够了。

ALTER TABLE public.companion_stream_events
  DROP CONSTRAINT IF EXISTS companion_stream_events_type_check;
ALTER TABLE public.companion_stream_events
  ADD CONSTRAINT companion_stream_events_type_check CHECK (type IN (
    'turn.accepted', 'assistant.status', 'assistant.thinking',
    'assistant.delta', 'assistant.final', 'assistant.followups.ready',
    'agent.skill', 'agent.tool', 'character.cue', 'action.proposed',
    'action.decision', 'action.expired', 'action.started', 'action.completed',
    'action.failed', 'voice.segment.ready', 'proactive.delivery',
    'proactive.delivery.updated', 'turn.cancelled', 'error'
  ));
