-- 0365 —— 运维管理面板的跨租户只读视图（/admin/*）。
--
-- ─── 为什么需要这一组函数 ───
--
-- 队列与审计的运维问题天生是**全局**的：「现在有没有 run 卡在 assessing」
-- 「哪个作业类型在堆积」「最近谁把整个空间导出去了」——这三个问题都不是
-- 某一个 workspace 的事。
--
-- 但本仓库的数据面是**逐租户**的：`jobs`、`workspace_audit_log` 都是 FORCE RLS，
-- 策略同时比 `app.workspace_id` 与 `app.user_id` 两个 GUC，而一次连接只能带一份
-- workspace 上下文。也就是说在受限角色（`ailearn_api`，NOBYPASSRLS）下，
-- **不存在**合法的「看一眼全局队列」读法（实测：跨空间扫恒 0 行，
-- 与「队列是空的」长得一模一样——0286 记录过同一类假象）。
--
-- ─── 为什么是 SECURITY DEFINER，而不是给 API 一条 migrator 连接串 ───
--
-- 手上有三条路：
--   a) 给 API 容器发 `DATABASE_URL_MIGRATOR` —— 最省事，也最危险：
--      migrator 是 BYPASSRLS 且是全部表的属主，一句 `SELECT * FROM users`
--      就能读走所有人的 email 与 password_hash。把「面板要跨租户」变成
--      「整个 API 进程对全库有权限」，这是明显不成比例的提权。
--   b) 逐个 workspace 开事务枚举 —— 0286 实测过代价：1 330 个成员就是
--      1 330 次事务，而且**扫描成本随成员数长**，不随真正堆积的作业数长。
--   c) SECURITY DEFINER 函数 —— 先例就在这个文件里：0098 的 TTL 清理、
--      0121 的 run-processing claim、0286 的空闲候选预筛，全部是
--      「迁移创建（owner = ailearn_migrator，带 BYPASSRLS）→ REVOKE PUBLIC →
--      只 GRANT ailearn_api」。
--
-- 选 (c)：跨租户能力被压成**四支口径明确、只读、无参数注入面**的函数，
-- 而不是散落各处的裸查询。与 0286 同一个形状，同一个理由。
--
-- ─── 三条边界钉在这里 ───
--
--  1. **只读、且只回标识与计数**。四支函数都不返回 payload、note 正文、
--     source 片段、模型原文、email、password_hash。队列视图只给类型/状态/
--     计数/时刻；审计视图只给动作/角色/时刻 + `detail`（该列按审计模块的
--     既有约定只放计数与字节数，见 modules/audit/service.ts 约束 3）。
--  2. **p_limit 有上界**。调用方传 0 或负数会退化成无界全表扫描，
--     所以 `greatest(coalesce(p_limit,0),0)` 之后再 `least(..., 200)`——
--     上界写在函数里而不是只写在路由里，因为函数可能被别的调用方直接用。
--  3. **失败原因不在 SQL 里猜**。`jobs.last_error` 由 worker 写成
--     `operational_error:<category>:<name>[:<code>]` 的定长安全投影
--     （packages/shared/src/safe-error.ts），但那是**格式约定**而不是强制。
--     所以这里原样返回 `safe_error`，由 API 侧用同一套正则解析后再决定
--     展示什么——约定变了是解析失败（显示「未知」），不是自由文本漏出去。
--
-- ─── 与既有队列函数的关系 ───
--
-- `ailearn_queue_job_depth()` / `ailearn_queue_oldest_pending_age()`（0098）
-- 只给 worker，且按**状态**聚合。面板要回答的是「哪一类作业在堆积」，
-- 维度不同，因此另起一支而不是改既有函数的语义——既有函数是 worker 的
-- 回归面，不该为一个新读者改形状。

-- ─── 1. 队列积压：按作业类型 ──────────────────────────────────────────
--
-- 为什么按 type 而不是按 status 单列：`/metrics` 里
-- `ailearn_job_queue_depth{status}` 已经回答了「总共多少」（那是 worker 侧的
-- 指标，面板会直接读它）。这一支回答的是**另一个**问题——
-- 「是 companion_summarizer 在堆积，还是 parse_source」，只有带 type 维度才答得出。
CREATE OR REPLACE FUNCTION public.ailearn_admin_job_backlog()
RETURNS TABLE (
  job_type text,
  pending integer,
  running integer,
  failed_recent integer,
  dead_total integer,
  oldest_pending_seconds double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    j.type::text AS job_type,
    count(*) FILTER (WHERE j.status = 'pending')::integer AS pending,
    count(*) FILTER (WHERE j.status = 'running')::integer AS running,
    -- "recent" = 24 小时内进入终态。刻意不用 `finished_at IS NOT NULL`：
    -- 那会把半年前跑挂过一次的作业永远算进"最近失败"，面板上的红数字
    -- 就不再随时间消退，变成一块永远不会干净的背景噪声。
    count(*) FILTER (
      WHERE j.status = 'failed' AND j.finished_at > now() - interval '24 hours'
    )::integer AS failed_recent,
    count(*) FILTER (WHERE j.status = 'dead')::integer AS dead_total,
    COALESCE(
      EXTRACT(EPOCH FROM (clock_timestamp() - min(j.scheduled_at) FILTER (
        WHERE j.status = 'pending'
      ))),
      0
    )::double precision AS oldest_pending_seconds
  FROM public.jobs j
  GROUP BY j.type
  ORDER BY j.type;
$function$;

--> statement-breakpoint

-- ─── 2. 最近失败/死信作业（脱敏）─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ailearn_admin_recent_job_failures(p_limit integer DEFAULT 50)
RETURNS TABLE (
  id uuid,
  job_type text,
  workspace_id uuid,
  status text,
  attempts integer,
  safe_error text,
  scheduled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    j.id,
    j.type::text AS job_type,
    j.workspace_id,
    j.status::text AS status,
    j.attempts,
    j.last_error AS safe_error,
    j.scheduled_at,
    j.started_at,
    j.finished_at
  FROM public.jobs j
  WHERE j.status IN ('failed', 'dead')
  ORDER BY COALESCE(j.finished_at, j.scheduled_at) DESC, j.id
  LIMIT least(greatest(coalesce(p_limit, 0), 0), 200);
$function$;

--> statement-breakpoint

-- ─── 3. 最近高危动作审计（跨租户，脱敏）──────────────────────────────
CREATE OR REPLACE FUNCTION public.ailearn_admin_recent_audit(p_limit integer DEFAULT 50)
RETURNS TABLE (
  id uuid,
  workspace_id uuid,
  actor_user_id uuid,
  action text,
  target_kind text,
  target_id uuid,
  detail jsonb,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    a.id,
    a.workspace_id,
    a.actor_user_id,
    a.action,
    a.target_kind,
    a.target_id,
    a.detail,
    a.created_at
  FROM public.workspace_audit_log a
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT least(greatest(coalesce(p_limit, 0), 0), 200);
$function$;

--> statement-breakpoint

-- ─── 4. 平台规模计数 ─────────────────────────────────────────────────
--
-- 只有**计数**，没有任何标识。用户/空间总数是运维面板该有的事实
-- （"这个部署到底有没有人在用"），而 email、nickname、workspace 名
-- 属于身份数据，不在运维面板的暴露面里——要查具体是谁，走审计页。
CREATE OR REPLACE FUNCTION public.ailearn_admin_platform_counts()
RETURNS TABLE (
  users_total integer,
  workspaces_total integer,
  notes_active integer,
  jobs_total integer,
  runs_total integer,
  sessions_active integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    (SELECT count(*)::integer FROM public.users) AS users_total,
    (SELECT count(*)::integer FROM public.workspaces) AS workspaces_total,
    -- 软删的笔记不进「活跃」计数：`notes.deleted_at` 是软删标记
    -- （db-schema/note.ts:82），物理清除由后台任务另行处理。
    (SELECT count(*)::integer FROM public.notes WHERE deleted_at IS NULL) AS notes_active,
    (SELECT count(*)::integer FROM public.jobs) AS jobs_total,
    (SELECT count(*)::integer FROM public.learning_runs) AS runs_total,
    (SELECT count(*)::integer FROM public.sessions WHERE expires_at > now()) AS sessions_active;
$function$;

--> statement-breakpoint

-- ─── 授权 ───────────────────────────────────────────────────────────
--
-- 四支都 REVOKE PUBLIC 后只给 `ailearn_api`：
--   - 不给 `ailearn_worker`：worker 的运维问题走它自己的 `/metrics`，
--     它不需要读审计，也不需要跨租户看别的作业类型。
--   - 不给 `PUBLIC`：否则任意角色（含未来新增的受限角色）都能读到
--     全部空间的队列与审计。
-- 路由层的运维令牌闸（modules/admin/auth.ts）是**另一道**门，不是这一道的替代。

REVOKE ALL ON FUNCTION public.ailearn_admin_job_backlog() FROM PUBLIC;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.ailearn_admin_job_backlog() TO ailearn_api;

--> statement-breakpoint

GRANT ALL PRIVILEGES ON FUNCTION public.ailearn_admin_job_backlog() TO ailearn_migrator;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_admin_recent_job_failures(integer) FROM PUBLIC;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.ailearn_admin_recent_job_failures(integer) TO ailearn_api;

--> statement-breakpoint

GRANT ALL PRIVILEGES ON FUNCTION public.ailearn_admin_recent_job_failures(integer) TO ailearn_migrator;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_admin_recent_audit(integer) FROM PUBLIC;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.ailearn_admin_recent_audit(integer) TO ailearn_api;

--> statement-breakpoint

GRANT ALL PRIVILEGES ON FUNCTION public.ailearn_admin_recent_audit(integer) TO ailearn_migrator;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_admin_platform_counts() FROM PUBLIC;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.ailearn_admin_platform_counts() TO ailearn_api;

--> statement-breakpoint

GRANT ALL PRIVILEGES ON FUNCTION public.ailearn_admin_platform_counts() TO ailearn_migrator;

--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_admin_job_backlog() IS
  '运维面板：按作业类型的跨租户队列积压（pending/running/24h 失败/死信/最老等待）。只读、只回类型与计数，不含 payload 或任何作业正文。SECURITY DEFINER／migrator owner（BYPASSRLS）是 FORCE RLS 下唯一的跨租户读法。EXECUTE 只给 ailearn_api。';

--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_admin_recent_job_failures(integer) IS
  '运维面板：最近的 failed/dead 作业（跨租户）。safe_error 是 worker 写入的定长安全投影，不是自由文本——调用方须按 shared/safe-error 的正则再解析一次再展示。p_limit 上界 200。EXECUTE 只给 ailearn_api。';

--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_admin_recent_audit(integer) IS
  '运维面板：最近的高危动作审计（跨租户）。detail 按审计模块既有约定只放计数与字节数。p_limit 上界 200。EXECUTE 只给 ailearn_api。';

--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_admin_platform_counts() IS
  '运维面板：平台规模计数（用户/空间/活跃笔记/作业/学习运行/有效会话）。只有计数，无任何身份标识。EXECUTE 只给 ailearn_api。';