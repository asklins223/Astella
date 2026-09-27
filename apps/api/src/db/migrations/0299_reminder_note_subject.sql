-- 0299 —— 提醒的**来源笔记**，让共享撤回之后它不再兑现（39d W5-6 刀三；39 §16.13、§14.4）。
--
-- §16.13 的验收原话是"共享撤销后，**通知**和历史不泄露受保护内容"。今天这一半是破的，
-- 而且破在一个很基础的地方：`companion_reminders`（0238）只有 `text` 一列，
-- `ailearn_fire_due_companion_reminders`（0270）只按"账号开关／离线／空间静音"三道闸放行。
-- 于是**没有任何一处能知道一条提醒是在说哪篇笔记**——共享撤回之后，那句"提醒你看
-- 《数据库索引优化策略》第 3 节"照样到点弹出来，标题就在正文里。
--
-- 为什么不能靠"提醒文本里别写标题"解决：那条文本是**模型写**的。工具契约
-- `companion_schedule_reminder` 今天只有 `{ text, fireAtLocal }`，正文里带不带篇名
-- 完全取决于模型那一刻怎么措辞，服务端管不住。要让规则可执行，**来源必须是一个列**，
-- 不是一句约定。
--
-- 落法沿用 0270 那道静音闸的形状：**给提醒一个可选 subject，兑现时按它判一次可见性**。
-- 判据复用房子里那一份（`notes.share_scope = 'shared' OR notes.created_by = <user>`），
-- 与 `visibleNotesCondition` 是同一句话；这里写成 plpgsql 是因为兑现函数是
-- SECURITY DEFINER 且跑在 worker 角色上，没有会话上下文可借。
--
-- **可空，且空 = 不判**：历史行没有 subject（当时就没有这个概念），空 subject 继续照常兑现。
-- 把它当成"未知来源按最坏处理"会把所有旧提醒一次烧掉，那是拿产品可用性换一个
-- 查不出来的风险；正确的做法是把**新写的**提醒都带上 subject，然后让新路径受管。
-- 残留的缺口写在 §16.13 那一行：**模型把篇名写进 text 而又没传 noteId**，仍然会漏——
-- 工具契约那一格是新增的 `noteId` 可选参数，靠模型自觉传，服务端没有强制。
-- 那半句要真正关掉需要"提醒文本本身经过脱敏"或"按 note 派生提醒时由服务端拼文本"，
-- 不在本迁移射程内，已登记在 39d 台账 W5-6。

ALTER TABLE public.companion_reminders
  ADD COLUMN IF NOT EXISTS note_id uuid REFERENCES public.notes(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.companion_reminders.note_id IS
  '39 §16.13：这条提醒是在说哪篇笔记（可空＝不知道来源）。共享撤回后据此不再兑现——免费文本里带篇名而没记 note_id 的，是已登记的残留缺口';

--> statement-breakpoint

-- 兑现读侧：按篇查得到 id 的走一条索引。存量行 note_id 为 NULL，不进这条索引。
CREATE INDEX IF NOT EXISTS companion_reminders_note_idx
  ON public.companion_reminders (note_id)
  WHERE note_id IS NOT NULL;

--> statement-breakpoint

-- 兑现函数重写：只加一道「来源笔记现在还看得见吗」，其余三道闸（账号开关、离线、
-- 空间静音）与投递形状（assistant_deliveries / dedupe_key / advisory lock）**一字未动**。
--
-- 为什么是 `cancelled` 而不是新造一个终态：0238 的 CHECK 只认
-- pending/fired/cancelled/missed 四档，'cancelled' 的语义在 0238 头注里就是
-- "用户撤回"。共享撤回后不再兑现，从用户视角就是"这条被收走了"——复用那一档
-- 不改状态机，也不用改任何读这一列的查询。新造一档要动 CHECK、索引与三处读点，
-- 而多出来的那一档对用户说的话与 'cancelled' 一模一样。
--
-- 先 UPDATE 再 SELECT：把撤不掉的那些**当场置为 cancelled**（留下"为什么没弹"的痕迹，
-- 而不是让它无限期停在 pending），SELECT 剩下的就是可以直接投递的。
-- 两处都按 `user_id` 走，因为 `visibleNotesCondition` 的第二支是 `created_by = 本人`。
CREATE OR REPLACE FUNCTION public.ailearn_fire_due_companion_reminders(p_limit integer)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_row record;
  v_fired integer := 0;
  v_dedupe_key text;
BEGIN
  UPDATE public.companion_reminders
     SET status = 'missed', updated_at = now()
   WHERE status = 'pending'
     AND fire_at < now() - interval '2 hours';

  -- §16.13：来源笔记现在读不到了（共享被撤回／不再是那一篇的主人），这条提醒不再兑现。
  -- 用 'cancelled' 而不是新终态，理由见本迁移头注。
  UPDATE public.companion_reminders r
     SET status = 'cancelled', updated_at = now()
   WHERE r.status = 'pending'
     AND r.note_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.notes n
                  WHERE n.id = r.note_id
                    AND n.deleted_at IS NULL
                    AND NOT (n.share_scope = 'shared' OR n.created_by = r.user_id));

  FOR v_row IN
    SELECT r.id, r.workspace_id, r.user_id, r.text
      FROM public.companion_reminders r
      -- 账号级开关：跟着人走，哪个空间都一样。
      LEFT JOIN public.user_companion_account_state a ON a.user_id = r.user_id
      -- 空间级静音：跟着"这个空间的她"走（0266）。没有行 = 没静音过。
      LEFT JOIN public.companion_room_profiles p
        ON p.workspace_id = r.workspace_id AND p.user_id = r.user_id
     WHERE r.status = 'pending'
       AND r.fire_at <= now()
       -- 来源笔记的可见性（39 §16.13）。与上面那道 UPDATE 是同一句话，写两遍是因为
       -- 一个是"写下痕迹"、一个是"选候选"；只留 UPDATE 的话，并发撤回之后仍可能
       -- 在同一轮里把已经判过的那一行投递出去（FOR UPDATE 锁的是提醒行，不是笔记行）。
       AND (r.note_id IS NULL OR EXISTS (
             SELECT 1 FROM public.notes n
              WHERE n.id = r.note_id
                AND n.deleted_at IS NULL
                AND (n.share_scope = 'shared' OR n.created_by = r.user_id)))
       AND COALESCE(a.global_enabled, true)
       -- `presence` 是 jsonb（0074 起就是），不是 text：库里现存的形状是 {"presence":"online"}。
       -- 直接拿它和字符串比较会当场报 `invalid input syntax for type json`，
       -- 整支提醒兑现函数每一次调用都失败——所以这里按 jsonb 取，
       -- 并兼容"对象包一层"与"裸字符串"两种写法，取不到就当 online。
       AND COALESCE(a.presence ->> 'presence', a.presence #>> '{}', 'online')
             NOT IN ('dnd', 'offline')
       AND NOT COALESCE(p.proactive_muted, false)
     ORDER BY r.fire_at
       FOR UPDATE OF r SKIP LOCKED
     LIMIT COALESCE(p_limit, 10)
  LOOP
    v_dedupe_key := 'reminder:' || v_row.id;
    -- inbox_sequence 取 MAX+1：与 API 的 deliver()/其他设备并发时用同一把用户级锁
    -- （记忆写入、念头送达是同一个 key 形态），否则会撞唯一约束。
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'companion-inbox:' || v_row.workspace_id || ':' || v_row.user_id, 0));
    INSERT INTO assistant_deliveries
      (assistant_session_id, workspace_id, user_id, inbox_sequence, dedupe_key,
       state, kind, payload_ref, expires_at)
    SELECT NULL, v_row.workspace_id, v_row.user_id,
           COALESCE(MAX(d.inbox_sequence), 0) + 1,
           v_dedupe_key, 'queued', 'system_event',
           jsonb_build_object('kind', 'system_event',
                              'systemEventId', v_dedupe_key,
                              'text', v_row.text),
           now() + interval '2 hours'
      FROM assistant_deliveries d
     WHERE d.workspace_id = v_row.workspace_id AND d.user_id = v_row.user_id
    ON CONFLICT (workspace_id, user_id, dedupe_key) DO NOTHING;
    UPDATE public.companion_reminders
       SET status = 'fired', fired_at = now(), updated_at = now()
     WHERE id = v_row.id;
    v_fired := v_fired + 1;
  END LOOP;
  RETURN v_fired;
END;
$function$;

--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_fire_due_companion_reminders(integer) IS
  '到点提醒兑现。闸：超时→missed、来源笔记失权→cancelled、账号开关/离线/空间静音→不选；余下投递 assistant_deliveries';

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_fire_due_companion_reminders(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ailearn_fire_due_companion_reminders(integer) TO ailearn_worker;
GRANT EXECUTE ON FUNCTION public.ailearn_fire_due_companion_reminders(integer) TO ailearn_migrator;
