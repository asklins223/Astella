-- 0402：让「依据仍成立」那道核对认得**消息**这一种来源（方案 50 §8.2 / §16 第 6 步）。
--
-- ## 撞上的现场
--
-- 0374 把方法的来源核对写成一个函数，里面只认两种引用：`memoryId`（长期记忆那一条）
-- 与 `runId`（正式学习那一轮）。方案 50 让后台反思把提炼出的合作方法指向**那段真实交流**
-- ——那是这些经验唯一的依据，写的是 `{eventId: "message:<uuid>"}`。
-- 于是这条引用走到函数的最后那个 `ELSE RETURN false`：
-- 一条刚刚由反思写下的候选，被自己的来源核对判成「依据已变」，
-- 投影出来是 `source_changed`——既进不了目录，也读不回下一轮相处。
-- 单测看不出来（渲染与查询都不假），真库上那条 §16 的读回用例才把它逼出来。
--
-- ## 为什么改函数而不是改写入
--
-- 消息就是这类经验的权威来源（§8.2 那张表写的正是这件事）。把引用换成记忆条目或
-- 假装成一个 agent run，等于为了让核对通过而编一个不存在的发生处——
-- 那比多写一个分支贵得多。核对本身也没放松：**消息不在了就不算成立**。
--
-- ## 语义
--
-- `message:<uuid>` 要求那条消息在同一 workspace、同一用户名下仍然存在。
-- `companion_messages` 没有软删列，历史清理与数据撤回走的是 DELETE，
-- 所以「还在」就是这道核对能给的全部答案；引用格式不合（前缀不对、uuid 拼不出）
-- 与异常都按不成立处理，沿用函数原有的兜底。
--
-- 授权随原函数保留：同一签名 `CREATE OR REPLACE` 不改 ACL，
-- 0374 末尾那句 `GRANT EXECUTE ... TO astella_api, astella_worker` 继续有效。

CREATE OR REPLACE FUNCTION public.astella_agent_method_sources_current(p_id uuid,p_workspace uuid,p_user uuid)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE method record; ref jsonb; material jsonb; input_refs jsonb; valid boolean;
BEGIN
  IF p_workspace IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'')::uuid
     OR p_user IS DISTINCT FROM NULLIF(current_setting('app.user_id',true),'')::uuid THEN RETURN false; END IF;
  SELECT * INTO method FROM public.companion_procedural_playbooks
    WHERE id=p_id AND workspace_id=p_workspace AND user_id=p_user;
  IF NOT FOUND OR jsonb_array_length(method.evidence)=0 THEN RETURN false; END IF;
  FOR ref IN SELECT value FROM pg_catalog.jsonb_array_elements(method.evidence) LOOP
    IF ref ? 'memoryId' THEN
      IF NOT (ref ? 'memoryRevision') THEN RETURN false; END IF;
      SELECT EXISTS(SELECT 1 FROM public.assistant_memory_items m
        WHERE m.id=(ref->>'memoryId')::uuid AND m.workspace_id=p_workspace AND m.user_id=p_user
          AND m.revision=(ref->>'memoryRevision')::integer
          AND m.deleted_at IS NULL AND m.dismissed_at IS NULL AND m.archived_at IS NULL
          AND m.epistemic_status NOT IN ('disputed','superseded')
          AND (m.valid_from IS NULL OR m.valid_from<=now())
          AND (m.valid_until IS NULL OR m.valid_until>now())) INTO valid;
      IF NOT valid THEN RETURN false; END IF;
    ELSIF ref ? 'runId' THEN
      input_refs := NULL;
      SELECT r.inputs INTO input_refs FROM public.agent_runs r
        WHERE r.id=(ref->>'runId')::uuid AND r.workspace_id=p_workspace AND r.user_id=p_user
          AND r.revision=(ref->>'runRevision')::integer AND r.status='completed';
      IF input_refs IS NULL THEN
        SELECT r.inputs INTO input_refs FROM public.agent_run_revisions r
          WHERE r.run_id=(ref->>'runId')::uuid AND r.workspace_id=p_workspace AND r.user_id=p_user
            AND r.revision=(ref->>'runRevision')::integer AND r.status='completed';
      END IF;
      IF input_refs IS NULL THEN RETURN false; END IF;
      FOR material IN SELECT value FROM pg_catalog.jsonb_array_elements(input_refs) LOOP
        SELECT EXISTS(SELECT 1 FROM public.note_versions v JOIN public.notes n ON n.id=v.note_id AND n.workspace_id=v.workspace_id
          WHERE v.id=(material->>'noteVersionId')::uuid AND n.id=(material->>'noteId')::uuid
            AND n.workspace_id=p_workspace AND n.deleted_at IS NULL
            AND (n.share_scope='shared' OR n.created_by=p_user)) INTO valid;
        IF NOT valid THEN RETURN false; END IF;
      END LOOP;
    ELSIF ref ? 'eventId' AND ref->>'eventId' LIKE 'message:%' THEN
      -- 那段真实交流本身：消息还在，依据就还在。
      SELECT EXISTS(SELECT 1 FROM public.companion_messages m
        WHERE m.id=substring(ref->>'eventId' from 9)::uuid
          AND m.workspace_id=p_workspace AND m.user_id=p_user) INTO valid;
      IF NOT valid THEN RETURN false; END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$$;
