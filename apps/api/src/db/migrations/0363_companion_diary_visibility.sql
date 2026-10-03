-- 0363: 日记的**可见性与删除**（40 §10 / §11.1）。
--
-- ## 要修的事实
--
-- 方案 §10 把日记的次级动作列成五项：聊聊这篇、查看依据、收藏、指出不准确、
-- **隐藏/删除**。而 `companion_daily_summaries` 是一张**纯只读**的表：
--
-- - 没有任何可见性列（`hidden_at` / `deleted_at` 一个都没有）；
-- - `daily-summary-routes.ts` 只有两个 GET，没有任何 POST/DELETE；
-- - 桌面端 DiaryPanel 只有「聊聊这篇」和「查看关联记忆」两个按钮。
--
-- 所以 §11.1 那张表的第 4 行「删除一篇日记」与第 6 行「撤销材料权限 → 日记正文
-- 复述同步遮蔽」**整行没有落点**。§10 的「隐藏日记」与「删除日记」是两种
-- 不同语义，它们必须在数据模型上就分开。
--
-- ## 两种语义的差别（§10 原文）
--
-- | 动作 | 从列表与推荐里移除 | 排除后续自动引用 | 能否恢复 | 是否删内容 |
-- | --- | --- | --- | --- | --- |
-- | 隐藏 | 是 | 是 | 从管理入口能恢复 | **否** |
-- | 删除 | 是 | 是 | 不能 | 是（含派生预览/摘录/仅由它产生的记忆） |
--
-- 「隐藏**不等于遗忘原事件**」是合同明写的：原事件仍然存在，只是不再作为日记
-- 素材被自动选中。所以隐藏**不写抑制表**——那会让用户真正忘掉那次交流。
--
-- ## 为什么 `deleted_at` 上带墓碑理由
--
-- §11.1 第 4 行要求「迟到任务不复活」（A12）：删除之后，后台重试不能把同一篇
-- 再写回来。唯一索引 `(ws, user, date)` 挡得住「新增」，挡不住「UPDATE 回
-- generated」——handler 里的发布语句是 upsert。所以这里给删除留一个墓碑，
-- 由 0363 末尾的守卫触发器强制：删除过的日期不可再被发布。

-- statement-breakpoint

ALTER TABLE public.companion_daily_summaries
  ADD COLUMN IF NOT EXISTS source_event_ids text[],
  ADD COLUMN IF NOT EXISTS hidden_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS delete_reason text
    CHECK (delete_reason IS NULL OR delete_reason IN ('user_deleted', 'revoked_source'));

-- 这一篇用过的**真实事件 id**（消息/笔记/来源）。它是撤权遮蔽（§11.1 第 6 行）
-- 唯一的匹配依据：没有它就只能在撤权时"把所有日记都遮掉"或者"一篇都不遮"，
-- 两种都错。有了它，「这篇用过这份材料」才是可查的而不是靠猜的。
CREATE INDEX IF NOT EXISTS companion_daily_summaries_source_event_ids_idx
  ON public.companion_daily_summaries USING gin (source_event_ids)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN public.companion_daily_summaries.source_event_ids IS
  '这一篇由哪些真实事件成稿（40 §5.3「保持说话者、先后顺序、目标与内容版本」）。'
  '撤权时按它遮蔽整篇：正文是一段连续自由文本，无法逐句拆分来源（§11.1「无法安全拆分时整篇不可读」）。';

COMMENT ON COLUMN public.companion_daily_summaries.hidden_at IS
  '「隐藏日记」（40 §10）：从普通列表与主动推荐中移除该篇，并排除后续自动日记引用。'
  '用户可从管理入口恢复或明确打开。它**不删除内容，也不等于遗忘原事件**，因此不写来源抑制。';

COMMENT ON COLUMN public.companion_daily_summaries.deleted_at IS
  '「删除日记」（40 §10/§11.1）：删除该作品及其派生预览与摘录。原始聊天/学习事件不默认删除。'
  '与 hidden_at 分开，因为两者在「能不能恢复」上不同。';

COMMENT ON COLUMN public.companion_daily_summaries.delete_reason IS
  'revoked_source = 撤权导致的整篇遮蔽（§11.1 第 6 行）；user_deleted = 用户主动删除。';

-- statement-breakpoint

-- 部分索引：所有读路径都带 `deleted_at IS NULL`，而这张表按 (user, date)
-- 查得极多，一个只索引存活行的索引比全表索引小一个数量级。
CREATE INDEX IF NOT EXISTS companion_daily_summaries_live_idx
  ON public.companion_daily_summaries (workspace_id, user_id, date DESC)
  WHERE deleted_at IS NULL;

-- statement-breakpoint

-- 「删除过的日期不可再被发布」（§11.1「不再后台生成同一篇」/ A12）。
--
-- 触发器而不是 handler 里的 WHERE：handler 的发布语句是 upsert，写在 worker 里，
-- 而删除可能来自 API、桌面或管理页——三条路径都写同一张表。把守卫放在数据库，
-- 就不会出现"第四条发布路径忘了检查"。
--
-- 恢复时不触发：恢复走的是 UPDATE deleted_at → NULL，而这条守卫只拦
-- `NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL`（即"复活"）。
CREATE OR REPLACE FUNCTION public.ailearn_guard_daily_summary_republish()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'daily summary % was deleted and must not be republished (40 §11.1); restore through the explicit restore path',
      OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

--> statement-breakpoint

CREATE TRIGGER companion_daily_summaries_no_republish
  BEFORE UPDATE ON public.companion_daily_summaries
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_guard_daily_summary_republish();

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_guard_daily_summary_republish() FROM PUBLIC;
--> statement-breakpoint

-- 撤权遮蔽的**数据级**触发器（40 §11.1 第 6 行 / A13）。
--
-- ## 为什么放数据库而不是应用层
--
-- 材料被收回访问有多个入口：笔记软删、来源删除、空间成员移除。
-- 而 `apps/api/src/modules/note/` 之类**不允许**反向 import 伴星模块
-- （模块边界守卫：住在 modules/ 的不得被别的模块用）。于是应用层要么形成
-- 一条循环依赖，要么依赖"每条删除路径都记得调一次"——后者正是本条合同
-- 原来失败的样子。
--
-- 触发器把这件事变成数据不变量：**材料一软删，引用过它的日记当场遮蔽**，
-- 任何新写的删除路径都自动被覆盖。
--
-- ## 为什么是「整篇不可读」而不是逐句遮蔽
--
-- 日记正文是一段连续的自由文本，无法从句子里判断哪一句来自哪份材料。
-- §11.1 的原话给了两个选项，逐句遮蔽是前者，「无法安全拆分时整篇不可读」
-- 是后者——我们只能诚实地选后者，并在 `delete_reason` 上记明是
-- `revoked_source` 而不是用户主动删除（两者在界面上的措辞不同）。
CREATE OR REPLACE FUNCTION public.ailearn_mask_diaries_for_revoked_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_masked integer;
BEGIN
  -- 来源的软删由 status='archived' 表达，笔记使用 deleted_at。
  IF TG_TABLE_NAME = 'sources' THEN
    IF NEW.status <> 'archived' OR OLD.status = 'archived' THEN RETURN NULL; END IF;
  ELSIF NEW.deleted_at IS NULL OR OLD.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.companion_daily_summaries
     SET deleted_at = now(),
         delete_reason = 'revoked_source',
         hidden_at = COALESCE(hidden_at, now()),
         updated_at = now()
   WHERE deleted_at IS NULL
     AND source_event_ids @> ARRAY[NEW.id::text];

  GET DIAGNOSTICS v_masked = ROW_COUNT;

  -- 派生摘录与预览一起遮蔽：正文不可读了，摘录里那一句同样不该还留在
  -- 发现簿里。只遮蔽不物理删除——材料重新可访问时还要能放回来。
  UPDATE public.companion_discovery_entries AS entry
     SET masked = true, updated_at = now()
   WHERE entry.source = 'diary'
     AND NOT entry.masked
     AND EXISTS (
       SELECT 1 FROM public.companion_daily_summaries AS diary
        WHERE diary.workspace_id = entry.workspace_id
          AND diary.user_id = entry.user_id
          AND diary.date = entry.source_id
          AND diary.delete_reason = 'revoked_source'
          AND diary.source_event_ids @> ARRAY[NEW.id::text]
     );

  RETURN NULL;
END;
$$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS companion_diary_mask_on_note_delete ON public.notes;
CREATE TRIGGER companion_diary_mask_on_note_delete
  AFTER UPDATE OF deleted_at ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_mask_diaries_for_revoked_source();

DROP TRIGGER IF EXISTS companion_diary_mask_on_source_delete ON public.sources;
CREATE TRIGGER companion_diary_mask_on_source_delete
  AFTER UPDATE OF status ON public.sources
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_mask_diaries_for_revoked_source();

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_mask_diaries_for_revoked_source() FROM PUBLIC;
