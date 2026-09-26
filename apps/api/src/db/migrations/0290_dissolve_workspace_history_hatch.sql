-- 0290 —— 解散空间那支护手把「只追加」的四张表带进来，并修掉一条会把合法顺序报成死局的守卫
--            （39d 登记的 P0；F 台账 F43）。
--
-- 两处改动，都不超出这支函数原有的语义：
--
-- ① 开头开、结尾收 `app.allow_history_mutation`。0276 按 catalog 现生成表清单、逐表
--    `DELETE FROM public.%I WHERE workspace_id = $1`（102 张表里只有 13 张带外键，靠
--    CASCADE 清不掉，所以是它自己一张一张删）。0282–0285 新添的轮次族里三张子表的守卫
--    把 UPDATE **与 DELETE** 一起挡了，于是清单走到 `note_learning_round_artifacts` 就抛
--    `P0001 … is append-only: DELETE is not allowed`，整个解散事务回滚——用户侧是
--    "学习服务内部出了点问题，请稍后重试"，而重试永远再失败。改前实测：
--      ERROR: note_learning_round_artifacts is append-only: DELETE is not allowed
--               (round 888bdef1-…, artifact 9c2a1ba1-…)   [code P0001]
--    这不是外键级联被挡（那一条由 0289 的守卫豁免管）：这里是**函数自己直删子表**，
--    父行当时还在场，所以只能由"谁发起这次销毁"来授权。事务局部，返回前收回。
--
-- ② 报「删不动」之前回查真实行数。原逻辑把任何一轮撞过外键的表记进 `v_deferred` 且
--    永不摘除，最后无条件按这份名单报错。轮次族四张表按名字排序，artifacts 必然排在
--    引用它的 teachings 之前：第一轮 defer、第二轮删干净，从此每次解散都会报
--    `dissolve_blocked_by_cross_workspace_references: note_learning_round_artifacts`
--    ——而那张表其实一行不剩。这一条改完，守卫才真的等于它自己注释写的那句
--    "最后一轮仍删不动就报出来"。（量到这一步是本轮第二次修正归因：先误判为级联被挡。）
--
-- 只搬函数体：末尾那三行 COMMENT/REVOKE/GRANT 没有重复，`CREATE OR REPLACE FUNCTION`
-- 不改 owner、ACL 与注释，它们在 0276 里已经生效（重复一遍反而会掩盖将来漏登记的那次）。
-- 除此之外函数体与 0276 逐字相同；比对办法写在 §19 那一格：把本文件从
-- `CREATE OR REPLACE FUNCTION` 起的那段与 0276 同段做 diff，差异只应是上面这两处。

CREATE OR REPLACE FUNCTION public.ailearn_dissolve_workspace(
  p_workspace_id uuid,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ws record;
  v_member record;
  v_table record;
  v_pass integer;
  v_deleted integer;
  v_total integer := 0;
  v_counts jsonb := '{}'::jsonb;
  v_rehomed_memories integer := 0;
  v_orphaned_global_memories integer := 0;
  v_actor_personal_ws uuid;
  v_retired_memories integer := 0;
  v_deferred text[] := ARRAY[]::text[];
  v_still_deferred text[] := ARRAY[]::text[];  -- 0290：回查后**仍然**有行的那些张
  v_name text;                                  -- 0290：FOREACH 的游标变量
  v_pass_rows integer;
  -- 排除名单：每张都要有理由，测试会断言这份名单不增长。
  v_exclude text[] := ARRAY[
    'workspaces',              -- 父行，最后单独删
    'ai_audit_log',            -- ②：AI 外发合规审计必须活过解散（它就是"当初有没有外发过"的唯一凭据）
    'workspace_audit_log',     -- ②：本次 tombstone 自己也要活下来，否则等于没记
    -- 注：`companion_audit`（页级不透明遥测）**跟着空间一起清**——它不是合规凭据，
    -- 留着只会造出指向已消失空间的悬空行（L39 那类孤儿）。
    'assistant_memory_items',  -- ①：由下面两段显式处理（global 不删）
    'assistant_memory_embeddings'
  ];
BEGIN
  -- 0290：这一族里四张表是只追加（0282–0285），它们的守卫认这个维护口子。
  -- 解散空间是**用户明确发起、按单个空间授权**的销毁动作，也是这条路径唯一
  -- 合法的调用者；事务局部（第三参 true），提交即失效，异常则随事务一起回滚。
  PERFORM set_config('app.allow_history_mutation', 'on', true);
  SELECT id, workspace_type, name INTO v_ws
    FROM public.workspaces WHERE id = p_workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace_not_found';
  END IF;
  IF v_ws.workspace_type = 'personal' THEN
    -- 个人空间是会话的落回点（`personal_workspace_missing` 那条判据的正面），不给删。
    RAISE EXCEPTION 'cannot_dissolve_personal_workspace';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND user_id = p_actor_user_id
      AND role = 'owner' AND left_at IS NULL
  ) THEN
    RAISE EXCEPTION 'actor_is_not_active_owner';
  END IF;

  -- ① 先处理记忆：每个成员收掉本空间那一份，再把属于人的 global 行改指回他的个人空间。
  FOR v_member IN
    SELECT user_id FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND left_at IS NULL
  LOOP
    v_retired_memories := v_retired_memories
      + public.ailearn_retire_workspace_memories_on_departure(p_workspace_id, v_member.user_id);

    -- 先把"个人空间里已经有同一件事"的那一份丢掉，再改指针。
    -- 为什么必须先丢：伴星的 global 记忆是**按空间扇出**的——同一条记忆带着完全相同的
    -- `source_event_id` 同时存在于用户的每一个空间里。而
    -- `assistant_memory_items_content_unique_idx` 是 (workspace_id, user_id, kind,
    -- source_event_id) 的部分唯一索引，只把 workspace_id 改成个人空间必然撞它，
    -- 于是整个解散事务回滚，用户看到的是"学习服务内部出了点问题，请稍后重试"，
    -- 而重试永远再失败（2026-09-23 全链路审计 F43/F44）。
    -- 丢的是被解散空间里的那一份，个人空间里的原件不动，所以不丢任何信息。
    DELETE FROM public.assistant_memory_items m
     USING public.users u
     WHERE m.workspace_id = p_workspace_id
       AND m.user_id = u.id
       AND m.scope = 'global'
       AND u.personal_workspace_id IS NOT NULL
       AND u.personal_workspace_id <> p_workspace_id
       AND m.source_event_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM public.assistant_memory_items p
          WHERE p.workspace_id = u.personal_workspace_id
            AND p.user_id = m.user_id
            AND p.kind = m.kind
            AND p.source_event_id = m.source_event_id
            AND p.deleted_at IS NULL
       );
    GET DIAGNOSTICS v_pass_rows = ROW_COUNT;
    v_retired_memories := v_retired_memories + v_pass_rows;

    UPDATE public.assistant_memory_items m
       SET workspace_id = u.personal_workspace_id, updated_at = now()
      FROM public.users u
     WHERE m.workspace_id = p_workspace_id
       AND m.user_id = u.id
       AND m.scope = 'global'
       AND u.personal_workspace_id IS NOT NULL
       AND u.personal_workspace_id <> p_workspace_id;
    GET DIAGNOSTICS v_pass_rows = ROW_COUNT;
    v_rehomed_memories := v_rehomed_memories + v_pass_rows;
  END LOOP;

  SELECT count(*) INTO v_orphaned_global_memories
    FROM public.assistant_memory_items m
    JOIN public.users u ON u.id = m.user_id
   WHERE m.workspace_id = p_workspace_id AND m.scope = 'global'
     AND (u.personal_workspace_id IS NULL OR u.personal_workspace_id = p_workspace_id);

  DELETE FROM public.assistant_memory_embeddings
   WHERE workspace_id = p_workspace_id;
  DELETE FROM public.assistant_memory_items
   WHERE workspace_id = p_workspace_id AND scope = 'workspace';

  SELECT personal_workspace_id INTO v_actor_personal_ws
    FROM public.users WHERE id = p_actor_user_id;
  IF v_actor_personal_ws IS NULL OR v_actor_personal_ws = p_workspace_id THEN
    -- 没有可落回的审计归属地，就不做这件事：宁可拒绝解散，也不能删完留不下证据。
    RAISE EXCEPTION 'actor_has_no_surviving_workspace_for_audit';
  END IF;

  -- ② tombstone：与被删同一事务，回滚了就不该留下一条"这个空间被解散过"。
  -- **量出来的坑**：`workspace_audit_log.workspace_id` 对 `workspaces` 是 ON DELETE CASCADE
  -- ——tombstone 写在这个空间名下就会被自己删掉，"这个空间被解散过"这件事查无实据。
  -- 所以它记在**发起者的个人空间**名下（个人空间不许解散，见上面的门卫），
  -- target_id 才是那个消失的空间。顺带说明：这条级联是审计闭环上一个独立的洞（L40 族）。
  INSERT INTO public.workspace_audit_log (workspace_id, actor_user_id, action, target_kind, target_id, detail)
  VALUES (v_actor_personal_ws, p_actor_user_id, 'workspace.dissolved', 'workspace', p_workspace_id,
          jsonb_build_object('workspaceName', v_ws.name,
                             'dissolvedWorkspaceId', p_workspace_id,
                             'tombstoneRecordedUnderActorPersonalWorkspace', true,
                             'rehomedGlobalMemories', v_rehomed_memories,
                             'orphanedGlobalMemories', v_orphaned_global_memories,
                             'retiredWorkspaceMemories', v_retired_memories));

  -- ③ 逐表清空：清单来自 catalog，多轮扫（撞外键的表推到下一轮），直到一轮里没有任何行被删掉。
  FOR v_pass IN 1..6 LOOP
    v_deleted := 0;
    FOR v_table IN
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id'
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND c.relname <> ALL (v_exclude)
       ORDER BY c.relname
    LOOP
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE workspace_id = $1', v_table.relname)
          USING p_workspace_id;
        GET DIAGNOSTICS v_total = ROW_COUNT;
        IF v_total > 0 THEN
          v_counts := v_counts || jsonb_build_object(v_table.relname,
            coalesce((v_counts ->> v_table.relname)::integer, 0) + v_total);
          v_deleted := v_deleted + v_total;
        END IF;
      EXCEPTION WHEN foreign_key_violation THEN
        -- 这一轮删不动：它还有指向别的空间的行。留到下一轮，最后一轮仍删不动就报出来。
        IF NOT (v_table.relname = ANY (v_deferred)) THEN
          v_deferred := v_deferred || v_table.relname;
        END IF;
      END;
    END LOOP;
    IF v_deleted = 0 THEN
      EXIT;
    END IF;
  END LOOP;

  -- 0290：报「删不动」之前先回查一次真实行数。原来任何一张表只要**某一轮**撞过一次
  -- 外键就进名单、并且再也不出名单，于是"下一轮明明删干净了"也会被报成挡死——多轮扫
  -- 本来就是为撞外键的表设计的（上面那段注释写的也是这个意思）。轮次族四张表按表名字序
  -- 排，`note_learning_round_artifacts` 一定排在引用它的 `..._teachings` 前面，所以第一轮
  -- 必然 defer、第二轮必然成功：这条守卫从此会一直响。
  -- 判据换成"最后一轮之后这张表**还有**这个空间的行"，与那句注释同一句话。
  FOREACH v_name IN ARRAY v_deferred LOOP
    v_pass_rows := 0;
    EXECUTE format('SELECT count(*)::int FROM public.%I WHERE workspace_id = $1', v_name)
      INTO v_pass_rows USING p_workspace_id;
    IF v_pass_rows > 0 THEN
      v_still_deferred := v_still_deferred || v_name;
    END IF;
  END LOOP;
  v_deferred := v_still_deferred;

  IF v_deferred <> ARRAY[]::text[] THEN
    RAISE EXCEPTION 'dissolve_blocked_by_cross_workspace_references: %',
      array_to_string(v_deferred, ',');
  END IF;

  DELETE FROM public.workspaces WHERE id = p_workspace_id;

  -- 立刻收回：函数返回后同一个事务里可能还有别的语句，不该带着维护口子出去。
  PERFORM set_config('app.allow_history_mutation', '', true);

  RETURN v_counts || jsonb_build_object(
    '_rehomedGlobalMemories', v_rehomed_memories,
    '_orphanedGlobalMemories', v_orphaned_global_memories,
    '_retiredWorkspaceMemories', v_retired_memories);
END;
$function$;
