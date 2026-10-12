-- 0414：补上 0410 漏掉的那一支授权（2026-10-11 排障）。
--
-- 0410 建 `astella_companion_tool_confirmed_v1(uuid, text)` 时只写了函数体，
-- 没有 `REVOKE`/`GRANT`；而 `infra/postgres/roles.sql` 在迁移后会
-- `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, astella_api, astella_worker`，
-- 只有它白名单里重新授过的才活下来。两处都没有这一支，于是以受限角色直接
-- `SELECT` 它的两条路都在真实栈（CI、dev 容器的 NOBYPASSRLS `astella_api`／
-- `astella_worker`）上静默 `permission denied for function`：
-- API 侧 `companion-edit-dispatch.ts`／`companion-share-dispatch.ts` 的评审确认
-- 判定（伴星改笔记整条路失败），以及 worker 侧
-- `companion-tool-call-ledger.ts`／`companion-reviewed-target.ts`／
-- `companion-note-authoring.ts` 的确认复查。函数是 SECURITY INVOKER：
-- 授权不扩权，调用方仍只能看见自己 RLS 上下文里的行。
REVOKE ALL ON FUNCTION public.astella_companion_tool_confirmed_v1(uuid, text) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='astella_api') THEN
    GRANT EXECUTE ON FUNCTION public.astella_companion_tool_confirmed_v1(uuid, text) TO astella_api;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='astella_worker') THEN
    GRANT EXECUTE ON FUNCTION public.astella_companion_tool_confirmed_v1(uuid, text) TO astella_worker;
  END IF;
END $$;
