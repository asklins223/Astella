-- Account persona can be adopted in a different workspace from the tool call.
-- Check only the account's pending revision and return receipt existence.
CREATE FUNCTION public.astella_companion_persona_tool_current(p_user uuid, p_revision integer)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p_user = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM public.companion_persona_profiles p
      JOIN public.companion_persona_profile_versions v
        ON v.user_id = p.user_id AND v.revision = p.pending_revision
      JOIN public.companion_agent_tool_calls c
        ON c.user_id = v.user_id AND c.workspace_id = v.source_workspace_id AND c.run_id = v.proposal_id::uuid
      JOIN public.workspace_members w
        ON w.workspace_id = c.workspace_id AND w.user_id = c.user_id AND w.left_at IS NULL
      WHERE p.user_id = p_user AND p.pending_revision = p_revision
        AND v.author = 'assistant_tool' AND v.proposal_kind = 'assistant_tool'
        AND c.name IN ('persona.write.style', 'persona.write.tags', 'persona.write.identity')
    );
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.astella_companion_persona_tool_current(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_companion_persona_tool_current(uuid, integer) TO astella_api, astella_worker;
