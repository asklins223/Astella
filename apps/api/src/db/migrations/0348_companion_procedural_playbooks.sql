-- 0348: Procedural 手册（40 §4.6.10，验收 A69）。
--
-- ## 为什么需要它
--
-- 合同 §4.5.2 把记忆按用途分成 Core Profile / Semantic / Episodic / Working /
-- **Procedural** 五层。前四层此前都有落点，Procedural 是**唯一一个完全没有实现**的：
-- 她「讲机制先反例后定义」这种**可复用的表达/协作经验**，只能躺在一条普通 preference 里，
-- 和「我叫小伴」混在一起。
--
-- 差别是实质的：偏好说的是「他是什么样的人」，手册说的是「**遇到这类事先这么做**」。
-- 后者有触发条件、步骤、例外和证据，它是一条**可执行的协作规则**。
--
-- ## 三条硬边界（都是合同原话）
--
-- 1. 「手册**不能保存未经核实的事实**、扩大工具范围或自动启动复习；
--    业务规则始终从领域服务取得。」
--    → scope 一律 workspace，author 永远是 companion/extractor，没有 user_stated 那种
--      「用户说的」通道；没有 tool_scope / schedule 之类的列，所以它在结构上就
--      不可能授权或排程。
-- 2. 「默认只注入**目录**，条件匹配且与用户目标有关时按需读取正文」
--    → 这条由 `companion-playbooks.ts` 的目录读取 + 按 ID 展开保证，不是靠 prompt 文案。
-- 3. 「用户纠正和遗忘也**传播到手册**及派生摘要。」
--    → 触发器 + `ailearn_supersede_companion_playbooks_from_memory()`。
--
-- ## 稳定 ID 与版本
--
-- §4.6.10 要求「稳定 ID、标题、触发条件、步骤、例外、证据与**版本**」。
-- 稳定 ID 是 `playbook_key`：由触发条件规范化而来，同一条经验被重新整理时
-- 命中同一行、只升版本，而不是每次都长出一份看起来不同的新条目。

--> statement-breakpoint

CREATE TABLE public.companion_procedural_playbooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 稳定身份：同一触发条件 ⇒ 同一 playbook_key。版本升级复用它。
  playbook_key text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  -- 触发条件：什么时候该用这条手册。目录里只注入它，正文不注入。
  trigger_condition text NOT NULL CHECK (char_length(trigger_condition) BETWEEN 1 AND 200),
  -- 步骤与例外都是**有序**的，所以用 jsonb 数组而不是拼接文本。
  steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array'),
  exceptions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(exceptions) = 'array'),
  -- 证据：这条手册是从哪些记忆/事件归纳出来的（§4.6.10「证据与版本」）。
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- 认识状态与事实记忆同源：有据 / 暂定 / 争议。
  epistemic_status text NOT NULL DEFAULT 'tentative'
    CHECK (epistemic_status IN ('supported', 'tentative', 'disputed')),
  author text NOT NULL DEFAULT 'companion'
    CHECK (author IN ('companion', 'extractor', 'maintenance')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_procedural_playbooks_key_unique
    UNIQUE (workspace_id, user_id, playbook_key)
);

--> statement-breakpoint

-- 说明里的措辞是刻意的：这里**不点名**那些被刻意排除的列。
-- 守卫会扫「建表语句里不得出现可授权/可排程/可标为用户自述的列」，而这句说明
-- 若把它们逐字写出来，守卫就会在自己的说明文字上命中——判据读到注释/字面量
-- 里的名字，报的却是「表里有这一列」。
COMMENT ON TABLE public.companion_procedural_playbooks IS
  'Procedural 手册（40 §4.6.10）：可复用的表达/协作经验，带触发条件、步骤、例外、证据与版本。'
  '它不能授权任何动作、不能排程、也不能被当成用户说的话——这三件事由表结构本身保证，'
  '而不是靠每个写入方自觉。';

--> statement-breakpoint

CREATE INDEX companion_procedural_playbooks_catalog_idx
  ON public.companion_procedural_playbooks (workspace_id, user_id, title);

--> statement-breakpoint

ALTER TABLE public.companion_procedural_playbooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_procedural_playbooks FORCE ROW LEVEL SECURITY;
CREATE POLICY companion_procedural_playbooks_user_isolation
  ON public.companion_procedural_playbooks FOR ALL
  USING (
    CURRENT_USER = 'ailearn_worker'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    CURRENT_USER = 'ailearn_worker'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.companion_procedural_playbooks TO ailearn_api;
GRANT SELECT, INSERT, UPDATE ON public.companion_procedural_playbooks TO ailearn_worker;

--> statement-breakpoint

-- 证据失效时手册不能继续当"有据"。用户遗忘（软删）或修订了一条被引用的记忆，
-- 引用它的手册立刻降级为争议——§4.6.10「用户纠正和遗忘也传播到手册」。
--
-- 用触发器而不是在删除路径里手写：删除有**四条**入口（API delete、worker forget、
-- 纠正、离开/解散空间），漏一条就意味着「她忘掉的东西还在手册里当依据」。
CREATE OR REPLACE FUNCTION public.ailearn_propagate_playbook_evidence_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL
     OR NEW.revision <> OLD.revision
     OR NEW.content <> OLD.content THEN
    UPDATE public.companion_procedural_playbooks
       SET epistemic_status = 'disputed',
           updated_at = now()
     WHERE evidence ? 'memoryId'
       AND evidence @> jsonb_build_object('memoryId', OLD.id::text)
       AND epistemic_status <> 'disputed';
  END IF;
  RETURN NULL; -- AFTER 触发器，返回值被忽略
END;
$$;

--> statement-breakpoint

CREATE TRIGGER assistant_memory_playbook_evidence_guard
  AFTER UPDATE ON public.assistant_memory_items
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_propagate_playbook_evidence_change();

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_propagate_playbook_evidence_change() FROM PUBLIC;