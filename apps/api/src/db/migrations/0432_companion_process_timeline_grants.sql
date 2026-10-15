-- 0432: 补授 0426 手记时间线归档函数的 EXECUTE（api 与 worker 两支都缺）。
--
-- 事故经过（2026-10-14 实测开发库）：伴星每一轮在写第一帧 `assistant.status` 事件时抛
-- `42501 permission denied for function companion_process_event_payload`，job 三次重试后
-- 变 dead，`companion_turn_runs` 停在 accepted。用户那边的表现就是"agent 任务一直挂"。
-- dead 是当天 23:00 UTC 之后才出现的形状（`jobs.last_error = operational_error:database:Error`），
-- 与 0426 落库的时间对上。
--
-- 为什么 0426 没写 GRANT 也能跑，直到这次重启才炸：
--   1. 0426 建的两支函数没有 REVOKE/GRANT，按 PostgreSQL 默认拿到 PUBLIC 的 EXECUTE，
--      任何角色都调得动。
--   2. `infra/postgres/roles.sql` 在每次 `make up` 的 role-grants 阶段重跑，其中一句
--      `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, astella_api, astella_worker`
--      把这份默认授权整个收掉，只有该文件白名单里重新 GRANT 过的才活下来（同一形状
--      的先例见 0359 与 roles.sql 里 0267 那段注释）。
--   3. 0426 的两支函数不在白名单 → 授权被收回。`companion_archive_process_event` 是
--      SECURITY INVOKER，它里面那次 `companion_process_event_payload(...)` 是**以 session
--      用户的权限**执行的，于是 worker 写 `companion_stream_events` 每帧都必挂。
--
-- roles.sql 里"触发器函数不算，触发执行不查 session 用户的 EXECUTE"这句话本身没错，
-- 但它的适用范围只到触发器那一层：触发器往下调用的普通函数照旧按 session 用户判定。
-- 这次漏的就是这一层。实测（同本文件验证记录）：只授内层这一支，worker 的 INSERT 即恢复。
--
-- 授给 api 是因为它也写同一张表（`turn-service`、`learning-action-bridge`、
-- `companion-proposal-expiry`），少了就是用户发第一句话时同样 42501。

REVOKE ALL ON FUNCTION public.companion_process_event_payload(text, jsonb) FROM PUBLIC;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.companion_process_event_payload(text, jsonb) TO astella_api, astella_worker;
