-- AI Learn System v0.4 database roles and grants.
--
-- This file is intentionally a psql script, not a PostgreSQL template with
-- literal `${PASSWORD}` placeholders.  apply-roles.sh supplies the three
-- passwords through psql variables (`-v ..._password=...`).  Run it as the
-- database administrator before and after migrations:
--
--   /bin/sh infra/postgres/apply-roles.sh
--
-- The script is safe to repeat. It reconciles role ownership and privileges,
-- but migrations define the RLS policies. Scoped requests set trusted,
-- transaction-local app.user_id and app.workspace_id values before DB access.

\set ON_ERROR_STOP on

-- 向量扩展必须**先于迁移**存在。
--
-- `0052_supervisor_agent_v1_schema` 起有十余份迁移 `CREATE EXTENSION IF NOT EXISTS
-- vector`，但它们跑在 `astella_migrator` 上，而建扩展是超级用户权限 ⇒
-- `permission denied to create extension "vector"`。
--
-- 0052 的注释本来就写着这件事该由本脚本负责（"fresh DB 由 init 脚本创建 extension，
-- 现有 volume 由管理员 bootstrap"），而 `infra/postgres/init.sql` 此前只建了
-- uuid-ossp 与 pg_trgm，唯独漏了 vector ⇒ 文档与实现对不上，fresh 库必然卡在 0052。
-- 这里补的是既有 volume 这条路径；`init.sql` 同步补，两条路径都覆盖到。
--
-- 镜像必须带 pgvector（CI 已从 postgres:16-alpine 换成 pgvector/pgvector:pg16）；
-- 扩展不在镜像里时这一行会自己失败，而不是把问题留到迁移中途。
CREATE EXTENSION IF NOT EXISTS vector;

-- Fail early when the wrapper was bypassed without supplying secrets.  The
-- values are quoted by psql's :'name' syntax before PostgreSQL sees them, then
-- held in transaction-local custom settings for the procedural checks below.
SELECT set_config('astella.migrator_password', :'migrator_password', false) AS ignored \gset
SELECT set_config('astella.api_password', :'api_password', false) AS ignored \gset
SELECT set_config('astella.worker_password', :'worker_password', false) AS ignored \gset
SELECT set_config('astella.require_rls_disabled', :'require_rls_disabled', false) AS ignored \gset
DO $$
BEGIN
  IF length(trim(current_setting('astella.migrator_password'))) = 0
    OR length(trim(current_setting('astella.api_password'))) = 0
    OR length(trim(current_setting('astella.worker_password'))) = 0
  THEN
    RAISE EXCEPTION 'role passwords must be non-empty';
  END IF;
END
$$;

-- Create the roles only when absent.  ALTER ROLE below also rotates a role's
-- password when the operator intentionally changes the environment value.
SELECT format(
  'CREATE ROLE astella_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS PASSWORD %L',
  :'migrator_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'astella_migrator'
)\gexec

SELECT format(
  'CREATE ROLE astella_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
  :'api_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'astella_api'
)\gexec

SELECT format(
  'CREATE ROLE astella_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
  :'worker_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'astella_worker'
)\gexec

ALTER ROLE astella_migrator
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS
  PASSWORD :'migrator_password';
ALTER ROLE astella_api
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
  PASSWORD :'api_password';
ALTER ROLE astella_worker
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
  PASSWORD :'worker_password';

-- Drizzle always emits CREATE SCHEMA IF NOT EXISTS for its journal, and
-- PostgreSQL checks database-level CREATE even when the schema already exists.
-- Only the dedicated migrator receives that DDL capability.
SELECT format(
  'GRANT CONNECT, CREATE ON DATABASE %I TO astella_migrator',
  current_database()
)\gexec
SELECT format(
  'GRANT CONNECT ON DATABASE %I TO astella_api, astella_worker',
  current_database()
)\gexec
SELECT format(
  'REVOKE CREATE ON DATABASE %I FROM astella_api, astella_worker',
  current_database()
)\gexec

-- Keep the migration tracking schema owned by the migrator.  It is created
-- before the first migration so Drizzle can use a non-superuser connection.
CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION astella_migrator;
ALTER SCHEMA drizzle OWNER TO astella_migrator;
GRANT USAGE, CREATE ON SCHEMA drizzle TO astella_migrator;
GRANT USAGE ON SCHEMA public TO astella_migrator, astella_api, astella_worker;
GRANT CREATE ON SCHEMA public TO astella_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM astella_api, astella_worker;

-- The application database may have been created with the old `astella`
-- owner.  Transfer only ordinary application objects so an existing database
-- can be upgraded by the migrator role; extension-owned objects are skipped.
DO $$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT n.nspname, c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'drizzle')
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.deptype = 'e'
      )
    -- PostgreSQL requires an owned sequence and its table to have the same
    -- owner.  A plain pg_dump restore creates both as the restore role, so
    -- transfer tables first; ALTER TABLE OWNER then carries linked sequences
    -- with it, and the final sequence pass is safe and deterministic.
    ORDER BY (c.relkind = 'S'), n.nspname, c.relname
  LOOP
    IF obj.relkind = 'S' THEN
      EXECUTE format(
        'ALTER SEQUENCE %I.%I OWNER TO astella_migrator',
        obj.nspname, obj.relname
      );
    ELSIF obj.relkind = 'v' THEN
      EXECUTE format(
        'ALTER VIEW %I.%I OWNER TO astella_migrator',
        obj.nspname, obj.relname
      );
    ELSIF obj.relkind = 'm' THEN
      EXECUTE format(
        'ALTER MATERIALIZED VIEW %I.%I OWNER TO astella_migrator',
        obj.nspname, obj.relname
      );
    ELSIF obj.relkind = 'f' THEN
      EXECUTE format(
        'ALTER FOREIGN TABLE %I.%I OWNER TO astella_migrator',
        obj.nspname, obj.relname
      );
    ELSE
      EXECUTE format(
        'ALTER TABLE %I.%I OWNER TO astella_migrator',
        obj.nspname, obj.relname
      );
    END IF;
  END LOOP;

  -- Enum/domain ownership matters for forward migrations that replace a
  -- legacy enum.  Extension-owned types remain under their extension owner.
  FOR obj IN
    SELECT n.nspname, t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typtype IN ('e', 'd')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        WHERE d.classid = 'pg_type'::regclass
          AND d.objid = t.oid
          AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format(
      'ALTER TYPE %I.%I OWNER TO astella_migrator',
      obj.nspname, obj.typname
    );
  END LOOP;
END
$$;

-- A plain pg_dump/psql restore with --no-owner recreates application
-- functions as the restore role.  Reconcile the five audited queue
-- entrypoints before applying their exact ACLs and validating SECURITY
-- DEFINER/search_path below; extension-owned functions remain untouched.
DO $$
BEGIN
  IF to_regprocedure('public.astella_claim_jobs(integer,integer,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.astella_claim_jobs(integer, integer, integer)
      OWNER TO astella_migrator;
  END IF;

  IF to_regprocedure('public.astella_reap_stale_jobs(integer,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.astella_reap_stale_jobs(integer, integer)
      OWNER TO astella_migrator;
  END IF;

  IF to_regprocedure('public.astella_renew_job_lease(uuid,uuid,text)') IS NOT NULL THEN
    ALTER FUNCTION public.astella_renew_job_lease(uuid, uuid, text)
      OWNER TO astella_migrator;
  END IF;

  IF to_regprocedure('public.astella_finish_job(uuid,uuid,text)') IS NOT NULL THEN
    ALTER FUNCTION public.astella_finish_job(uuid, uuid, text)
      OWNER TO astella_migrator;
  END IF;

  IF to_regprocedure('public.astella_fail_job(uuid,uuid,text,text,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.astella_fail_job(uuid, uuid, text, text, integer)
      OWNER TO astella_migrator;
  END IF;

  -- Queue SECURITY DEFINER functions are created by migrations (dev uses the
  -- astella role), so bootstrap must converge their owner to the migrator
  -- role on every replay (the BYPASSRLS semantics depend on this).
  IF to_regprocedure('public.astella_queue_job_depth()') IS NOT NULL THEN
    ALTER FUNCTION public.astella_queue_job_depth()
      OWNER TO astella_migrator;
  END IF;
  IF to_regprocedure('public.astella_queue_oldest_pending_age()') IS NOT NULL THEN
    ALTER FUNCTION public.astella_queue_oldest_pending_age()
      OWNER TO astella_migrator;
  END IF;
  IF to_regprocedure('public.astella_purge_companion_audit_ttl(integer,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.astella_purge_companion_audit_ttl(integer, integer)
      OWNER TO astella_migrator;
  END IF;
  IF to_regprocedure('public.astella_purge_invitation_ledger_ttl(integer,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.astella_purge_invitation_ledger_ttl(integer, integer)
      OWNER TO astella_migrator;
  END IF;
  IF to_regprocedure('public.astella_purge_tutor_nonces_ttl(integer,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.astella_purge_tutor_nonces_ttl(integer, integer)
      OWNER TO astella_migrator;
  END IF;
  IF to_regprocedure('public.astella_purge_expired_object_transfers()') IS NOT NULL THEN
    ALTER FUNCTION public.astella_purge_expired_object_transfers() OWNER TO astella_migrator;
  END IF;
  -- 0171/0172：方案 22 桌宠日记/记忆维护 SECURITY DEFINER 函数，owner 收敛到
  -- astella_migrator（BYPASSRLS 语义依赖；search_path 需对齐 pg_catalog, public）。
  IF to_regprocedure('public.astella_enqueue_companion_daily_summaries()') IS NOT NULL THEN
    ALTER FUNCTION public.astella_enqueue_companion_daily_summaries()
      SECURITY DEFINER;
    ALTER FUNCTION public.astella_enqueue_companion_daily_summaries()
      OWNER TO astella_migrator;
    ALTER FUNCTION public.astella_enqueue_companion_daily_summaries()
      SET search_path = pg_catalog, public;
  END IF;
  IF to_regprocedure('public.astella_run_companion_memory_maintenance()') IS NOT NULL THEN
    ALTER FUNCTION public.astella_run_companion_memory_maintenance()
      OWNER TO astella_migrator;
    ALTER FUNCTION public.astella_run_companion_memory_maintenance()
      SET search_path = pg_catalog, public;
  END IF;
  IF to_regprocedure('public.astella_close_companion_memory_delivery(uuid,uuid,uuid,text)') IS NOT NULL THEN
    ALTER FUNCTION public.astella_close_companion_memory_delivery(uuid, uuid, uuid, text)
      SECURITY DEFINER;
    ALTER FUNCTION public.astella_close_companion_memory_delivery(uuid, uuid, uuid, text)
      OWNER TO astella_migrator;
    ALTER FUNCTION public.astella_close_companion_memory_delivery(uuid, uuid, uuid, text)
      SET search_path = pg_catalog, public;
  END IF;
END
$$;

-- Reset grants before applying the explicit matrix.  This removes privileges
-- left by the old shared `astella` connection without touching ownership.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM astella_api, astella_worker;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM astella_api, astella_worker;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO astella_migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO astella_migrator;

-- API is the business CRUD role.  It deliberately receives no schema DDL or
-- migration-schema access beyond the read-only readiness query below.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public TO astella_api;

DO $$ BEGIN
  IF to_regclass('public.agent_run_revisions') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.agent_run_revisions FROM PUBLIC,astella_api,astella_worker;
    GRANT SELECT,INSERT ON TABLE public.agent_run_revisions TO astella_api,astella_worker;
  END IF;
END $$;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO astella_api;

-- Memory history is append-only. Both runtimes may read it; the database trigger
-- writes snapshots with the same transaction as the current-row revision.
DO $$
BEGIN
  IF to_regclass('public.assistant_memory_item_revisions') IS NOT NULL THEN
    GRANT SELECT, INSERT ON TABLE public.assistant_memory_item_revisions TO astella_api, astella_worker;
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.assistant_memory_item_revisions FROM astella_api, astella_worker;
  END IF;
END
$$;

-- Memory tier changes are append-only audit events. Runtime roles can inspect
-- and append them, but cannot rewrite the history of a promotion/demotion.
DO $$
BEGIN
  IF to_regclass('public.assistant_memory_budget_events') IS NOT NULL THEN
    REVOKE ALL PRIVILEGES ON TABLE public.assistant_memory_budget_events FROM astella_api, astella_worker;
    GRANT SELECT, INSERT ON TABLE public.assistant_memory_budget_events TO astella_api, astella_worker;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.assistant_memory_budget_events FROM astella_api, astella_worker;
  END IF;
END
$$;

-- Persona history is an immutable account-scoped audit trail. Runtime roles may
-- append versions, but neither API nor worker may rewrite or remove old versions.
-- 方案 44 §5.4 的压缩冷却状态（0385）。
--
-- 为什么要在这里再写一遍：上面那句 `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
-- FROM astella_api, astella_worker` 是在**迁移之后**跑的，它会把各条迁移里逐表写的
-- GRANT 一并抹掉——本文件下面每个 DO 块都在补这个漏。0385 的迁移里写了
-- `GRANT … TO astella_worker`，但没在这里补，于是真库上 worker 访问该表直接
-- `permission denied for table agent_context_compaction_state`（实测），
-- 而压缩冷却与无进展状态——整条 §5.4 的记忆——就此静默失效。
DO $$
BEGIN
  IF to_regclass('public.agent_context_compaction_state') IS NOT NULL THEN
    -- 不动 astella_api：下面那道「API privilege matrix」守卫要求它对每一张
    -- 未列入例外的表都有 SELECT/INSERT/UPDATE/DELETE 且没有 TRUNCATE/REFERENCES/TRIGGER。
    -- 这里只补 worker——它在上面那句 `REVOKE ALL … FROM astella_api, astella_worker`
    -- 之后没有任何兜底。
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_context_compaction_state TO astella_worker;
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.companion_persona_profile_versions') IS NOT NULL THEN
    REVOKE ALL PRIVILEGES ON TABLE public.companion_persona_profile_versions FROM astella_api, astella_worker;
    GRANT SELECT, INSERT ON TABLE public.companion_persona_profile_versions TO astella_api, astella_worker;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.companion_persona_profile_versions FROM astella_api, astella_worker;
  END IF;
END
$$;

-- Diary selection output contains private worker state, not an API read model.
-- The broad API grant above is intentional for application tables, so revoke
-- this checkpoint explicitly on every post-migration role bootstrap.
DO $$
BEGIN
  IF to_regclass('public.companion_diary_generation_checkpoints') IS NOT NULL THEN
    REVOKE ALL PRIVILEGES ON TABLE public.companion_diary_generation_checkpoints FROM astella_api;
  END IF;
END
$$;

-- Exact model-input handoffs are private worker state, not an API read model.
DO $$
BEGIN
  IF to_regclass('public.companion_context_handoff_snapshots') IS NOT NULL THEN
    REVOKE ALL PRIVILEGES ON TABLE public.companion_context_handoff_snapshots FROM astella_api;
  END IF;
END
$$;

-- Failure spans are a private diagnostic read model: API may inspect them,
-- while only the worker records or closes a span.
DO $$
BEGIN
  IF to_regclass('public.companion_run_failure_spans') IS NOT NULL THEN
    REVOKE ALL PRIVILEGES ON TABLE public.companion_run_failure_spans FROM astella_api;
    GRANT SELECT ON TABLE public.companion_run_failure_spans TO astella_api;
  END IF;
END
$$;

-- Mind maps are immutable saved artifacts; model stages are worker-private.
DO $$ BEGIN
  IF to_regclass('public.note_mind_maps') IS NOT NULL THEN
    REVOKE ALL ON public.note_mind_maps FROM astella_api;
    GRANT SELECT ON public.note_mind_maps TO astella_api;
  END IF;
  IF to_regclass('public.note_mind_map_stages') IS NOT NULL THEN
    REVOKE ALL ON public.note_mind_map_stages FROM astella_api;
  END IF;
END $$;

-- Worker read set. Keep identity/session/benchmark tables out of this list.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspaces',
    'notes',
    'note_versions',
    'note_blocks',
    'note_image_assets',
    'sources',
    'source_segments',
    'validation_events',
    'review_schedules',
    'jobs',
    'search_documents',
    'ai_artifacts',
    'review_attempts',
    'validation_questions',
    'validation_assistance_exposures',
    'learning_unit_exposure',
    'learning_exposure_dependency_ledger',
    'companion_conversations',
    'companion_messages',
    'companion_turn_runs',
    -- Persona and its immutable history are account-scoped and protected by user_id RLS.
    'companion_persona_profiles',
    'companion_persona_profile_versions',
    'companion_context_handoff_snapshots',
    'companion_stream_events',
    'companion_action_proposals',
    -- Agent 方案：worker 读取 run 元数据（epoch/permission/settings）与审计面。
    'companion_agent_steps',
    'companion_agent_tool_calls',
    'companion_run_failure_spans',
    'user_companion_account_state',
    -- 0238：到点提醒表。`<here_and_now>` 里"下一条提醒"要读它，schedule/cancel
    -- 两个工具要写它。缺 SELECT 的表现不是报错给用户，而是她**看不见自己许的约**。
    'companion_reminders',
    -- 主动念头表。worker 每一轮都要读它（今日已送达几条、最近的去重向量），
    -- 也要写它（落候选、定稿文本/embedding、candidate→delivered/suppressed 状态）。
    -- 缺权限的表现不是"气泡少一条"，而是 **companion_thought job 三次重试全 dead**
    -- （permission denied 归 operational_error）——主动链在受限角色下整条静默停摆。
    -- 实机 2026-09-21：owner 工作区连着三个调度点 dead，`last_error` 全是
    -- `permission denied for table assistant_thoughts`，而 dev 库这张表此前
    -- 只对 api/migrator 授权。
    'assistant_thoughts',
    -- 0237：账号级 AI 同意与数据外发政策。`governance.ts` 现在每轮都要读它来决定
    -- 能不能出网；缺 SELECT 时 worker 不是"降级"，而是**所有 companion job 直接 dead**
    -- （permission denied 被归成 operational_error）。这张表在 roles.sql 里原本零覆盖，
    -- 是在重建容器权限后才暴露出来的——迁移里的 GRANT 会被下面的 REVOKE ALL 抹掉。
    'user_ai_settings',
    -- companion 处理器读取学习上下文与页面上下文（daily summary / grounded run）。
    'learning_runs',
    'learning_tasks',
    'learning_run_private_contracts',
    'assistant_page_contexts',
    -- 记忆提取器写投递箱后回读去重。
    'assistant_deliveries',
    -- tick / journey / sandbox / understanding 路径经 worker 角色读取的表。
    -- 与迁移授权对齐：roles.sql 是授权主源，遗漏会在 bootstrap 的 REVOKE ALL 后
    -- 变成 permission denied（例如 deterministic_structured 评估读 private solution）。
    'companion_account_invitations',
    'companion_journeys',
    'companion_sandbox_namespaces',
    -- The thought worker reads this space's proactive mute switch before
    -- speaking; the migration grant must survive the bootstrap REVOKE ALL.
    'companion_room_profiles',
    'learning_artifacts',
    'learning_run_events',
    'learning_run_idempotency',
    'learning_task_presentation_history',
    'learning_task_variants',
    -- 0296：争议表。到期复习判据（`packages/shared/review-consumable-target.ts`）
    -- 现在读它——§16.22「争议项不自动重新入队」在**读侧**的那一半就落在这条共享
    -- 判据上，伴星的到期读数与到期清单都走它。缺 SELECT 的表现不是报错，而是伴星
    -- 报出的到期数**比队列多**，还把一条正被质疑的目标照常念出来：worker 侧那三条
    -- 查询各自 catch 过错误，permission denied 到不了用户眼前。
    'assessment_disputes_v2',
    -- 无卡笔记目标的到期判据需要核对本人仍有效的笔记订阅。
    'review_subscriptions_v2',
    'understanding_change_sets',
    'understanding_projection_checkpoints',
    'understanding_route_plans',
    -- 0170/0173：桌宠人格与长期记忆上下文。
    'pet_profiles',
    'assistant_memory_items',
    'assistant_memory_embeddings',
    'companion_procedural_playbooks',
    'companion_method_revisions',
    'companion_method_uses',
    'assistant_memory_item_revisions',
    'assistant_memory_budget_events',
    'assistant_memory_source_suppressions',
    'memory_links',
    'conversation_summaries',
    'memory_usage_log',
    'companion_daily_summaries'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO astella_worker', table_name);
    END IF;
  END LOOP;
  IF to_regclass('public.assistant_memory_item_revisions') IS NOT NULL THEN
    GRANT SELECT, INSERT ON TABLE public.assistant_memory_item_revisions TO astella_worker;
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.assistant_memory_item_revisions FROM astella_worker;
  END IF;
  IF to_regclass('public.assistant_memory_budget_events') IS NOT NULL THEN
    GRANT SELECT, INSERT ON TABLE public.assistant_memory_budget_events TO astella_worker;
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.assistant_memory_budget_events FROM astella_worker;
  END IF;
  IF to_regclass('public.assistant_memory_source_suppressions') IS NOT NULL THEN
    -- Extract/admit and explicit forget both consult this immutable source fence.
    -- Keep migration 0330 grants after the bootstrap REVOKE ALL.
    GRANT SELECT, INSERT ON TABLE public.assistant_memory_source_suppressions TO astella_worker;
  END IF;

  -- Exact write privileges exercised by the current worker handlers.  The
  -- SELECT grants above are intentionally retained because RETURNING and
  -- conflict updates require read access to affected columns.
  FOREACH table_name IN ARRAY ARRAY[
    'review_schedules',
    'jobs',
    'search_documents'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT INSERT, UPDATE ON TABLE public.%I TO astella_worker',
        table_name
      );
    END IF;
  END LOOP;

  IF to_regclass('public.review_attempts') IS NOT NULL THEN
    GRANT UPDATE ON TABLE public.review_attempts TO astella_worker;
  END IF;

  IF to_regclass('public.validation_questions') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.validation_questions TO astella_worker;
  END IF;

  -- 0077/0078 授予 worker 的最小写权限镜像（roles.sql 是唯一授权源；
  -- 不镜像的话 post-migration 重跑会 REVOKE 迁移授予的权限并被矩阵"判对"）。
  IF to_regclass('public.learning_unit_exposure') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.learning_unit_exposure TO astella_worker;
  END IF;
  IF to_regclass('public.learning_exposure_dependency_ledger') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.learning_exposure_dependency_ledger TO astella_worker;
  END IF;
  -- P2/P5 companion runtime：worker 读取对话/run/action 状态，写入对话
  -- 结果和事件，并更新 API 已创建的 run/proposal/sequence 投影。
  IF to_regclass('public.companion_conversations') IS NOT NULL THEN
    GRANT UPDATE ON TABLE public.companion_conversations TO astella_worker;
  END IF;
  IF to_regclass('public.companion_messages') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.companion_messages TO astella_worker;
  END IF;
  IF to_regclass('public.companion_turn_runs') IS NOT NULL THEN
    GRANT UPDATE ON TABLE public.companion_turn_runs TO astella_worker;
  END IF;
  IF to_regclass('public.companion_context_handoff_snapshots') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.companion_context_handoff_snapshots TO astella_worker;
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.companion_context_handoff_snapshots FROM astella_worker;
  END IF;
  IF to_regclass('public.companion_run_failure_spans') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.companion_run_failure_spans TO astella_worker;
    REVOKE DELETE, TRUNCATE ON TABLE public.companion_run_failure_spans FROM astella_worker;
  END IF;
  IF to_regclass('public.companion_stream_events') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.companion_stream_events TO astella_worker;
  END IF;
  -- 0238：她答应下来的提醒。worker 要写（schedule_reminder / 到点兑现）也要改
  -- （cancel/missed），但不删行——fired 的提醒是"她说过做到"的凭据。
  IF to_regclass('public.companion_reminders') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.companion_reminders TO astella_worker;
  END IF;
  -- 主动念头：SELECT 在上面的读集合里，这里补写侧。INSERT=落候选，
  -- UPDATE=定稿文本/embedding 与 candidate→delivered/suppressed 的状态机。
  -- 不给 DELETE：念头历史是"她说过什么"的凭据，过期行由 api 侧的 TTL 任务处理。
  IF to_regclass('public.assistant_thoughts') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.assistant_thoughts TO astella_worker;
  END IF;
  -- Agent 方案 §5：高风险工具由 **worker** 冻结确认 proposal（旧链路由 API 创建，
  -- 因此这里此前只有 UPDATE）。缺 INSERT 会让所有需确认的写工具在受限角色下
  -- permission denied。worker 仍不删除会话/proposal 数据。
  IF to_regclass('public.companion_action_proposals') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.companion_action_proposals TO astella_worker;
  END IF;
  -- Agent 审计面：worker 写入步骤/工具调用行，并更新其终态（取消、过期回收、
  -- 确认结果回填由 API 侧更新，见 0215 的 api UPDATE 授权）。
  IF to_regclass('public.companion_agent_steps') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.companion_agent_steps TO astella_worker;
  END IF;
  IF to_regclass('public.companion_agent_tool_calls') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.companion_agent_tool_calls TO astella_worker;
  END IF;
  -- 记忆提取器投递箱：写入后回读去重。
  IF to_regclass('public.assistant_deliveries') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.assistant_deliveries TO astella_worker;
  END IF;

  -- 0173：companion_dialogue read/write phase 需要读取人格并维护记忆
  -- 投影；这些授权必须与上面的 worker 白名单一起由 bootstrap 重建。
  FOREACH table_name IN ARRAY ARRAY[
    'assistant_memory_items',
    'assistant_memory_embeddings',
    'memory_links',
    'conversation_summaries',
    'memory_usage_log',
    'companion_daily_summaries',
    'companion_diary_generation_checkpoints'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO astella_worker',
        table_name
      );
    END IF;
  END LOOP;
  IF to_regclass('public.pet_profiles') IS NOT NULL THEN
    -- 0178：worker 在对话终态写关系状态（interaction_count/familiarity/
    -- last_active_at），并由每日维护 tick 做 >14 天衰减。只给 SELECT 会让这条
    -- UPDATE 在 bootstrap 的 REVOKE ALL 之后静默跳过（调用点按"弱事实"吞错），
    -- 关系状态因此永远停在初值。
    GRANT SELECT, INSERT, UPDATE ON TABLE public.pet_profiles TO astella_worker;
  END IF;
  -- Preserve 0348's grants: memory revision triggers invalidate derived methods,
  -- and the worker's existing playbook handlers read, insert and update them.
  IF to_regclass('public.companion_procedural_playbooks') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.companion_procedural_playbooks TO astella_worker;
  END IF;
  IF to_regclass('public.companion_memory_organization_state') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.companion_memory_organization_state TO astella_worker;
  END IF;
  IF to_regclass('public.companion_memory_organization_leases') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.companion_memory_organization_leases TO astella_worker;
  END IF;
  IF to_regclass('public.companion_method_revisions') IS NOT NULL THEN
    GRANT SELECT, INSERT ON TABLE public.companion_method_revisions TO astella_api, astella_worker;
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.companion_method_revisions FROM astella_api, astella_worker;
  END IF;
  IF to_regclass('public.companion_method_uses') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.companion_method_uses TO astella_api;
    GRANT SELECT, INSERT ON TABLE public.companion_method_uses TO astella_worker;
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.companion_method_uses FROM astella_worker;
    REVOKE DELETE, TRUNCATE ON TABLE public.companion_method_uses FROM astella_api;
  END IF;
  IF to_regclass('public.companion_persona_profiles') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.companion_persona_profiles TO astella_worker;
  END IF;
  IF to_regclass('public.companion_persona_profile_versions') IS NOT NULL THEN
    GRANT SELECT, INSERT ON TABLE public.companion_persona_profile_versions TO astella_worker;
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.companion_persona_profile_versions FROM astella_worker;
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'ai_artifacts',
    'validation_events'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format('GRANT INSERT ON TABLE public.%I TO astella_worker', table_name);
    END IF;
  END LOOP;

  IF to_regclass('public.sources') IS NOT NULL THEN
    GRANT UPDATE ON TABLE public.sources TO astella_worker;
  END IF;
  IF to_regclass('public.source_segments') IS NOT NULL THEN
    GRANT INSERT, DELETE ON TABLE public.source_segments TO astella_worker;
  END IF;
  IF to_regclass('public.search_documents') IS NOT NULL THEN
    GRANT DELETE ON TABLE public.search_documents TO astella_worker;
  END IF;

  IF to_regclass('public.understanding_events') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.understanding_events TO astella_worker;
  END IF;
  IF to_regclass('public.ai_audit_log') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.ai_audit_log TO astella_worker;
  END IF;

  -- companion journey / metrics 写入（迁移授权镜像）
  FOREACH table_name IN ARRAY ARRAY[
    'companion_journey_pending_events',
    'learning_metric_events'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, INSERT ON TABLE public.%I TO astella_worker',
        table_name
      );
    END IF;
  END LOOP;

  -- learning 任务私有/披露/安全面写入
  FOREACH table_name IN ARRAY ARRAY[
    'companion_voice_artifacts',
    'learning_task_disclosure_profiles',
    'learning_task_private_solutions',
    'learning_task_safety_reports'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO astella_worker',
        table_name
      );
    END IF;
  END LOOP;

  -- 评估与处理 outbox 更新
  FOREACH table_name IN ARRAY ARRAY[
    'learning_assessments',
    'learning_run_processing_outbox'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, UPDATE ON TABLE public.%I TO astella_worker',
        table_name
      );
    END IF;
  END LOOP;

  -- V2 事件/revision/origins 追加写（迁移 0162/0166/0167 授权镜像）
  FOREACH table_name IN ARRAY ARRAY[
    'card_domain_events_v2',
    'learning_card_revisions_v2',
    'learning_objective_origins_v2',
    -- 0305/0306/0307（39d W7-4）：「今天这一批」的锁、首页「换一个／暂不处理」的略过行。
    -- **它们此前一直不在任何清单里**——表建了、迁移走了、RLS 策略也写了，但受限角色
    -- **没有授权**，于是被测路径一读就 `Failed query`。**新增表必须同时进这两个清单**，
    -- 而「加迁移时顺手加授权」不是自动的：漏了不会红在部署上，只红在被测路径的第一次读。
    'daily_review_batches_v2',
    'home_suggestion_dismissals_v2'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO astella_worker',
        table_name
      );
    END IF;
  END LOOP;

  -- ─── 方案 20 V2（迁移 0135/0138；与 0142 grant repair 对齐）──────────
  -- V2 管线以 astella_worker（NOBYPASSRLS）直查 V2 表。roles.sql 是唯一
  -- 授权源：不镜像的话每次 bootstrap 的 REVOKE ALL 会清掉 0135/0138 的
  -- 迁移授权并导致 worker 管线 permission denied。
  -- 16 张核心表 full CRUD（outbox claim/complete、runs/plans/candidates、
  -- objectives/revisions/cards/publications/reminders/receipts/events）。
  FOREACH table_name IN ARRAY ARRAY[
    'card_generation_runs_v2',
    'card_generation_plans_v2',
    'card_generation_candidates_v2',
    'learning_objectives_v2',
    'learning_objective_revisions_v2',
    'learning_cards_v2',
    'learning_card_publication_revisions_v2',
    'card_exposure_ledger_v2',
    'initial_validation_reminders_v2',
    'card_activation_receipts_v2',
    'card_generation_post_activation_consumptions',
    'card_generation_events_v2',
    'candidate_evidence_binding_plans_v2',
    'evidence_eligibility_states_v2',
    'card_generation_run_outbox_v2',
    'learning_target_snapshots_v2'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO astella_worker',
        table_name
      );
    END IF;
  END LOOP;

  -- capability state：worker 更新/读取 epoch（§18.1）
  IF to_regclass('public.card_content_capability_state') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.card_content_capability_state
      TO astella_worker;
  END IF;

  -- 管线写入/回读表（specs/input snapshots/evidence 域/equivalence/lineage/
  -- exposures/candidate quality+lineage+feedback）：worker SELECT + INSERT
  FOREACH table_name IN ARRAY ARRAY[
    'card_generation_semantic_specs_v2',
    'card_generation_input_snapshots_v2',
    'evidence_snapshots_v2',
    'evidence_quote_copies_v2',
    'evidence_redactions_v2',
    'semantic_support_reports_v2',
    'learning_objective_evidence_bindings_v2',
    'learning_objective_equivalence_reports_v2',
    'learning_objective_revision_equivalence_v2',
    'learning_objective_lineage_v2',
    'learning_exposures_v2',
    'card_candidate_quality_reports_v2',
    'card_candidate_feedback_v2',
    -- 0321–0324: independent note learning jobs read their saved result by
    -- generation_job_id before writing, then insert the completed artifact.
    'note_mind_maps',
    'note_mind_map_stages',
    'note_overviews',
    'note_annotations',
    'note_learning_artifacts',
    'note_expansion_tasks'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, INSERT ON TABLE public.%I TO astella_worker',
        table_name
      );
    END IF;
  END LOOP;
END
$$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO astella_worker;

-- SEC-01 expand phase: the Worker may cross workspace boundaries only through
-- these fixed queue functions.  The functions are created by migrations 0018
-- and 0022;
-- the pre-migration bootstrap pass safely skips them, while the post-migration
-- pass revokes ambient access and grants the exact signatures to Worker only.
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
  FROM PUBLIC, astella_api, astella_worker;

-- 扩展函数（pg_trgm / pgvector / …）是安装的库代码，不是应用面：它们的 EXECUTE
-- 默认来自 PUBLIC，上面的 REVOKE 会一并清掉，若不恢复，任何调用都会
-- permission denied（例如记忆去重用的 similarity(content, $n)）。逐个列举既易漏
-- 又是打地鼠，这里按 pg_depend.deptype='e'（属于扩展）整体恢复给两个受限角色。
-- 应用自有函数仍走下面的显式白名单。
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
    WHERE n.nspname = 'public'
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %s TO astella_migrator, astella_api, astella_worker', fn.signature
    );
  END LOOP;
END
$$;

DO $$
DECLARE
  fn record;
BEGIN
  IF to_regprocedure('public.astella_create_private_note_v1(uuid,uuid,uuid,uuid,text,text,jsonb,uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_create_private_note_v1(uuid,uuid,uuid,uuid,text,text,jsonb,uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.astella_create_private_note_v1(uuid,uuid,uuid,uuid,text,text,jsonb,uuid)
      TO astella_migrator, astella_api, astella_worker;
  END IF;
  IF to_regprocedure('public.astella_note_creation_scope_current(uuid,uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_note_creation_scope_current(uuid,uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.astella_note_creation_scope_current(uuid,uuid)
      TO astella_migrator,astella_api,astella_worker;
  END IF;
  IF to_regprocedure('public.astella_claim_jobs(integer,integer,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_claim_jobs(integer, integer, integer)
      FROM PUBLIC, astella_api;
    GRANT EXECUTE ON FUNCTION public.astella_claim_jobs(integer, integer, integer)
      TO astella_worker;
  END IF;

  IF to_regprocedure('public.astella_reap_stale_jobs(integer,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_reap_stale_jobs(integer, integer)
      FROM PUBLIC, astella_api;
    GRANT EXECUTE ON FUNCTION public.astella_reap_stale_jobs(integer, integer)
      TO astella_worker;
  END IF;

  IF to_regprocedure('public.astella_renew_job_lease(uuid,uuid,text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_renew_job_lease(uuid, uuid, text)
      FROM PUBLIC, astella_api;
    GRANT EXECUTE ON FUNCTION public.astella_renew_job_lease(uuid, uuid, text)
      TO astella_worker;
  END IF;

  IF to_regprocedure('public.astella_finish_job(uuid,uuid,text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_finish_job(uuid, uuid, text)
      FROM PUBLIC, astella_api;
    GRANT EXECUTE ON FUNCTION public.astella_finish_job(uuid, uuid, text)
      TO astella_worker;
  END IF;

  IF to_regprocedure('public.astella_fail_job(uuid,uuid,text,text,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_fail_job(uuid, uuid, text, text, integer)
      FROM PUBLIC, astella_api;
    GRANT EXECUTE ON FUNCTION public.astella_fail_job(uuid, uuid, text, text, integer)
      TO astella_worker;
  END IF;

  IF to_regprocedure('public.astella_queue_job_depth()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_queue_job_depth()
      FROM PUBLIC, astella_api;
    GRANT EXECUTE ON FUNCTION public.astella_queue_job_depth()
      TO astella_worker;
  END IF;
  IF to_regprocedure('public.astella_queue_oldest_pending_age()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_queue_oldest_pending_age()
      FROM PUBLIC, astella_api;
    GRANT EXECUTE ON FUNCTION public.astella_queue_oldest_pending_age()
      TO astella_worker;
  END IF;

  -- 桌宠记忆 embedding 写入需要 vector 类型 input function
  --（`'[...]'::vector` 走 vector_in 而非 vector 函数本身）。
  -- worker 是 embeddings 写入者；api 无写路径，不授权（api 白名单校验会
  -- 拒绝非白名单 EXECUTE）。
  IF to_regprocedure('public.vector_in(cstring,oid,integer)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.vector_in(cstring, oid, integer)
      TO astella_worker;
  END IF;
  IF to_regprocedure('public.vector(vector,integer,boolean)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.vector(vector, integer, boolean)
      TO astella_worker;
  END IF;

  -- 0171/0172/0174：方案 22 桌宠日记/记忆维护 SECURITY DEFINER 函数。
  -- roles.sql 的 REVOKE ALL ON ALL FUNCTIONS 会清掉迁移中的 GRANT EXECUTE，
  -- 必须在此重新授予，否则 worker 每分钟 tick 报 permission denied。
  IF to_regprocedure('public.astella_enqueue_companion_daily_summaries()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.astella_enqueue_companion_daily_summaries()
      TO astella_worker;
  END IF;
  IF to_regprocedure('public.astella_run_companion_memory_maintenance()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.astella_run_companion_memory_maintenance()
      TO astella_worker;
  END IF;
  -- 0217：失效 companion 确认的定时兜底回收（方案 §5）。同样必须镜像，
  -- 否则 bootstrap 后 worker 每轮 tick 都会 permission denied，过期确认
  -- 无人回收 → run 永久停在 waiting_for_confirmation 并锁死该会话。
  IF to_regprocedure('public.astella_reclaim_stale_companion_proposals()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.astella_reclaim_stale_companion_proposals()
      TO astella_worker;
  END IF;
  -- 0227/0231 念头批量生成入队 + 0232 孤儿 run 回收。两支都是 worker 侧定时器
  -- 调用的 SECURITY DEFINER 函数，缺授权时**不会有任何用户可见报错**：前者让
  -- assistant_thoughts 恒 0 行（"完全没感知到主动提醒"），后者让卡住的会话
  -- 永远停在"正在思考"。
  IF to_regprocedure('public.astella_enqueue_companion_thoughts()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.astella_enqueue_companion_thoughts()
      TO astella_worker;
  END IF;
  IF to_regprocedure('public.astella_reclaim_orphaned_companion_runs()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.astella_reclaim_orphaned_companion_runs()
      TO astella_worker;
  END IF;
  -- 0238：到点提醒认领。同样必须镜像，否则 worker 每分钟 tick 都 permission
  -- denied，而它一条日志都不会暴露给用户——"她答应提醒我却没有"就这么静默着。
  IF to_regprocedure('public.astella_fire_due_companion_reminders(integer)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.astella_fire_due_companion_reminders(integer)
      TO astella_worker;
  END IF;

  -- 0267：跨空间记忆铺开。`companion-memory-extractor` 在提升一条 global 记忆时
  -- 显式 SELECT 这一支，所以 worker 必须有 EXECUTE。
  --
  -- 这一条曾经漏过：0267 自己 GRANT 了，但本文件上面那句
  -- `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS ... FROM PUBLIC, astella_api, astella_worker`
  -- 会把迁移里的授权整个抹掉，只在**本文件重新 GRANT 过的**才活下来。而下面那份
  -- "预期权限"清单只抓**多出来的**授权、抓不到**缺失的**，所以 role-bootstrap 不报、
  -- 调用方又把它 catch 成一行 warn——症状是"另一个空间怎么不记得"，查无实据（doc 34 L8）。
  IF to_regprocedure('public.astella_fanout_global_companion_memory(uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.astella_fanout_global_companion_memory(uuid) OWNER TO astella_migrator;
    REVOKE ALL ON FUNCTION public.astella_fanout_global_companion_memory(uuid)
      FROM PUBLIC, astella_api;
    GRANT EXECUTE ON FUNCTION public.astella_fanout_global_companion_memory(uuid)
      TO astella_worker;
  END IF;
  IF to_regprocedure('public.astella_sync_global_companion_memory_copies()') IS NOT NULL THEN
    ALTER FUNCTION public.astella_sync_global_companion_memory_copies() OWNER TO astella_migrator;
  END IF;
  IF to_regprocedure('public.astella_fanout_agent_global_preference(uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.astella_fanout_agent_global_preference(uuid) OWNER TO astella_migrator;
    REVOKE ALL ON FUNCTION public.astella_fanout_agent_global_preference(uuid) FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_fanout_agent_global_preference(uuid) TO astella_api;
  END IF;
  -- 0343：worker 不获得 assistant_deliveries 的 UPDATE 权限，只能在一次记忆
  -- 遗忘/修订已完成后，调用这个带 owner/workspace/memory 三重约束的收尾函数。
  IF to_regprocedure('public.astella_close_companion_memory_delivery(uuid,uuid,uuid,text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_close_companion_memory_delivery(uuid, uuid, uuid, text)
      FROM PUBLIC, astella_api;
    GRANT EXECUTE ON FUNCTION public.astella_close_companion_memory_delivery(uuid, uuid, uuid, text)
      TO astella_worker;
  END IF;
  IF to_regprocedure('public.astella_move_companion_memory_budget_tier_v1(uuid,uuid,uuid,text,text,uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_move_companion_memory_budget_tier_v1(uuid, uuid, uuid, text, text, uuid)
      FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.astella_move_companion_memory_budget_tier_v1(uuid, uuid, uuid, text, text, uuid)
      TO astella_api, astella_worker;
  END IF;

  -- 0345–0362：回收区恢复、期限维护与记忆整理。上方的全量 REVOKE 会
  -- 清掉迁移授权；在这里按原有调用角色恢复，并与下面的允许/必需清单对账。
  FOR fn IN SELECT * FROM (VALUES
    ('public.astella_restore_companion_memory(uuid,uuid,uuid)', 'astella_api'),
    ('public.astella_purge_expired_companion_memory()', 'astella_api, astella_worker'),
    ('public.astella_companion_memory_retention_limits()', 'astella_api, astella_worker'),
    ('public.astella_enforce_companion_memory_retention()', 'astella_api, astella_worker'),
    ('public.astella_reclaim_stale_memory_organization_leases()', 'astella_worker'),
    ('public.astella_commit_memory_organization(uuid,uuid,text,text,integer)', 'astella_worker'),
    ('public.astella_enqueue_companion_memory_organize()', 'astella_worker'),
    ('public.astella_companion_memory_organization_thresholds()', 'astella_worker')
  ) AS required(signature, roles) LOOP
    IF to_regprocedure(fn.signature) IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s', fn.signature, fn.roles);
    END IF;
  END LOOP;

  -- 0273：成员退出/被移出时收掉该空间的记忆（doc 34 L38）。调用方是 astella_api
  -- （leave / removeMember 两条路），函数本身 SECURITY DEFINER 才能越过
  -- "app.user_id 必须等于行的 user_id" 那条策略——否则 owner 移人时恒匹配 0 行。
  -- 0276：解散协作空间（doc 34 L6 的 ②）。逐表清理由函数内部按 catalog 生成清单完成，
  -- 必须是 SECURITY DEFINER；发起者只有 astella_api（路由层已经判过 owner/个人空间两道门卫）。
  IF to_regprocedure('public.astella_dissolve_workspace(uuid,uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_dissolve_workspace(uuid, uuid)
      FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.astella_dissolve_workspace(uuid, uuid)
      TO astella_api;
  END IF;

  IF to_regprocedure('public.astella_retire_workspace_memories_on_departure(uuid,uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_retire_workspace_memories_on_departure(uuid, uuid)
      FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.astella_retire_workspace_memories_on_departure(uuid, uuid)
      TO astella_api;
  END IF;

  -- 0174：pgvector 距离函数（记忆向量检索由 worker 执行；api 检索也需调用）。
  -- vector 和 halfvec 签名均需授权。
  IF to_regprocedure('public.cosine_distance(vector,vector)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.cosine_distance(vector, vector)
      TO astella_worker;
    GRANT EXECUTE ON FUNCTION public.cosine_distance(vector, vector)
      TO astella_api;
  END IF;
  IF to_regprocedure('public.l2_distance(vector,vector)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.l2_distance(vector, vector)
      TO astella_worker;
    GRANT EXECUTE ON FUNCTION public.l2_distance(vector, vector)
      TO astella_api;
  END IF;
  IF to_regprocedure('public.inner_product(vector,vector)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.inner_product(vector, vector)
      TO astella_worker;
    GRANT EXECUTE ON FUNCTION public.inner_product(vector, vector)
      TO astella_api;
  END IF;
  IF to_regprocedure('public.cosine_distance(halfvec,halfvec)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.cosine_distance(halfvec, halfvec)
      TO astella_worker;
  END IF;
  IF to_regprocedure('public.l2_distance(halfvec,halfvec)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.l2_distance(halfvec, halfvec)
      TO astella_worker;
  END IF;
  IF to_regprocedure('public.inner_product(halfvec,halfvec)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.inner_product(halfvec, halfvec)
      TO astella_worker;
  END IF;

  -- 0098：TTL 清理函数经 SECURITY DEFINER（migrator owner BYPASSRLS）执行，
  -- 由 API 进程（server.ts 每 6 小时定时）调用——API 需要 EXECUTE。
  IF to_regprocedure('public.astella_purge_companion_audit_ttl(integer,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_purge_companion_audit_ttl(integer, integer)
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_purge_companion_audit_ttl(integer, integer)
      TO astella_api;
  END IF;
  IF to_regprocedure('public.astella_purge_invitation_ledger_ttl(integer,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_purge_invitation_ledger_ttl(integer, integer)
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_purge_invitation_ledger_ttl(integer, integer)
      TO astella_api;
  END IF;
  IF to_regprocedure('public.astella_purge_tutor_nonces_ttl(integer,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_purge_tutor_nonces_ttl(integer, integer)
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_purge_tutor_nonces_ttl(integer, integer)
      TO astella_api;
  END IF;

  IF to_regprocedure('public.astella_purge_expired_object_transfers()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_purge_expired_object_transfers() FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_purge_expired_object_transfers() TO astella_api;
  END IF;

  -- API 侧独占的 SECURITY DEFINER 函数（跨租户批处理 / TTL 清理 / journey 查询）。
  -- 同样必须镜像：REVOKE ALL ON ALL FUNCTIONS 会清掉迁移里的 GRANT EXECUTE，
  -- 而缺一个就整条功能 permission denied（此前依次暴露为：记忆去重 similarity、
  -- learning-run 处理 tick 的 claim/mark、voice artifact 与 stream event TTL、
  -- proactive delivery 清理、ai_audit_log 保留期清理、可恢复 journey 查询）。
  -- 逐条列出而非按前缀放行：worker 专用函数必须继续保持 api 无权（见下方校验）。
  -- 0286：轮次空闲暂停的候选预筛（SECURITY DEFINER／migrator owner BYPASSRLS 才能越过
  -- FORCE RLS 挑候选）。调用方是 API 进程里那条定时对账，**不给 worker**（D1 §6.5）。
  IF to_regprocedure('public.astella_note_rounds_idle_for_pause(integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_note_rounds_idle_for_pause(integer)
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_note_rounds_idle_for_pause(integer)
      TO astella_api;
  END IF;

  IF to_regprocedure('public.astella_claim_run_processing(text,integer,integer,timestamp with time zone)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_claim_run_processing(text, integer, integer, timestamp with time zone)
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_claim_run_processing(text, integer, integer, timestamp with time zone)
      TO astella_api;
  END IF;
  IF to_regprocedure('public.astella_mark_run_processing_processed(uuid,text,timestamp with time zone)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_mark_run_processing_processed(uuid, text, timestamp with time zone)
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_mark_run_processing_processed(uuid, text, timestamp with time zone)
      TO astella_api;
  END IF;
  IF to_regprocedure('public.astella_expire_pending_voice_artifacts(integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_expire_pending_voice_artifacts(integer)
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_expire_pending_voice_artifacts(integer)
      TO astella_api;
  END IF;
  IF to_regprocedure('public.astella_purge_companion_stream_events_ttl(integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_purge_companion_stream_events_ttl(integer)
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_purge_companion_stream_events_ttl(integer)
      TO astella_api;
  END IF;
  IF to_regprocedure('public.astella_purge_expired_proactive_deliveries(integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_purge_expired_proactive_deliveries(integer)
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_purge_expired_proactive_deliveries(integer)
      TO astella_api;
  END IF;
  IF to_regprocedure('public.astella_purge_old_ai_audit_log(integer,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_purge_old_ai_audit_log(integer, integer)
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_purge_old_ai_audit_log(integer, integer)
      TO astella_api;
  END IF;
  IF to_regprocedure('public.astella_find_resumable_companion_journey(uuid,uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_find_resumable_companion_journey(uuid, uuid)
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_find_resumable_companion_journey(uuid, uuid)
      TO astella_api;
  END IF;

  -- 0365：运维管理面板（/admin/*）的跨租户只读视图。
  --
  -- 与上面同族（SECURITY DEFINER／migrator owner BYPASSRLS／只给 api），但**不给
  -- worker** 的理由不同：worker 的队列健康度走它自己的 /metrics，那里有
  -- `astella_job_queue_depth{status}`。这四支回答的是另一个问题——
  -- 「哪一类**作业类型**在堆积」（0098 的既有函数只按 status 聚合，答不出）、
  -- 「最近哪条作业失败了」、「谁刚做了高危动作」，都是运维视角的全局事实。
  -- 让 worker 读审计没有对应调用方，因此按 job/queue 那一族的先例不给。
  IF to_regprocedure('public.astella_admin_job_backlog()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_admin_job_backlog()
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_admin_job_backlog()
      TO astella_api;
  END IF;
  IF to_regprocedure('public.astella_admin_recent_job_failures(integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_admin_recent_job_failures(integer)
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_admin_recent_job_failures(integer)
      TO astella_api;
  END IF;
  IF to_regprocedure('public.astella_admin_recent_audit(integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_admin_recent_audit(integer)
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_admin_recent_audit(integer)
      TO astella_api;
  END IF;
  IF to_regprocedure('public.astella_admin_platform_counts()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_admin_platform_counts()
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_admin_platform_counts()
      TO astella_api;
  END IF;

  -- 0366：运维面板的**写**操作（重试失败作业 / 清理死信）。
  -- 同样只给 api 不给 worker：人工重试与删除是运维的决定，不是队列消费者的事。
  IF to_regprocedure('public.astella_admin_retry_failed_jobs(text,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_admin_retry_failed_jobs(text, integer)
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_admin_retry_failed_jobs(text, integer)
      TO astella_api;
  END IF;
  IF to_regprocedure('public.astella_admin_purge_dead_jobs(text,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_admin_purge_dead_jobs(text, integer)
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_admin_purge_dead_jobs(text, integer)
      TO astella_api;
  END IF;

  -- 2026-09-29（P0-4，`users` 表 RLS）：两支 `users` 策略要用的窄口径函数。
  --
  -- `astella_find_user_by_email` 是登录路径：登录发生在会话建立**之前**，
  -- app.user_id / app.workspace_id 都还没设，裸查表必然被 RLS 挡成 0 行
  -- ——那就是"所有人都登不进来"。
  -- `astella_user_in_workspace` 是策略 2.3 的判据：**必须** SECURITY DEFINER，
  -- 因为 workspace_members 自己有 RLS，策略里写裸 EXISTS 会被它收窄成
  -- "只看自己那一行"，于是同空间的其他成员读不到（invite-service 批量取 email 会空）。
  IF to_regprocedure('public.astella_find_user_by_email(text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_find_user_by_email(text)
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_find_user_by_email(text)
      TO astella_api;
  END IF;

  IF to_regprocedure('public.astella_user_in_workspace(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_user_in_workspace(uuid, uuid)
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_user_in_workspace(uuid, uuid)
      TO astella_api;
  END IF;

  -- Exact model input is available only through a run-owner-scoped replay
  -- function; direct API access to the worker snapshot table remains revoked.
  IF to_regprocedure('public.astella_read_companion_turn_handoff_snapshot_v1(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.astella_read_companion_turn_handoff_snapshot_v1(uuid)
      FROM PUBLIC, astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_read_companion_turn_handoff_snapshot_v1(uuid)
      TO astella_api;
  END IF;
END
$$;

-- Drizzle readiness only needs to inspect the journal.  The worker does not
-- need migration metadata and therefore receives no drizzle-schema grant.
--
-- 这一块原先整个包在 `IF journal 表已存在` 里，而 role-bootstrap 跑在 migrate
-- **之前**——全新卷上那张表还不存在，于是 api 拿不到 drizzle 的任何权限，
-- 第一次 `make up` 必然 unhealthy，得再 up 一次（init 容器被删掉重跑）才补上。
-- 现在不依赖先后：schema 是本文件上面建的，USAGE 直接授；journal 表由 migrate
-- 之后创建，用 DEFAULT PRIVILEGES 覆盖它。**两条都要**：生产由 astella_migrator
-- 建表，而 dev 的 DATABASE_URL_MIGRATOR 指向超级用户 astella（见 docker-compose.dev.yml
-- 的 &dev-database 锚点），只写 migrator 那条在 dev 上正好落空。
-- 保留 DO 块：更早的库里表已经存在时，默认权限管不到它。
GRANT USAGE ON SCHEMA drizzle TO astella_api;
ALTER DEFAULT PRIVILEGES FOR ROLE astella_migrator IN SCHEMA drizzle
  GRANT SELECT ON TABLES TO astella_api;
ALTER DEFAULT PRIVILEGES FOR ROLE astella IN SCHEMA drizzle
  GRANT SELECT ON TABLES TO astella_api;
DO $$
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    GRANT SELECT ON TABLE drizzle.__drizzle_migrations TO astella_api;
    GRANT ALL PRIVILEGES ON TABLE drizzle.__drizzle_migrations TO astella_migrator;
  END IF;
END
$$;

-- New objects created by the migrator receive the same baseline defaults.
ALTER DEFAULT PRIVILEGES FOR ROLE astella_migrator IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE astella_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO astella_api;
ALTER DEFAULT PRIVILEGES FOR ROLE astella_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO astella_api;
ALTER DEFAULT PRIVILEGES FOR ROLE astella_migrator IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE astella_migrator IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Worker privileges are deliberately not granted by default.  This script is
-- re-applied after migrations, so a newly introduced table remains invisible
-- until its handler access is added to the explicit matrix above.

-- Application enums are used in query parameters and therefore need USAGE.
DO $$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT n.nspname, t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typtype IN ('e', 'd')
  LOOP
    EXECUTE format(
      'GRANT USAGE ON TYPE %I.%I TO astella_api, astella_worker',
      obj.nspname, obj.typname
    );
    EXECUTE format(
      'GRANT USAGE ON TYPE %I.%I TO astella_migrator',
      obj.nspname, obj.typname
    );
  END LOOP;
END
$$;

-- Unified Agent host tables retain their explicit worker grants after bootstrap.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['agent_runs','agent_operations','agent_run_steps','agent_run_events'] LOOP
    IF to_regclass(format('public.%I',t)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE public.%I TO astella_worker',t);
    END IF;
  END LOOP;
  IF to_regclass('public.agent_run_events_seq_seq') IS NOT NULL THEN
    GRANT USAGE,SELECT ON SEQUENCE public.agent_run_events_seq_seq TO astella_worker;
  END IF;
  FOREACH t IN ARRAY ARRAY['astella_agent_scope_current(uuid,uuid)','astella_enqueue_agent_recovery()',
    'astella_create_private_note_v1(uuid,uuid,uuid,uuid,text,text,jsonb,uuid)',
    'astella_pending_companion_note_edits_v1()',
    'astella_note_creation_scope_current(uuid,uuid)',
    'astella_cancel_agent_operations(uuid,integer)','astella_agent_job_current(uuid,uuid,uuid,boolean)',
    'astella_agent_run_authorized(uuid)',
    'astella_agent_card_job_current(uuid,uuid,boolean)',
    'astella_agent_card_execution_binding(uuid,uuid)',
    'astella_propagate_playbook_evidence_change()',
    'astella_enforce_companion_memory_retention()',
    'astella_companion_memory_retention_limits()',
    'astella_commit_memory_organization(uuid,uuid,text,text,integer)',
    'astella_agent_card_run_event()','astella_agent_job_event()'] LOOP
    IF to_regprocedure('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s OWNER TO astella_migrator',to_regprocedure('public.' || t));
    END IF;
  END LOOP;
  IF to_regprocedure('public.astella_pending_companion_note_edits_v1()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.astella_pending_companion_note_edits_v1() TO astella_api;
  END IF;
  IF to_regprocedure('public.astella_enqueue_agent_recovery()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.astella_agent_scope_current(uuid,uuid) TO astella_api,astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_enqueue_agent_recovery() TO astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_cancel_agent_operations(uuid,integer) TO astella_api,astella_worker;
    GRANT EXECUTE ON FUNCTION public.astella_agent_job_current(uuid,uuid,uuid,boolean) TO astella_worker;
  END IF;
  IF to_regprocedure('public.astella_agent_run_authorized(uuid)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.astella_agent_run_authorized(uuid) TO astella_worker;
  END IF;
  IF to_regprocedure('public.astella_agent_method_sources_current(uuid,uuid,uuid)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.astella_agent_method_sources_current(uuid,uuid,uuid) TO astella_api, astella_worker;
  END IF;
  -- 升级前的 roles 引导也会执行：0373 尚未安装时跳过新函数。
  IF to_regprocedure('public.astella_agent_card_job_current(uuid,uuid,boolean)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.astella_agent_card_job_current(uuid,uuid,boolean) TO astella_worker;
  END IF;
  IF to_regprocedure('public.astella_agent_card_execution_binding(uuid,uuid)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.astella_agent_card_execution_binding(uuid,uuid) TO astella_worker;
  END IF;
  -- 触发器函数（jobs 上的 agent_job_event、制卡 run 上的 agent_card_run_event）不给任何
  -- 角色 EXECUTE：触发执行不查 session 用户的权限。
END $$;

-- Executable least-privilege verification.  Keeping this next to the grants
-- makes the production role-grants service fail before API/Worker start if a
-- future schema or grant change expands access unexpectedly.
DO $$
DECLARE
  mismatch text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'astella_migrator'
      AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolinherit AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'astella_migrator role attributes are invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('astella_api', 'astella_worker')
      AND (
        NOT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole
        OR rolinherit OR rolbypassrls
      )
  ) OR (
    SELECT count(*) FROM pg_roles
    WHERE rolname IN ('astella_api', 'astella_worker')
  ) <> 2 THEN
    RAISE EXCEPTION 'API/Worker role attributes are invalid';
  END IF;

  IF NOT has_database_privilege(
    'astella_migrator', current_database(), 'CREATE'
  ) OR NOT has_schema_privilege(
    'astella_migrator', 'public', 'CREATE'
  ) THEN
    RAISE EXCEPTION 'migrator is missing database/schema DDL privileges';
  END IF;
  IF has_database_privilege('astella_api', current_database(), 'CREATE')
    OR has_database_privilege('astella_worker', current_database(), 'CREATE')
    OR has_schema_privilege('astella_api', 'public', 'CREATE')
    OR has_schema_privilege('astella_worker', 'public', 'CREATE')
  THEN
    RAISE EXCEPTION 'API/Worker unexpectedly have DDL privileges';
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ')
  INTO mismatch
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'drizzle')
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND pg_get_userbyid(c.relowner) <> 'astella_migrator'
    AND NOT EXISTS (
      SELECT 1
      FROM pg_depend d
      WHERE d.classid = 'pg_class'::regclass
        AND d.objid = c.oid
        AND d.deptype = 'e'
    );
  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'non-migrator object owners: %', mismatch;
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ')
  INTO mismatch
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relname NOT IN (
      'note_mind_maps',
      'note_mind_map_stages',
      'companion_diary_generation_checkpoints',
      'companion_context_handoff_snapshots',
      'companion_run_failure_spans',
      'assistant_memory_item_revisions',
      'companion_method_revisions',
      'companion_method_uses',
      'agent_run_revisions',
      'assistant_memory_budget_events',
      'companion_persona_profile_versions'
    )
    AND (
      NOT has_table_privilege(
        'astella_api', format('%I.%I', n.nspname, c.relname), 'SELECT'
      )
      OR NOT has_table_privilege(
        'astella_api', format('%I.%I', n.nspname, c.relname), 'INSERT'
      )
      OR NOT has_table_privilege(
        'astella_api', format('%I.%I', n.nspname, c.relname), 'UPDATE'
      )
      OR NOT has_table_privilege(
        'astella_api', format('%I.%I', n.nspname, c.relname), 'DELETE'
      )
      OR has_table_privilege(
        'astella_api', format('%I.%I', n.nspname, c.relname), 'TRUNCATE'
      )
      OR has_table_privilege(
        'astella_api', format('%I.%I', n.nspname, c.relname), 'REFERENCES'
      )
      OR has_table_privilege(
        'astella_api', format('%I.%I', n.nspname, c.relname), 'TRIGGER'
      )
    );
  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'API privilege matrix mismatch: %', mismatch;
  END IF;

  SELECT string_agg(format('%I.%I',n.nspname,c.relname), ', ') INTO mismatch
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN ('companion_method_revisions','companion_method_uses') AND (
    NOT has_table_privilege('astella_api',c.oid,'SELECT')
    OR NOT has_table_privilege('astella_api',c.oid,'INSERT')
    OR has_table_privilege('astella_api',c.oid,'UPDATE') <> (c.relname='companion_method_uses')
    OR has_table_privilege('astella_api',c.oid,'DELETE')
    OR has_table_privilege('astella_api',c.oid,'TRUNCATE')
    OR has_table_privilege('astella_api',c.oid,'REFERENCES')
    OR has_table_privilege('astella_api',c.oid,'TRIGGER')
  );
  IF mismatch IS NOT NULL THEN RAISE EXCEPTION 'API method history/feedback privilege matrix mismatch: %',mismatch; END IF;

  IF to_regclass('public.companion_run_failure_spans') IS NOT NULL AND (
    NOT has_table_privilege('astella_api', 'public.companion_run_failure_spans', 'SELECT')
    OR has_table_privilege('astella_api', 'public.companion_run_failure_spans', 'INSERT')
    OR has_table_privilege('astella_api', 'public.companion_run_failure_spans', 'UPDATE')
    OR has_table_privilege('astella_api', 'public.companion_run_failure_spans', 'DELETE')
    OR has_table_privilege('astella_api', 'public.companion_run_failure_spans', 'TRUNCATE')
    OR has_table_privilege('astella_api', 'public.companion_run_failure_spans', 'REFERENCES')
    OR has_table_privilege('astella_api', 'public.companion_run_failure_spans', 'TRIGGER')
  ) THEN
    RAISE EXCEPTION 'companion failure spans must be read-only for API';
  END IF;

  IF to_regclass('public.assistant_memory_item_revisions') IS NOT NULL AND (
    NOT has_table_privilege('astella_api', 'public.assistant_memory_item_revisions', 'SELECT')
    OR NOT has_table_privilege('astella_api', 'public.assistant_memory_item_revisions', 'INSERT')
    OR has_table_privilege('astella_api', 'public.assistant_memory_item_revisions', 'UPDATE')
    OR has_table_privilege('astella_api', 'public.assistant_memory_item_revisions', 'DELETE')
    OR has_table_privilege('astella_api', 'public.assistant_memory_item_revisions', 'TRUNCATE')
    OR has_table_privilege('astella_api', 'public.assistant_memory_item_revisions', 'REFERENCES')
    OR has_table_privilege('astella_api', 'public.assistant_memory_item_revisions', 'TRIGGER')
  ) THEN
    RAISE EXCEPTION 'assistant memory revisions must be append-only for API';
  END IF;

  IF to_regclass('public.assistant_memory_budget_events') IS NOT NULL AND (
    NOT has_table_privilege('astella_api', 'public.assistant_memory_budget_events', 'SELECT')
    OR NOT has_table_privilege('astella_api', 'public.assistant_memory_budget_events', 'INSERT')
    OR has_table_privilege('astella_api', 'public.assistant_memory_budget_events', 'UPDATE')
    OR has_table_privilege('astella_api', 'public.assistant_memory_budget_events', 'DELETE')
    OR has_table_privilege('astella_api', 'public.assistant_memory_budget_events', 'TRUNCATE')
    OR has_table_privilege('astella_api', 'public.assistant_memory_budget_events', 'REFERENCES')
    OR has_table_privilege('astella_api', 'public.assistant_memory_budget_events', 'TRIGGER')
    OR NOT has_table_privilege('astella_worker', 'public.assistant_memory_budget_events', 'SELECT')
    OR NOT has_table_privilege('astella_worker', 'public.assistant_memory_budget_events', 'INSERT')
    OR has_table_privilege('astella_worker', 'public.assistant_memory_budget_events', 'UPDATE')
    OR has_table_privilege('astella_worker', 'public.assistant_memory_budget_events', 'DELETE')
    OR has_table_privilege('astella_worker', 'public.assistant_memory_budget_events', 'TRUNCATE')
    OR has_table_privilege('astella_worker', 'public.assistant_memory_budget_events', 'REFERENCES')
    OR has_table_privilege('astella_worker', 'public.assistant_memory_budget_events', 'TRIGGER')
  ) THEN
    RAISE EXCEPTION 'assistant memory budget events must be append-only for API and worker';
  END IF;

  IF to_regclass('public.companion_persona_profile_versions') IS NOT NULL AND (
    NOT has_table_privilege('astella_api', 'public.companion_persona_profile_versions', 'SELECT')
    OR NOT has_table_privilege('astella_api', 'public.companion_persona_profile_versions', 'INSERT')
    OR has_table_privilege('astella_api', 'public.companion_persona_profile_versions', 'UPDATE')
    OR has_table_privilege('astella_api', 'public.companion_persona_profile_versions', 'DELETE')
    OR has_table_privilege('astella_api', 'public.companion_persona_profile_versions', 'TRUNCATE')
    OR has_table_privilege('astella_api', 'public.companion_persona_profile_versions', 'REFERENCES')
    OR has_table_privilege('astella_api', 'public.companion_persona_profile_versions', 'TRIGGER')
    OR NOT has_table_privilege('astella_worker', 'public.companion_persona_profile_versions', 'SELECT')
    OR NOT has_table_privilege('astella_worker', 'public.companion_persona_profile_versions', 'INSERT')
    OR has_table_privilege('astella_worker', 'public.companion_persona_profile_versions', 'UPDATE')
    OR has_table_privilege('astella_worker', 'public.companion_persona_profile_versions', 'DELETE')
    OR has_table_privilege('astella_worker', 'public.companion_persona_profile_versions', 'TRUNCATE')
    OR has_table_privilege('astella_worker', 'public.companion_persona_profile_versions', 'REFERENCES')
    OR has_table_privilege('astella_worker', 'public.companion_persona_profile_versions', 'TRIGGER')
  ) THEN
    RAISE EXCEPTION 'companion persona profile versions must be append-only for API and worker';
  END IF;

  IF to_regclass('public.companion_diary_generation_checkpoints') IS NOT NULL AND (
    has_table_privilege(
      'astella_api', 'public.companion_diary_generation_checkpoints', 'SELECT'
    ) OR has_table_privilege(
      'astella_api', 'public.companion_diary_generation_checkpoints', 'INSERT'
    ) OR has_table_privilege(
      'astella_api', 'public.companion_diary_generation_checkpoints', 'UPDATE'
    ) OR has_table_privilege(
      'astella_api', 'public.companion_diary_generation_checkpoints', 'DELETE'
    ) OR has_table_privilege(
      'astella_api', 'public.companion_diary_generation_checkpoints', 'TRUNCATE'
    ) OR has_table_privilege(
      'astella_api', 'public.companion_diary_generation_checkpoints', 'REFERENCES'
    ) OR has_table_privilege(
      'astella_api', 'public.companion_diary_generation_checkpoints', 'TRIGGER'
    )
  ) THEN
    RAISE EXCEPTION 'API unexpectedly has access to worker-only diary checkpoints';
  END IF;

  IF to_regclass('public.companion_context_handoff_snapshots') IS NOT NULL AND (
    has_table_privilege('astella_api', 'public.companion_context_handoff_snapshots', 'SELECT')
    OR has_table_privilege('astella_api', 'public.companion_context_handoff_snapshots', 'INSERT')
    OR has_table_privilege('astella_api', 'public.companion_context_handoff_snapshots', 'UPDATE')
    OR has_table_privilege('astella_api', 'public.companion_context_handoff_snapshots', 'DELETE')
    OR has_table_privilege('astella_api', 'public.companion_context_handoff_snapshots', 'TRUNCATE')
    OR has_table_privilege('astella_api', 'public.companion_context_handoff_snapshots', 'REFERENCES')
    OR has_table_privilege('astella_api', 'public.companion_context_handoff_snapshots', 'TRIGGER')
  ) THEN
    RAISE EXCEPTION 'API unexpectedly has access to worker-only companion handoff snapshots';
  END IF;

  IF to_regprocedure('public.astella_read_companion_turn_handoff_snapshot_v1(uuid)') IS NOT NULL AND (
    NOT has_function_privilege(
      'astella_api',
      'public.astella_read_companion_turn_handoff_snapshot_v1(uuid)',
      'EXECUTE'
    )
    OR has_function_privilege(
      'astella_worker',
      'public.astella_read_companion_turn_handoff_snapshot_v1(uuid)',
      'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'private turn replay function privilege matrix mismatch';
  END IF;

  IF to_regclass('public.note_mind_maps') IS NOT NULL AND (
    NOT has_table_privilege('astella_api','public.note_mind_maps','SELECT')
    OR has_table_privilege('astella_api','public.note_mind_maps','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  ) THEN RAISE EXCEPTION 'mind map artifact must be read-only for API'; END IF;
  IF to_regclass('public.note_mind_map_stages') IS NOT NULL AND has_table_privilege(
    'astella_api','public.note_mind_map_stages','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) THEN RAISE EXCEPTION 'mind map checkpoint must be private to worker'; END IF;

  WITH expected(
    table_name, can_select, can_insert, can_update, can_delete
  ) AS (
    VALUES
      ('workspaces', true, false, false, false),
      ('notes', true, false, false, false),
      ('note_versions', true, false, false, false),
      ('note_blocks', true, false, false, false),
      ('note_mind_maps', true, true, false, false),
      ('note_mind_map_stages', true, true, false, false),
      ('note_overviews', true, true, false, false),
      ('note_annotations', true, true, false, false),
      ('note_learning_artifacts', true, true, false, false),
      ('note_expansion_tasks', true, true, false, false),
      ('note_image_assets', true, false, false, false),
      ('sources', true, false, true, false),
      ('source_segments', true, true, false, true),
      ('validation_events', true, true, false, false),
      ('review_schedules', true, true, true, false),
      ('jobs', true, true, true, false),
      ('search_documents', true, true, true, true),
      ('ai_artifacts', true, true, false, false),
      ('review_attempts', true, false, true, false),
      ('validation_questions', true, true, false, false),
      ('validation_assistance_exposures', true, false, false, false),
      ('learning_unit_exposure', true, true, true, false),
      ('learning_exposure_dependency_ledger', true, true, true, false),
      ('companion_conversations', true, false, true, false),
      ('companion_messages', true, true, false, false),
      ('companion_turn_runs', true, false, true, false),
      ('companion_persona_profiles', true, true, true, false),
      ('companion_persona_profile_versions', true, true, false, false),
      ('companion_stream_events', true, true, true, false),
      -- Agent 方案 §5：worker 冻结确认 proposal（INSERT）。
      ('companion_action_proposals', true, true, true, false),
      -- Agent 方案 §6：worker 写步骤/工具调用审计行并更新其终态。
      ('companion_agent_steps', true, true, true, false),
      ('companion_agent_tool_calls', true, true, true, false),
      ('companion_run_failure_spans', true, true, true, false),
      -- Exact model inputs are worker-only, append-only snapshots.
      ('companion_context_handoff_snapshots', true, true, false, false),
      -- Agent run 元数据（epoch / permission / agent_settings）只读。
      ('user_companion_account_state', true, false, false, false),
      -- 0238：到点提醒。读（"下一条提醒"进 `<here_and_now>`）+ 写 + 改状态，不删行。
      ('companion_reminders', true, true, true, false),
      -- 主动念头：读（今日已送达条数、去重用的近期 embedding）+ 写候选 + 改状态/定稿。
      -- 缺任何一项都不是"少一条气泡"，而是 companion_thought job 全 dead。
      ('assistant_thoughts', true, true, true, false),
      -- 0237：AI 同意/数据政策，worker 只读（签署与修改是 api 侧的事）。
      ('user_ai_settings', true, false, false, false),
      -- companion 处理器的学习上下文读取面。
      ('learning_runs', true, false, false, false),
      ('learning_tasks', true, false, false, false),
      ('learning_run_private_contracts', true, false, false, false),
      ('assistant_page_contexts', true, false, false, false),
      -- 记忆提取器投递箱：写入后回读去重。
      ('assistant_deliveries', true, true, false, false),
      ('companion_account_invitations', true, false, false, false),
      ('companion_journeys', true, false, false, false),
      ('companion_sandbox_namespaces', true, false, false, false),
      ('companion_room_profiles', true, false, false, false),
      ('learning_artifacts', true, false, false, false),
      ('learning_run_events', true, false, false, false),
      ('learning_run_idempotency', true, false, false, false),
      ('learning_task_presentation_history', true, false, false, false),
      ('learning_task_variants', true, false, false, false),
      ('understanding_change_sets', true, false, false, false),
      ('understanding_projection_checkpoints', true, false, false, false),
      ('understanding_route_plans', true, false, false, false),
      ('companion_journey_pending_events', true, true, false, false),
      ('learning_metric_events', true, true, false, false),
      ('companion_voice_artifacts', true, true, true, false),
      ('learning_task_disclosure_profiles', true, true, true, false),
      ('learning_task_private_solutions', true, true, true, false),
      ('learning_task_safety_reports', true, true, true, false),
      ('learning_assessments', true, false, true, false),
      ('learning_run_processing_outbox', true, false, true, false),
      ('card_domain_events_v2', true, true, true, true),
      ('learning_card_revisions_v2', true, true, true, true),
      ('learning_objective_origins_v2', true, true, true, true),
      -- 0305/0306/0307（39d W7-4）：与上面同一组。这两张表**只有本人那一侧读写**
      -- （worker 那一支不进），所以四列都给。
      ('daily_review_batches_v2', true, true, true, true),
      ('home_suggestion_dismissals_v2', true, true, true, true),
      -- 0170/0173 只给 SELECT；0178 补 INSERT/UPDATE（关系状态写入 + 每日衰减）。
      ('pet_profiles', true, true, true, false),
      ('assistant_memory_items', true, true, true, true),
      ('companion_procedural_playbooks', true, true, true, false),
      ('companion_memory_organization_state', true, true, true, false),
      ('companion_memory_organization_leases', true, true, true, true),
      ('companion_method_revisions', true, true, false, false),
      ('companion_method_uses', true, true, false, false),
      ('assistant_memory_item_revisions', true, true, false, false),
      ('agent_run_revisions', true, true, false, false),
      ('agent_runs', true, true, true, false),
      ('agent_operations', true, true, true, false),
      ('agent_run_steps', true, true, true, false),
      ('agent_run_events', true, true, true, false),
      -- 0385（方案 44 §5.4）：压缩失败的冷却与无进展状态。worker 是唯一读点，
      -- 四列都给（含 DELETE：按会话清历史时那份状态必须一起消失）。
      -- **必须同时列在这里**：上面那个 DO 块只补了 GRANT，而这张「期望矩阵」
      -- 才是判对错的那一半——缺了这一行，实际权限 true 对期望 false，
      -- worker 授权矩阵直接报 mismatch（2026-10-06 实测）。
      ('agent_context_compaction_state', true, true, true, true),
      ('assistant_memory_budget_events', true, true, false, false),
      ('assistant_memory_source_suppressions', true, true, false, false),
      ('assistant_memory_embeddings', true, true, true, true),
      ('memory_links', true, true, true, true),
      ('conversation_summaries', true, true, true, true),
      ('memory_usage_log', true, true, true, true),
      ('companion_daily_summaries', true, true, true, true),
      ('companion_diary_generation_checkpoints', true, true, true, true),
      ('understanding_events', false, true, false, false),
      ('ai_audit_log', false, true, false, false),
      -- 方案 20 V2（迁移 0135/0138；与 grant 授权镜像一致）
      ('card_generation_runs_v2', true, true, true, true),
      ('card_generation_plans_v2', true, true, true, true),
      ('card_generation_candidates_v2', true, true, true, true),
      ('learning_objectives_v2', true, true, true, true),
      ('learning_objective_revisions_v2', true, true, true, true),
      ('learning_cards_v2', true, true, true, true),
      ('learning_card_publication_revisions_v2', true, true, true, true),
      ('card_exposure_ledger_v2', true, true, true, true),
      ('initial_validation_reminders_v2', true, true, true, true),
      ('card_activation_receipts_v2', true, true, true, true),
      ('card_generation_post_activation_consumptions', true, true, true, true),
      ('card_generation_events_v2', true, true, true, true),
      ('candidate_evidence_binding_plans_v2', true, true, true, true),
      ('evidence_eligibility_states_v2', true, true, true, true),
      ('card_generation_run_outbox_v2', true, true, true, true),
      ('learning_target_snapshots_v2', true, true, true, true),
      ('card_content_capability_state', true, true, true, false),
      ('card_generation_semantic_specs_v2', true, true, false, false),
      ('card_generation_input_snapshots_v2', true, true, false, false),
      ('evidence_snapshots_v2', true, true, false, false),
      ('evidence_quote_copies_v2', true, true, false, false),
      ('evidence_redactions_v2', true, true, false, false),
      ('semantic_support_reports_v2', true, true, false, false),
      ('learning_objective_evidence_bindings_v2', true, true, false, false),
      ('learning_objective_equivalence_reports_v2', true, true, false, false),
      ('learning_objective_revision_equivalence_v2', true, true, false, false),
      ('learning_objective_lineage_v2', true, true, false, false),
      ('learning_exposures_v2', true, true, false, false),
      ('card_candidate_quality_reports_v2', true, true, false, false),
      ('card_candidate_feedback_v2', true, true, false, false),
      -- 0296：**只读**。worker 侧唯一的读点是到期复习判据里那个
      -- `NOT EXISTS (... assessment_disputes_v2 ...)`（§16.22 读侧）。
      -- 不给 INSERT/UPDATE/DELETE：开争议与复核都只由 API 的 run-disputes 做，
      -- worker 写它就是绕开"一个判定至多一份争议"与"复核至多一次"那两条库级闸。
      ('assessment_disputes_v2', true, false, false, false),
      ('review_subscriptions_v2', true, false, false, false)
  ), actual AS (
    SELECT
      c.relname AS table_name,
      has_table_privilege(
        'astella_worker', format('%I.%I', n.nspname, c.relname), 'SELECT'
      ) AS can_select,
      has_table_privilege(
        'astella_worker', format('%I.%I', n.nspname, c.relname), 'INSERT'
      ) AS can_insert,
      has_table_privilege(
        'astella_worker', format('%I.%I', n.nspname, c.relname), 'UPDATE'
      ) AS can_update,
      has_table_privilege(
        'astella_worker', format('%I.%I', n.nspname, c.relname), 'DELETE'
      ) AS can_delete,
      has_table_privilege(
        'astella_worker', format('%I.%I', n.nspname, c.relname), 'TRUNCATE'
      ) OR has_table_privilege(
        'astella_worker', format('%I.%I', n.nspname, c.relname), 'REFERENCES'
      ) OR has_table_privilege(
        'astella_worker', format('%I.%I', n.nspname, c.relname), 'TRIGGER'
      ) AS has_admin_table_privilege
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
  )
  SELECT string_agg(actual.table_name, ', ')
  INTO mismatch
  FROM actual
  LEFT JOIN expected USING (table_name)
  WHERE actual.can_select <> coalesce(expected.can_select, false)
    OR actual.can_insert <> coalesce(expected.can_insert, false)
    OR actual.can_update <> coalesce(expected.can_update, false)
    OR actual.can_delete <> coalesce(expected.can_delete, false)
    OR actual.has_admin_table_privilege;
  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'Worker privilege matrix mismatch: %', mismatch;
  END IF;

  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AND (
    NOT has_schema_privilege('astella_api', 'drizzle', 'USAGE')
    OR NOT has_table_privilege(
      'astella_api', 'drizzle.__drizzle_migrations', 'SELECT'
    )
    OR has_schema_privilege('astella_worker', 'drizzle', 'USAGE')
  ) THEN
    RAISE EXCEPTION 'migration journal privilege matrix mismatch';
  END IF;

  IF to_regprocedure('public.astella_claim_jobs(integer,integer,integer)') IS NOT NULL AND (
    NOT has_function_privilege(
      'astella_worker', 'public.astella_claim_jobs(integer,integer,integer)', 'EXECUTE'
    )
    OR has_function_privilege(
      'astella_api', 'public.astella_claim_jobs(integer,integer,integer)', 'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'job claim function privilege matrix mismatch';
  END IF;

  IF to_regprocedure('public.astella_reap_stale_jobs(integer,integer)') IS NOT NULL AND (
    NOT has_function_privilege(
      'astella_worker', 'public.astella_reap_stale_jobs(integer,integer)', 'EXECUTE'
    )
    OR has_function_privilege(
      'astella_api', 'public.astella_reap_stale_jobs(integer,integer)', 'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'job reap function privilege matrix mismatch';
  END IF;

  IF to_regprocedure('public.astella_renew_job_lease(uuid,uuid,text)') IS NOT NULL AND (
    NOT has_function_privilege(
      'astella_worker', 'public.astella_renew_job_lease(uuid,uuid,text)', 'EXECUTE'
    )
    OR has_function_privilege(
      'astella_api', 'public.astella_renew_job_lease(uuid,uuid,text)', 'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'job lease renewal function privilege matrix mismatch';
  END IF;

  IF to_regprocedure('public.astella_finish_job(uuid,uuid,text)') IS NOT NULL AND (
    NOT has_function_privilege(
      'astella_worker', 'public.astella_finish_job(uuid,uuid,text)', 'EXECUTE'
    )
    OR has_function_privilege(
      'astella_api', 'public.astella_finish_job(uuid,uuid,text)', 'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'job finish function privilege matrix mismatch';
  END IF;

  IF to_regprocedure('public.astella_fail_job(uuid,uuid,text,text,integer)') IS NOT NULL AND (
    NOT has_function_privilege(
      'astella_worker', 'public.astella_fail_job(uuid,uuid,text,text,integer)', 'EXECUTE'
    )
    OR has_function_privilege(
      'astella_api', 'public.astella_fail_job(uuid,uuid,text,text,integer)', 'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'job failure function privilege matrix mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.oid IN (
      to_regprocedure('public.astella_claim_jobs(integer,integer,integer)'),
      to_regprocedure('public.astella_reap_stale_jobs(integer,integer)'),
      to_regprocedure('public.astella_renew_job_lease(uuid,uuid,text)'),
      to_regprocedure('public.astella_finish_job(uuid,uuid,text)'),
      to_regprocedure('public.astella_fail_job(uuid,uuid,text,text,integer)'),
      to_regprocedure('public.astella_queue_job_depth()'),
      to_regprocedure('public.astella_queue_oldest_pending_age()'),
      to_regprocedure('public.astella_enqueue_companion_daily_summaries()'),
      to_regprocedure('public.astella_run_companion_memory_maintenance()'),
      to_regprocedure('public.astella_close_companion_memory_delivery(uuid,uuid,uuid,text)'),
      to_regprocedure('public.astella_purge_companion_audit_ttl(integer,integer)'),
      to_regprocedure('public.astella_purge_invitation_ledger_ttl(integer,integer)'),
      to_regprocedure('public.astella_purge_tutor_nonces_ttl(integer,integer)'),
      to_regprocedure('public.astella_purge_expired_object_transfers()')
    )
      AND (
        NOT p.prosecdef
        OR p.proowner <> 'astella_migrator'::regrole
        OR p.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog, public']::text[]
      )
  ) THEN
    RAISE EXCEPTION 'job queue function security contract mismatch';
  END IF;

  SELECT string_agg(p.oid::regprocedure::text, ', ')
  INTO mismatch
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND has_function_privilege('astella_worker', p.oid, 'EXECUTE')
    AND p.oid IS DISTINCT FROM to_regprocedure('public.astella_create_private_note_v1(uuid,uuid,uuid,uuid,text,text,jsonb,uuid)')
    AND p.oid IS DISTINCT FROM to_regprocedure('public.astella_note_creation_scope_current(uuid,uuid)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_claim_jobs(integer,integer,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_reap_stale_jobs(integer,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_renew_job_lease(uuid,uuid,text)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_finish_job(uuid,uuid,text)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_fail_job(uuid,uuid,text,text,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_queue_job_depth()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_queue_oldest_pending_age()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.vector_in(cstring,oid,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.vector(vector,integer,boolean)')
    -- 0171/0172/0174：方案 22 桌宠日记/记忆维护 + pgvector 距离函数。
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_enqueue_companion_daily_summaries()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_run_companion_memory_maintenance()')
    -- 0217：失效 companion 确认的定时兜底回收。
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_reclaim_stale_companion_proposals()')
    -- 0227/0232/0238：上面 granted 的三支 worker 定时器函数必须同时出现在这份
    -- "预期权限"清单里。它们是**两份清单**：只加 GRANT 而忘了这里，role-bootstrap
    -- 会在下一次 `docker compose up` 时 exit 3，而 api 因为 depends_on 直接起不来——
    -- 容器一直活着的话这个洞完全看不见（实机 2026-09-21 就是这样埋下的）。
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_enqueue_companion_thoughts()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_reclaim_orphaned_companion_runs()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_fire_due_companion_reminders(integer)')
    -- 0267：跨空间记忆铺开（与上面那条 GRANT 成对，两份清单一起改）。
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_fanout_global_companion_memory(uuid)')
    AND p.oid IS DISTINCT FROM to_regprocedure('public.astella_agent_scope_current(uuid,uuid)')
    AND p.oid IS DISTINCT FROM to_regprocedure('public.astella_enqueue_agent_recovery()')
    AND p.oid IS DISTINCT FROM to_regprocedure('public.astella_cancel_agent_operations(uuid,integer)')
    AND p.oid IS DISTINCT FROM to_regprocedure('public.astella_agent_method_sources_current(uuid,uuid,uuid)')
    AND p.oid IS DISTINCT FROM to_regprocedure('public.astella_agent_job_current(uuid,uuid,uuid,boolean)')
    AND p.oid IS DISTINCT FROM to_regprocedure('public.astella_agent_run_authorized(uuid)')
    -- 0373：制卡这一发的父围栏与初始归属读取（与上面 GRANT 成对，两份清单一起改）。
    AND p.oid IS DISTINCT FROM to_regprocedure('public.astella_agent_card_job_current(uuid,uuid,boolean)')
    AND p.oid IS DISTINCT FROM to_regprocedure('public.astella_agent_card_execution_binding(uuid,uuid)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_close_companion_memory_delivery(uuid,uuid,uuid,text)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_purge_expired_companion_memory()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_companion_memory_retention_limits()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_enforce_companion_memory_retention()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_reclaim_stale_memory_organization_leases()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_commit_memory_organization(uuid,uuid,text,text,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_enqueue_companion_memory_organize()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_companion_memory_organization_thresholds()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_move_companion_memory_budget_tier_v1(uuid,uuid,uuid,text,text,uuid)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_retire_workspace_memories_on_departure(uuid,uuid)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_dissolve_workspace(uuid,uuid)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.cosine_distance(vector,vector)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.l2_distance(vector,vector)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.inner_product(vector,vector)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.cosine_distance(halfvec,halfvec)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.l2_distance(halfvec,halfvec)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.inner_product(halfvec,halfvec)')
    -- 扩展函数（pg_trgm/pgvector/…）按 deptype='e' 整体放行：它们是库代码，
    -- 上面按扩展统一恢复 EXECUTE，逐个列举会再次变成打地鼠。
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.objid = p.oid AND d.deptype = 'e'
    );
  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'Worker has unexpected function EXECUTE privileges: %', mismatch;
  END IF;

  SELECT string_agg(p.oid::regprocedure::text, ', ')
  INTO mismatch
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND has_function_privilege('astella_api', p.oid, 'EXECUTE')
    AND p.oid IS DISTINCT FROM to_regprocedure('public.astella_create_private_note_v1(uuid,uuid,uuid,uuid,text,text,jsonb,uuid)')
    AND p.oid IS DISTINCT FROM to_regprocedure('public.astella_pending_companion_note_edits_v1()')
    AND p.oid IS DISTINCT FROM to_regprocedure('public.astella_note_creation_scope_current(uuid,uuid)')
    AND p.oid IS DISTINCT FROM to_regprocedure('public.astella_agent_scope_current(uuid,uuid)')
    AND p.oid IS DISTINCT FROM to_regprocedure('public.astella_cancel_agent_operations(uuid,integer)')
    AND p.oid IS DISTINCT FROM to_regprocedure('public.astella_agent_method_sources_current(uuid,uuid,uuid)')
    AND p.oid IS DISTINCT FROM to_regprocedure('public.astella_fanout_agent_global_preference(uuid)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_purge_companion_audit_ttl(integer,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_purge_invitation_ledger_ttl(integer,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_purge_tutor_nonces_ttl(integer,integer)')
    AND p.oid IS DISTINCT FROM to_regprocedure('public.astella_purge_expired_object_transfers()')
    -- 0327（P0-4，`users` 表 RLS）：登录查询与"同空间成员"判据。
    -- 前者是登录路径（会话建立之前，没有 RLS 上下文），后者被 users 的策略
    -- 2.3 调用——**必须** SECURITY DEFINER，否则策略里的裸子查询会被
    -- workspace_members 自己的 RLS 收窄成"只看自己"。
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_find_user_by_email(text)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_user_in_workspace(uuid,uuid)')
    -- 0174：pgvector 距离函数（api 也需调用记忆向量检索）。
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.cosine_distance(vector,vector)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.l2_distance(vector,vector)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.inner_product(vector,vector)')
    -- API 独占的 SECURITY DEFINER 函数（与上方显式白名单一一对应）。
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_note_rounds_idle_for_pause(integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_claim_run_processing(text,integer,integer,timestamp with time zone)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_mark_run_processing_processed(uuid,text,timestamp with time zone)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_expire_pending_voice_artifacts(integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_purge_companion_stream_events_ttl(integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_purge_expired_proactive_deliveries(integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_purge_old_ai_audit_log(integer,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_find_resumable_companion_journey(uuid,uuid)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_read_companion_turn_handoff_snapshot_v1(uuid)')
    -- 0365：运维管理面板的跨租户只读视图（队列按类型积压 / 最近失败作业 /
    -- 最近审计 / 平台计数）。只读且只回标识与计数，不含任何正文。
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_admin_job_backlog()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_admin_recent_job_failures(integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_admin_recent_audit(integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_admin_platform_counts()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_admin_retry_failed_jobs(text,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_admin_purge_dead_jobs(text,integer)')
    -- 0273／0276：空间离开时的记忆退役与整空间解散，都是 API 路由显式调的
    -- SECURITY DEFINER 函数。下面"该有的授权不能缺"那份反向清单里已经列了它们，
    -- 而这里的白名单漏了——三处要一起改（迁移 GRANT／上面的 GRANT 块／这里），
    -- 少改一处的表现是**全新库根本起不来**（这道检查在引导时就 RAISE），
    -- 而不是某个功能静默失败。
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_retire_workspace_memories_on_departure(uuid,uuid)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_dissolve_workspace(uuid,uuid)')
    -- 0344：HTTP 用户请求由 API 发起，worker 侧 companion 工具也会执行同一原子函数。
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_move_companion_memory_budget_tier_v1(uuid,uuid,uuid,text,text,uuid)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_restore_companion_memory(uuid,uuid,uuid)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_purge_expired_companion_memory()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_companion_memory_retention_limits()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.astella_enforce_companion_memory_retention()')
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.objid = p.oid AND d.deptype = 'e'
    );
  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'API has unexpected function EXECUTE privileges: %', mismatch;
  END IF;
END
$$;

-- 反向断言：**该有的授权不能缺**（doc 34 L8 的复发防线）。
--
-- 上面那两份"预期权限"清单只抓**多出来的** EXECUTE——它防的是权限外溢，防不了权限丢失。
-- 而"丢授权"恰恰是本文件自己造出来的风险：顶部那句 `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS`
-- 会把迁移里的 `GRANT EXECUTE` 一并清掉，只有在本文件重新授过的才活下来。
-- 漏一支的后果不是启动失败，而是**某条业务功能静默 permission denied**——
-- 如果调用方还 catch 成日志（0267 那支正是如此），就变成"用户说她不记得了，可查无实据"。
--
-- 这份清单只列**应用代码显式 SELECT/PERFORM 的**函数（触发器函数不算：触发执行不查
-- session 用户的 EXECUTE）。新增一支这样的函数时，三处要一起改：迁移的 GRANT、
-- 上面的 GRANT 块、这里的一行。
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(required.fn, ', ' ORDER BY required.fn)
    INTO missing
    FROM (VALUES
      ('astella_worker', 'astella_claim_jobs(integer,integer,integer)'),
      ('astella_api', 'astella_agent_method_sources_current(uuid,uuid,uuid)'),
      ('astella_worker', 'astella_agent_method_sources_current(uuid,uuid,uuid)'),
      ('astella_api', 'astella_agent_scope_current(uuid,uuid)'),
      ('astella_worker', 'astella_agent_scope_current(uuid,uuid)'),
      ('astella_api', 'astella_create_private_note_v1(uuid,uuid,uuid,uuid,text,text,jsonb,uuid)'),
      ('astella_api', 'astella_pending_companion_note_edits_v1()'),
      ('astella_worker', 'astella_create_private_note_v1(uuid,uuid,uuid,uuid,text,text,jsonb,uuid)'),
      ('astella_api', 'astella_note_creation_scope_current(uuid,uuid)'),
      ('astella_worker', 'astella_note_creation_scope_current(uuid,uuid)'),
      ('astella_api', 'astella_cancel_agent_operations(uuid,integer)'),
      ('astella_worker', 'astella_cancel_agent_operations(uuid,integer)'),
      ('astella_worker', 'astella_enqueue_agent_recovery()'),
      ('astella_worker', 'astella_agent_job_current(uuid,uuid,uuid,boolean)'),
      ('astella_worker', 'astella_agent_run_authorized(uuid)'),
      -- 0373：制卡这一发的父围栏。缺它时链内每一段短事务与每次模型调用前的判定都会
      -- permission denied，而调用方多半把异常 catch 成一行 warn——父围栏静默失效，
      -- 表现是"用户已经停下的目标，那批卡片还在跑完并烧预算"。
      ('astella_worker', 'astella_agent_card_job_current(uuid,uuid,boolean)'),
      -- 0373：初始归属读取。缺它时 worker 读不到绑定，所有 Agent 制卡被误认成普通制卡，
      -- 父预算与围栏静默失效。
      ('astella_worker', 'astella_agent_card_execution_binding(uuid,uuid)'),
      ('astella_worker', 'astella_reap_stale_jobs(integer,integer)'),
      ('astella_worker', 'astella_renew_job_lease(uuid,uuid,text)'),
      ('astella_worker', 'astella_finish_job(uuid,uuid,text)'),
      ('astella_worker', 'astella_fail_job(uuid,uuid,text,text,integer)'),
      ('astella_worker', 'astella_enqueue_companion_thoughts()'),
      ('astella_worker', 'astella_reclaim_orphaned_companion_runs()'),
      ('astella_worker', 'astella_fire_due_companion_reminders(integer)'),
      ('astella_worker', 'astella_enqueue_companion_daily_summaries()'),
      ('astella_worker', 'astella_run_companion_memory_maintenance()'),
      ('astella_worker', 'astella_reclaim_stale_companion_proposals()'),
      ('astella_worker', 'astella_fanout_global_companion_memory(uuid)'),
      ('astella_api', 'astella_fanout_agent_global_preference(uuid)'),
      ('astella_worker', 'astella_close_companion_memory_delivery(uuid,uuid,uuid,text)'),
      ('astella_api', 'astella_restore_companion_memory(uuid,uuid,uuid)'),
      ('astella_api', 'astella_purge_expired_companion_memory()'),
      ('astella_worker', 'astella_purge_expired_companion_memory()'),
      ('astella_api', 'astella_companion_memory_retention_limits()'),
      ('astella_worker', 'astella_companion_memory_retention_limits()'),
      ('astella_api', 'astella_enforce_companion_memory_retention()'),
      ('astella_worker', 'astella_enforce_companion_memory_retention()'),
      ('astella_worker', 'astella_reclaim_stale_memory_organization_leases()'),
      ('astella_worker', 'astella_commit_memory_organization(uuid,uuid,text,text,integer)'),
      ('astella_worker', 'astella_enqueue_companion_memory_organize()'),
      ('astella_worker', 'astella_companion_memory_organization_thresholds()'),
      ('astella_api', 'astella_move_companion_memory_budget_tier_v1(uuid,uuid,uuid,text,text,uuid)'),
      ('astella_worker', 'astella_move_companion_memory_budget_tier_v1(uuid,uuid,uuid,text,text,uuid)'),
      ('astella_api', 'astella_retire_workspace_memories_on_departure(uuid,uuid)'),
      ('astella_api', 'astella_dissolve_workspace(uuid,uuid)'),
      ('astella_api', 'astella_find_resumable_companion_journey(uuid,uuid)'),
      ('astella_api', 'astella_note_rounds_idle_for_pause(integer)'),
      ('astella_api', 'astella_claim_run_processing(text,integer,integer,timestamp with time zone)'),
      ('astella_api', 'astella_mark_run_processing_processed(uuid,text,timestamp with time zone)'),
      ('astella_api', 'astella_expire_pending_voice_artifacts(integer)'),
      ('astella_api', 'astella_purge_companion_stream_events_ttl(integer)'),
      ('astella_api', 'astella_purge_expired_proactive_deliveries(integer)'),
      ('astella_api', 'astella_purge_old_ai_audit_log(integer,integer)'),
      ('astella_api', 'astella_purge_companion_audit_ttl(integer,integer)'),
      ('astella_api', 'astella_purge_invitation_ledger_ttl(integer,integer)'),
      ('astella_api', 'astella_purge_tutor_nonces_ttl(integer,integer)'),
      ('astella_api', 'astella_purge_expired_object_transfers()'),
      ('astella_api', 'astella_find_user_by_email(text)'),
      ('astella_api', 'astella_user_in_workspace(uuid,uuid)'),
      ('astella_api', 'astella_read_companion_turn_handoff_snapshot_v1(uuid)'),
      ('astella_api', 'astella_admin_job_backlog()'),
      ('astella_api', 'astella_admin_recent_job_failures(integer)'),
      ('astella_api', 'astella_admin_recent_audit(integer)'),
      ('astella_api', 'astella_admin_platform_counts()'),
      ('astella_api', 'astella_admin_retry_failed_jobs(text,integer)'),
      ('astella_api', 'astella_admin_purge_dead_jobs(text,integer)')
    ) AS required(role, fn)
    -- 函数还不存在（首次 bootstrap、迁移尚未跑到）时不该报错：与本文件其余检查
    -- 一致的 `to_regprocedure IS NOT NULL` 口径。
    WHERE to_regprocedure('public.' || required.fn) IS NOT NULL
      AND NOT has_function_privilege(
        required.role, to_regprocedure('public.' || required.fn), 'EXECUTE');

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'Required function EXECUTE grants are missing (%). REVOKE ALL ON ALL FUNCTIONS above wipes migration grants; re-grant each one in this file.',
      missing;
  END IF;
END
$$;

-- Explicitly document the current security posture.  Do not silently turn on
-- RLS from a bootstrap script that has no policies or workspace context.  The
-- pre-migration pass allows an older database to reach the forward migration
-- endpoint; migration 0027 restores expansion mode after 0024 was journaled
-- before runtime transaction scoping was complete.  The post-migration pass
-- fails closed when protection is incomplete.
-- 2026-08-11（第十轮修复）：原检查统计"启用了 RLS 的表数"，0111 为六张
-- card_generation 表启用 RLS 后 enabled_count>0 必然 RAISE，导致生产
-- role-grants 服务（REQUIRE_RLS_DISABLED=true）部署挂起。语义改为 fail-closed
-- 的真正意图：**有 RLS 的表必须都有 policy**（未完成保护的 RLS 表 = 裸隔离）
-- ——预迁移（全表无 RLS）与 0111 后（六表 RLS+双 policy）都通过。
DO $$
DECLARE
  unprotected_count integer;
BEGIN
  SELECT count(*) INTO unprotected_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relrowsecurity
    AND NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = c.relname
    );
  IF coalesce(current_setting('astella.require_rls_disabled', true), 'false')::boolean
    AND unprotected_count > 0
  THEN
    RAISE EXCEPTION
      '% public table(s) have RLS enabled without any policy; migration/policies must be completed before applications start',
      unprotected_count;
  END IF;
END
$$;
