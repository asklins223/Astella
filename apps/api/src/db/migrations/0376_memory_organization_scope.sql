-- Scoped organization uses normal worker transactions; bootstrap must preserve its table access.
GRANT SELECT,INSERT,UPDATE ON public.companion_memory_organization_state TO ailearn_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.companion_memory_organization_leases TO ailearn_worker;
DROP POLICY companion_memory_organization_state_user_isolation ON public.companion_memory_organization_state;
DROP POLICY companion_memory_organization_leases_user_isolation ON public.companion_memory_organization_leases;
CREATE POLICY companion_memory_organization_state_user_isolation ON public.companion_memory_organization_state FOR ALL
  USING (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY companion_memory_organization_leases_user_isolation ON public.companion_memory_organization_leases FOR ALL
  USING (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.ailearn_commit_memory_organization(
  p_workspace_id uuid,p_user_id uuid,p_holder text,p_surface text,p_backlog integer
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE held integer; committed integer;
BEGIN
  IF p_workspace_id IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'')::uuid
     OR p_user_id IS DISTINCT FROM NULLIF(current_setting('app.user_id',true),'')::uuid THEN RETURN false; END IF;
  DELETE FROM public.companion_memory_organization_leases
    WHERE workspace_id=p_workspace_id AND user_id=p_user_id AND holder=p_holder AND expires_at>clock_timestamp()
    RETURNING 1 INTO held;
  IF held IS NULL THEN RETURN false; END IF;
  UPDATE public.companion_memory_organization_state
    SET last_success_at=now(),last_success_backlog=p_backlog,surface=left(p_surface,240),
      surface_at=CASE WHEN p_surface IS NULL THEN surface_at ELSE now() END,updated_at=now()
    WHERE workspace_id=p_workspace_id AND user_id=p_user_id
      AND (last_success_at IS NULL OR last_success_at<=now()-interval '1 second')
    RETURNING 1 INTO committed;
  RETURN committed IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.ailearn_commit_memory_organization(uuid,uuid,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ailearn_commit_memory_organization(uuid,uuid,text,text,integer) TO ailearn_worker;
