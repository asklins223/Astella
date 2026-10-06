-- 补授 worker 角色漏掉的函数授权（0345 / 0346 / 0018 三处遗漏）
--
-- ## 事故经过（2026-10-01 ~ 10-02 实测）
--
-- worker 连库用的是受限角色 `astella_worker`（compose 的 DATABASE_URL_WORKER），
-- 而下面三个函数各自 `REVOKE ... FROM PUBLIC` 之后**只授给了 `astella_api`**。
-- 于是 `companion-memory-maintenance` 这个后台 tick 每次调用都拿到
-- `42501 permission denied for function ...`。
--
-- 为什么它变成一场事故而不是一行 warn：那两个清理查询**没有节流**，
-- 每个 worker tick 都发一次；而 tick 的自适应退避被 `index.ts` 里一句
-- 无条件的 `currentPollMs = POLL_MS` 顶在 1000ms（POLL_MAX_MS=5000 永远到不了），
-- 于是循环稳定在 **1 次/秒**，18 小时不间断：
--   - worker 日志 133 万行 / 43.8 MB（59,310 + 59,237 条重复 WARN）
--   - postgres 日志 62,753 条 ERROR / 58.8 MB
--   - 容器 CPU 237%（该容器没有任何 cpus 限制）
--
-- 注意错误**换过一次**：10-01 21:21 起报 `42883 function does not exist`
-- （0345 尚未迁移），10-02 07:53 迁移补上后变成 `42501 permission denied`——
-- 循环对这次变化毫无察觉，因为它只看「抛没抛」。
--
-- ## 为什么是新迁移而不是改 0345/0346
--
-- runner 按 **SQL 文件内容的 sha256** 记账（`db/migrate.ts`）。改已应用迁移的
-- 正文会让它的 hash 变掉，于是整条被当成「未应用」重跑。补授权是纯 GRANT，
-- 幂等且不依赖 0345/0346 的执行顺序，所以单开一条更稳。
--
-- ## 漏掉的是哪几行
--
-- - 0345:98  给 `astella_api` 授了 purge，没给 worker。
-- - 0346:115 给 `astella_companion_memory_retention_limits` **授了** worker，
--   紧接着 0346:116 的 enforce 又只授 api —— 同一份迁移里前后不一致，
--   说明这是笔误而不是设计。
-- - 0018:180 revoke 了 `astella_reap_stale_jobs`，全仓没有任何地方授给 worker。
--   它有 30s 节流，所以不是这次烧 CPU 的原因，但它同样是坏的。

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.astella_purge_expired_companion_memory() TO astella_worker;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.astella_enforce_companion_memory_retention() TO astella_worker;

--> statement-breakpoint

-- 0018 revoke 之后再无授权。worker 的 reapStaleJobs 每 30s 调一次，
-- 实测在 postgres 日志里留下 819 条 permission denied。
GRANT EXECUTE ON FUNCTION public.astella_reap_stale_jobs(integer, integer) TO astella_worker;