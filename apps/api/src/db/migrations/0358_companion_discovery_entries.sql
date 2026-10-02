-- 40 §7 发现簿（本人可访问记录与本人收藏的视图）
--
-- 这一版落地的是「收藏」这件事本身：一条 (kind, source, source_id) 对应
-- **一条**行，笔记旁与发现簿共用它（§7「同一条内容在笔记旁和发现簿里出现时
-- 共用收藏身份」）。取消收藏走 visible=false，**不删行**，于是
--   - 原始回答与日记一个字都不动（§7「取消收藏不删除原始回答或日记」）；
--   - 仍看得出"这里曾经收藏过"，而不是凭空少一条。
--
-- 为什么 identity 是 (kind, source, source_id) 而不是正文文本：
-- 用户后来改了原文，按正文判就会分裂成两条，两边的批注与取消都不再同步。
--
-- 为什么没有"成长里程碑"这类自动产物：§7 明令「不按正确率或事件数量自动
-- 生产『成长里程碑』」。表里没有任何可以长出那种东西的列。

CREATE TABLE IF NOT EXISTS public.companion_discovery_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  -- 收藏的归属人。§7「本人收藏的视图」——它永远是**用户本人**的簿子。
  user_id uuid NOT NULL,
  kind text NOT NULL,
  source text NOT NULL,
  -- 来源那一侧的稳定 id（日记的 id / 记忆的 id / 一次回复的 id）。
  -- 与 kind + source 一起构成**共用身份**。
  source_id text NOT NULL,
  -- §7「各自标清作者和来源」：作者只有 user / assistant 两种，第三方不进这条簿子。
  author text NOT NULL CHECK (author IN ('user', 'assistant')),
  -- 正文快照。原文后来改了它不动：它是"当时留下的那一段"。
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  -- 用户自己的批注。与正文分开存：编辑批注不该改写原文。
  annotation text CHECK (annotation IS NULL OR char_length(annotation) <= 2000),
  -- §7「私人内容默认不跨空间、跨成员展示」。private 是默认值，不是可选项。
  visibility text NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'space', 'study')),
  -- 取消收藏 = visible=false。**不删行**（见文件头）。
  visible boolean NOT NULL DEFAULT true,
  -- 来源撤权/删除之后遮蔽（§7「撤权或删除后缩略图、引文和预览同样处理」）。
  -- 遮蔽而不是删行：删掉就看不出"这里曾经有过"。
  masked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- ⚠️ 名字不能叫 `..._author_check`：上面那行内联的
  -- `author ... CHECK (author IN ('user','assistant'))` 会被 Postgres 自动
  -- 命名成 `companion_discovery_entries_author_check`，于是这条一建就撞名，
  -- 报 "check constraint already exists"（实测踩到）。加前缀避开。
  CONSTRAINT companion_discovery_entries_kind_author_check
    CHECK (author <> 'user' OR kind <> 'kept_ai_suggestion'),
  CONSTRAINT companion_discovery_entries_excerpt_source_check
    CHECK (kind <> 'diary_excerpt' OR source = 'diary')
);

--> statement-breakpoint

COMMENT ON TABLE public.companion_discovery_entries IS
  '40 §7 发现簿：本人收藏的视图。取消收藏只置 visible=false，不删行——原始回答与日记不受影响。';

--> statement-breakpoint

-- 共用身份：同一份内容在笔记旁与发现簿里指向**同一行**，所以编辑批注与取消
-- 收藏在两处同步生效。必须带 workspace_id：身份只在**本空间内**唯一。
CREATE UNIQUE INDEX companion_discovery_entries_identity_key
  ON public.companion_discovery_entries (workspace_id, user_id, kind, source, source_id);

--> statement-breakpoint

-- 簿子页按时间倒序，不分页：它按定义就很短（用户自己留下的东西）。
CREATE INDEX companion_discovery_entries_recent_idx
  ON public.companion_discovery_entries (workspace_id, user_id, visible, created_at DESC);

--> statement-breakpoint

-- §7「书房仅展示用户愿意放出的少量痕迹」。这一条把"少量"交给数据库守：
-- 即使上层算错了，第六条之后也插不进来。
CREATE OR REPLACE FUNCTION public.ailearn_discovery_study_trace_limit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  existing_count int;
BEGIN
  SELECT count(*)::int INTO existing_count
    FROM public.companion_discovery_entries
   WHERE workspace_id = NEW.workspace_id
     AND user_id = NEW.user_id
     AND visibility = 'study'
     AND visible
     AND NOT masked
     AND id <> NEW.id;
  IF NEW.visibility = 'study' AND NEW.visible AND NOT NEW.masked
     AND existing_count >= 6 THEN
    RAISE EXCEPTION 'study trace limit reached (6) for discovery entries'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint

CREATE TRIGGER companion_discovery_study_trace_guard
  BEFORE INSERT OR UPDATE ON public.companion_discovery_entries
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_discovery_study_trace_limit();

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_discovery_study_trace_limit() FROM PUBLIC;

--> statement-breakpoint

ALTER TABLE public.companion_discovery_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_discovery_entries FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

-- ⚠️ 这一段是**真跑真库才暴露**的：漏了它，迁移与全部静态测试都通过，
-- `GET /companion/discovery` 却稳定 500（`permission denied for table`）。
-- RLS 只管"能看哪些行"，ACL 才管"能不能碰这张表"——两者是独立的开关。
-- 迁移测试当时只断言了约束与触发器，没断言 ACL，于是它一路绿灯。
GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_discovery_entries TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_discovery_entries TO ailearn_worker;

--> statement-breakpoint

CREATE POLICY companion_discovery_entries_user_isolation
  ON public.companion_discovery_entries FOR ALL
  USING (
    CURRENT_USER = 'ailearn_worker'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    CURRENT_USER = 'ailearn_worker'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

-- §7「私人内容默认不跨空间、跨成员展示」的第一道门：**默认 private**。
-- 跨成员只由 visibility='space' 显式放行，而放行这件事本身要上层显式做。
CREATE OR REPLACE FUNCTION public.ailearn_discovery_visibility_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id <> OLD.workspace_id THEN
    RAISE EXCEPTION 'discovery entries do not move across workspaces'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'discovery entries do not change owner'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint

CREATE TRIGGER companion_discovery_visibility_guard
  BEFORE UPDATE ON public.companion_discovery_entries
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_discovery_visibility_guard();

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_discovery_visibility_guard() FROM PUBLIC;
