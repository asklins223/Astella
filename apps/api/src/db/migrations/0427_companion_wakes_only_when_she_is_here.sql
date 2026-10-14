-- 56 收尾：到点的关注只在她真的在场时才被消费。
--
-- 0423 的两支唤醒一律「入队即把 next_review_at 置空」，而 prep 那侧没有观察时并不要求有人
-- 在前台（companion-initiative.ts 只在 observation 存在时检查 present）。合起来是两层代价：
-- 人不在时照样起一整轮 Agent 只是不许出声；更糟的是那次到点被吃掉后水位归零，若运行静默结束
-- 或失败，这条关注就永久睡着——她的主动通道会自己越来越少，直到再也不开口。
--
-- 这里把「到点」重新定义成「到点且她在」：不在场就留在 due 状态，等她回来那一刻再唤起。
-- 同时只在 job 真的插入成功时才清水位，幂等冲突不再顺手吃掉一次安排。
CREATE OR REPLACE FUNCTION public.astella_enqueue_companion_attention() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p record; added integer; total integer:=0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('companion-attention-enqueue')) THEN RETURN 0; END IF;
  FOR p IN SELECT n.* FROM public.companion_attention_plans n
    JOIN public.workspace_members m ON m.workspace_id=n.workspace_id AND m.user_id=n.user_id AND m.left_at IS NULL
    JOIN public.user_companion_account_state a ON a.user_id=n.user_id AND a.global_enabled
    LEFT JOIN public.companion_participation_preferences pref ON pref.user_id=n.user_id
    WHERE n.state='active' AND n.next_review_at<=now() AND (n.expires_at IS NULL OR n.expires_at>now())
      AND (n.preference_revision IS NULL OR (pref.enabled AND n.preference_revision=pref.revision))
      -- 有人在用这个书房：租约还新、前台、未锁屏、这一刻允许参与。
      -- 作用域必须和 prep 那侧一致（companion-initiative.ts 只读本房书房的会话）：
      -- 按「这个人所在任意书房」判在场，会让从没进过的房间起一整轮却没人能听见。
      AND EXISTS(SELECT 1 FROM public.companion_awareness_sessions s
        WHERE s.workspace_id=n.workspace_id AND s.user_id=n.user_id AND s.updated_at>now()-interval '45 seconds'
          AND COALESCE(s.context->>'foreground','')='true'
          AND COALESCE(s.context->>'unlocked','true')<>'false'
          AND COALESCE(s.context->>'participationAllowed','true')<>'false')
    ORDER BY n.next_review_at LIMIT 50 FOR UPDATE OF n SKIP LOCKED
  LOOP
    INSERT INTO public.jobs(type,workspace_id,requested_by,payload,status,priority,resource_class,idempotency_key)
      VALUES('companion_initiative',p.workspace_id,p.user_id,
        jsonb_build_object('attentionKey',p.entry_key,'attentionRevision',p.revision),
        'pending',25,'maintenance','companion-attention:'||p.user_id||':'||md5(p.entry_key)||':'||p.revision||':'||extract(epoch FROM p.next_review_at))
      ON CONFLICT(workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
    GET DIAGNOSTICS added=ROW_COUNT; total:=total+added;
    IF added>0 THEN
      UPDATE public.companion_attention_plans SET next_review_at=NULL
        WHERE workspace_id=p.workspace_id AND user_id=p.user_id AND entry_key=p.entry_key AND revision=p.revision;
    ELSE
      -- 撞了同一个幂等键＝这一版水位已经起过一次队。往前挪一分钟，下一拍就是新键；
      -- 什么都不做会让这条安排永远卡在队首（LIMIT 50 按到期时间排序）。
      UPDATE public.companion_attention_plans SET next_review_at=now()+interval '1 minute'
        WHERE workspace_id=p.workspace_id AND user_id=p.user_id AND entry_key=p.entry_key AND revision=p.revision;
    END IF;
  END LOOP;
  -- These are transient observations, never long-term user memories.
  DELETE FROM public.companion_awareness_observations WHERE topic<>'app.started' AND expires_at<now()-interval '1 day';
  -- Keep only the launch receipt so a long-running app's reload never greets a second time.
  UPDATE public.companion_awareness_observations SET facts='{}'::jsonb,device_session_id=NULL,conversation_id=NULL
    WHERE topic='app.started' AND expires_at<now() AND facts<>'{}'::jsonb;
  DELETE FROM public.companion_study_spans WHERE ended_at<now()-interval '1 day';
  DELETE FROM public.companion_awareness_sessions WHERE updated_at<now()-interval '1 day';
  -- 人不在场期间到期又过期了的安排不会被消费；留着 active 就是 0423 那条「必须唤得起」
  -- 想避免的僵尸行——它会占住关注额度，却再也唤不起她。
  UPDATE public.companion_attention_plans SET state='completed',next_review_at=NULL,updated_at=now()
    WHERE state='active' AND expires_at IS NOT NULL AND expires_at<=now();
  RETURN total;
END $$;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.astella_enqueue_companion_self_wakes() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n record; added integer; total integer:=0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('companion-self-wake-enqueue')) THEN RETURN 0; END IF;
  FOR n IN SELECT s.* FROM public.companion_self_notes s
    JOIN public.workspace_members m ON m.workspace_id=s.workspace_id AND m.user_id=s.user_id AND m.left_at IS NULL
    JOIN public.user_companion_account_state a ON a.user_id=s.user_id AND a.global_enabled
    WHERE NOT s.user_disabled AND s.next_review_at<=now() AND s.tier<>'archived'
      AND (s.expires_at IS NULL OR s.expires_at>now())
      AND EXISTS(SELECT 1 FROM public.companion_awareness_sessions w
        WHERE w.workspace_id=s.workspace_id AND w.user_id=s.user_id AND w.updated_at>now()-interval '45 seconds'
          AND COALESCE(w.context->>'foreground','')='true'
          AND COALESCE(w.context->>'unlocked','true')<>'false'
          AND COALESCE(w.context->>'participationAllowed','true')<>'false')
    ORDER BY s.next_review_at LIMIT 50 FOR UPDATE OF s SKIP LOCKED
  LOOP
    INSERT INTO public.jobs(type,workspace_id,requested_by,payload,status,priority,resource_class,idempotency_key)
      VALUES('companion_initiative',n.workspace_id,n.user_id,
        jsonb_build_object('selfNoteKey',n.entry_key,'selfNoteRevision',n.revision),
        'pending',25,'maintenance','companion-self-wake-v2:'||n.user_id||':'||md5(n.entry_key)||':'||n.revision||':'||extract(epoch FROM n.next_review_at))
      ON CONFLICT(workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
    GET DIAGNOSTICS added=ROW_COUNT; total:=total+added;
    IF added>0 THEN
      UPDATE public.companion_self_notes SET next_review_at=NULL
        WHERE workspace_id=n.workspace_id AND user_id=n.user_id AND entry_key=n.entry_key AND revision=n.revision;
    ELSE
      UPDATE public.companion_self_notes SET next_review_at=now()+interval '1 minute'
        WHERE workspace_id=n.workspace_id AND user_id=n.user_id AND entry_key=n.entry_key AND revision=n.revision;
    END IF;
  END LOOP;
  RETURN total;
END $$;
