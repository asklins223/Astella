-- 伴星首字 / 分类器真实基线（2026-10-17，只读）
--
-- 在 production 库以 owner／migrator 角色跑（绕过 RLS）：
--   psql "$DATABASE_URL_MIGRATOR" -f scripts/companion-latency-baseline.sql
--
-- 用途：给 L1 放行路由定阈值、给 L2 兜底超时定上限，全部用真实分布而不是本机探针。
-- 只读：本文件不含任何 INSERT/UPDATE/DELETE。
-- 注意：ai_audit_log 与 companion_stream_events 都有 TTL/保留期，窗口按实际保留天数调。

\echo '── ① L2 分类器整次往返（companion_agent:chat_completion）────────────────'

with l2 as (
  select date_trunc('day', created_at) as day,
         duration_ms,
         status,
         prompt_tokens,
         completion_tokens
  from public.ai_audit_log
  where operation = 'companion_agent:chat_completion'
    and created_at >= now() - interval '14 days'
)
select day,
       count(*)                                                          as calls,
       count(*) filter (where status <> 'success')                       as failed,
       round(percentile_cont(0.5)  within group (order by duration_ms)::numeric, 0) as p50_ms,
       round(percentile_cont(0.9)  within group (order by duration_ms)::numeric, 0) as p90_ms,
       round(percentile_cont(0.99) within group (order by duration_ms)::numeric, 0) as p99_ms,
       max(duration_ms)                                                  as max_ms,
       round(avg(prompt_tokens))                                         as avg_prompt_tokens,
       round(avg(completion_tokens))                                     as avg_completion_tokens
from l2
group by day
order by day;

\echo '── ② 首字：turn.accepted → 第一条 assistant.delta ──────────────────────'

with accepted as (
  select run_id, min(created_at) as at
  from public.companion_stream_events
  where type = 'turn.accepted'
    and run_id is not null
    and created_at >= now() - interval '14 days'
  group by run_id
), first_delta as (
  select run_id, min(created_at) as at
  from public.companion_stream_events
  where type = 'assistant.delta'
    and run_id is not null
    and created_at >= now() - interval '14 days'
  group by run_id
)
select date_trunc('day', a.at) as day,
       count(*)                                                                   as turns,
       count(d.at)                                                                as turns_with_delta,
       round(percentile_cont(0.5)  within group (order by extract(epoch from (d.at - a.at)) * 1000)::numeric, 0) as p50_first_delta_ms,
       round(percentile_cont(0.9)  within group (order by extract(epoch from (d.at - a.at)) * 1000)::numeric, 0) as p90_first_delta_ms,
       round(percentile_cont(0.99) within group (order by extract(epoch from (d.at - a.at)) * 1000)::numeric, 0) as p99_first_delta_ms
from accepted a
left join first_delta d using (run_id)
group by day
order by day;

\echo '── ③ 放行闸归因（优先用 route 列；未部署 0442 前用审计 join）──────────'
-- 部署 0442 之后 `companion_turn_runs.route` 直接带着每轮的分类器读数：
--   route.classifier.source: l2 | timeout | cached
--   route.classifier.elapsedMs / hedged
--   route.release.waitedMs: 从 handler 开始到放行闸打开
-- 分类器耗时（或 cached=0）与首字之差就是"放行闸之外还等了多少"。

with accepted as (
  select run_id, min(created_at) as at
  from public.companion_stream_events
  where type = 'turn.accepted' and run_id is not null
    and created_at >= now() - interval '14 days'
  group by run_id
), first_delta as (
  select run_id, min(created_at) as at
  from public.companion_stream_events
  where type = 'assistant.delta' and run_id is not null
    and created_at >= now() - interval '14 days'
  group by run_id
), routed as (
  select r.id as run_id,
         coalesce(r.route->'classifier'->>'source', 'l2')        as source,
         coalesce((r.route->'classifier'->>'elapsedMs')::numeric, 0) as classifier_ms,
         coalesce((r.route->'classifier'->>'hedged')::boolean, false) as hedged,
         coalesce((r.route->'release'->>'waitedMs')::numeric, null)  as release_wait_ms
  from public.companion_turn_runs r
  where r.created_at >= now() - interval '14 days'
)
select routed.source,
       count(*)                                                                  as turns,
       count(*) filter (where routed.hedged)                                     as hedged_turns,
       round(avg(routed.release_wait_ms))                                        as avg_release_wait_ms,
       round(percentile_cont(0.5) within group (order by routed.release_wait_ms)::numeric, 0) as p50_release_wait_ms,
       round(avg(extract(epoch from (d.at - a.at)) * 1000))                      as avg_first_delta_ms,
       round(avg(greatest(0, extract(epoch from (d.at - a.at)) * 1000 - routed.classifier_ms))) as avg_gap_after_classifier_ms
from accepted a
join first_delta d using (run_id)
join routed using (run_id)
group by routed.source
order by turns desc;

-- ③b（route 列尚未部署时可用）：把分类器审计行和 run 的 job 对齐。
with accepted as (
  select run_id, min(created_at) as at
  from public.companion_stream_events
  where type = 'turn.accepted' and run_id is not null
    and created_at >= now() - interval '14 days'
  group by run_id
), first_delta as (
  select run_id, min(created_at) as at
  from public.companion_stream_events
  where type = 'assistant.delta' and run_id is not null
    and created_at >= now() - interval '14 days'
  group by run_id
), classifier as (
  select job_id, max(duration_ms) as l2_ms, count(*) as calls
  from public.ai_audit_log
  where operation = 'companion_agent:chat_completion'
    and job_id is not null
    and created_at >= now() - interval '14 days'
  group by job_id
)
select count(*) as turns,
       round(avg(classifier.calls))                              as avg_classifier_calls_per_turn,
       round(avg(extract(epoch from (d.at - a.at)) * 1000))      as avg_first_delta_ms,
       round(avg(classifier.l2_ms))                              as avg_classifier_ms,
       round(avg(greatest(0, extract(epoch from (d.at - a.at)) * 1000 - classifier.l2_ms))) as avg_gap_after_classifier_ms
from accepted a
join first_delta d using (run_id)
join public.companion_turn_runs r on r.id = a.run_id
join classifier on classifier.job_id = r.job_id;

\echo '── ④ 负标签：确认门被拒绝 / 过期 / 用户马上纠正或追问 ─────────────────'

-- 4a. 确认被拒（route 放错方向的直接证据）
select risk_class,
       count(*)                                      as proposals,
       count(*) filter (where status = 'rejected')   as rejected,
       count(*) filter (where status = 'expired')    as expired,
       count(*) filter (where status = 'succeeded')  as succeeded,
       round(count(*) filter (where status = 'rejected')::numeric / nullif(count(*), 0), 3) as reject_rate
from public.companion_action_proposals
where created_at >= now() - interval '30 days'
group by risk_class
order by proposals desc;

-- 4b. 用户下一句马上纠正 / 重问（粗代理，不是标注真值）：助手完成后 120 s 内
--     的第一条用户消息里出现纠正词或"再来/重新/我说的是"。只用于排序与抽检。
with assistant_turns as (
  select m.conversation_id, m.created_at as assistant_at,
         lead(m.created_at) over (partition by m.conversation_id order by m.seq) as next_at,
         lead(m.blocks)    over (partition by m.conversation_id order by m.seq) as next_blocks
  from public.companion_messages m
  where m.role = 'assistant'
    and m.created_at >= now() - interval '30 days'
)
select count(*) filter (
         where next_at is not null
           and next_at - assistant_at <= interval '120 seconds'
           and coalesce(next_blocks::text, '') ~ '(不是|不对|我说的是|再来|重新|没听懂|什么意思)'
       ) as quick_correction_like,
       count(*) as assistant_messages
from assistant_turns;

\echo '── ⑤ L1 影子路由：覆盖率 / 漏放率（route.l1，需部署 0442 与 COMPANION_RELEASE_ROUTER=shadow）'

-- 影子期要回答的就是两条：L1 敢放行的比例（覆盖率）和它放行错了的比例（漏放率）。
-- 目标是在“漏放率 ≤ 2%”的前提下取最大覆盖率；阈值用 COMPANION_RELEASE_TAU_* 重算。
with l1 as (
  select (r.route->'l1'->>'decision')                      as decision,
         (r.route->'l1'->>'reason')                        as reason,
         (r.route->'l1'->>'agreement')                     as agreement,
         (r.route->'l1'->>'samples')::int                  as samples,
         (r.route->'l1'->'gates'->>'pendingOffer')::boolean as pending_offer,
         (r.route->'l1'->'gates'->>'anaphora')::boolean     as anaphora,
         (r.route->'l1'->'gates'->>'short')::boolean        as short_gate
  from public.companion_turn_runs r
  where r.route->'l1' is not null
    and r.created_at >= now() - interval '14 days'
)
select count(*)                                                                  as turns_with_l1,
       count(*) filter (where decision = 'release')                              as l1_release,
       count(*) filter (where agreement = 'misrelease')                          as misrelease,
       count(*) filter (where agreement = 'conservative')                        as conservative,
       round(count(*) filter (where decision = 'release')::numeric / nullif(count(*), 0), 3) as coverage,
       round(count(*) filter (where agreement = 'misrelease')::numeric
         / nullif(count(*) filter (where decision = 'release'), 0), 3)            as misrelease_rate,
       round(avg(samples))                                                       as avg_index_samples
from l1;

-- 弃权原因分布：gated（状态门）占多少、cold（索引没热）占多少——前几天的 cold 高是正常的。
select reason, count(*) as turns,
       round(count(*)::numeric / nullif(sum(count(*)) over (), 0), 3) as share
from l1
group by reason
order by turns desc;
