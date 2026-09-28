-- 0304 —— 轮次动态产物**改由模型生成**之后的三个数据面（39d W4-1 尾；39 §6.1／§6.3／§16.4）。
--
-- 背景：产物从「确定性拼装」变成「模型写讲解 ＋ 可信播放器执行」。生成过程会**真的调用
-- 模型**，于是 0298 那一档 `build`（只覆盖"内容本身没有可上屏的东西／整份超配额"）不再
-- 覆盖全部失败形状，而 §6.3 要求"生成产物与本轮快照绑定、保存实际使用版本"在库里要读得到。
--
-- 本迁移做三件事，都不新增表：
--
--   1. **`nlraf_stage_reason_chk` 加一档 `generate`**。它与 `build` 是两句不同的话：
--      `build` 换一次输入照样失败（材料本身没有可上屏的东西、或整份太长），`generate` 是
--      外部调用没成（`model_failed`）或回执说没达成完成判据（`contract_rejected`）。把它
--      塞进 `build` 的两档里只有两条路，都不诚实：谎报成 `empty`（它不空）或谎报成
--      `over_quota`（它没超配额）——而"这一版为什么没生成"正是这张表存在的理由。
--      既存行**一格都不改**（只是 CHECK 变宽），所以这是纯扩展。
--
--   2. **`note_learning_round_artifacts` 加一列 `generator_ref`**：实际使用的生成器版本
--      （`note_round_dynamic_artifact_v1@v1` ＋ 模型 id）。§6.3 的"保存实际使用版本"在
--      画面上已经写了一行同样的字，但那一行在 HTML 里，事后统计要能按生成器分组就得
--      库里有一列。默认 `''` 而不是 NOT NULL 强填：存量行的生成器版本无从得知，编一个
--      等于把不知道写成了知道。
--
--   3. **补上 0298 那个只追加触发器缺的那半截**。0298 自己的头注第 5 条写的是"触发器照
--      0283/0284/0285 的形状，带 `app.allow_history_mutation` 绕行口子"，而函数体里**没有**
--      那个绕行判断——实现与自己的头注脱钩了。
--      后果在产物**开始真的由模型生成**之后才第一次显形，而显形的样子极难看懂：这张表的
--      `teaching_id` 是 `ON DELETE CASCADE`，触发器又无条件拒绝 DELETE，于是
--      **只要某一条教学行有过失败留痕，那一行（以及它所属的轮次、笔记）就永远删不掉**，
--      而报错来自一条级联出来的 DELETE，跟真正的原因隔了三层。
--      这不是"清理测试数据不方便"那么轻：笔记删除是产品动作。
--      下面把函数换成 0285 那一版（同一条 `COALESCE(NEW, OLD)` 语义——BEFORE DELETE 里
--      NEW 是 NULL，返回 NULL 的含义是"跳过这一行"，0283 真踩过那个坑）。
--
-- RLS / GRANT 都不动（三张表各自的策略与 0298 照旧）。

-- --> statement-breakpoint

-- 1) 失败留痕：加一档 `generate`。
--    组合穷举表（判据 / 本 CHECK / drizzle schema CHECK / 线上合同，四处同宽）：
--      build    : empty | over_quota
--      generate : model_failed | contract_rejected
--      persist  : persist_failed
ALTER TABLE public.note_learning_round_artifact_failures
  DROP CONSTRAINT IF EXISTS nlraf_stage_reason_chk;

ALTER TABLE public.note_learning_round_artifact_failures
  ADD CONSTRAINT nlraf_stage_reason_chk CHECK (
    (stage = 'build'    AND reason IN ('empty', 'over_quota'))
    OR (stage = 'generate' AND reason IN ('model_failed', 'contract_rejected'))
    OR (stage = 'persist' AND reason = 'persist_failed')
  );

COMMENT ON COLUMN public.note_learning_round_artifact_failures.reason IS
  '穷举：build(empty|over_quota) / generate(model_failed|contract_rejected) / persist(persist_failed)';

-- 2) 产物行：实际使用的生成器版本。
ALTER TABLE public.note_learning_round_artifacts
  ADD COLUMN IF NOT EXISTS generator_ref text NOT NULL DEFAULT '';

COMMENT ON COLUMN public.note_learning_round_artifacts.generator_ref IS
  '实际使用的生成器版本，如 note_round_dynamic_artifact_v1@v1 (qwen-plus)；空串 ＝ 存量行，生成器版本未知（不猜）';

-- --> statement-breakpoint

-- 3) 补上只追加触发器缺的那半截（0298 头注第 5 条声明过、函数体里没写）。
--    形状与 0285 的 `prevent_note_learning_round_artifact_mutation` 同款，独立成函数
--    是同一个理由：别让几张表共用一段报错文本，把"哪张表不可变"说糊。
CREATE OR REPLACE FUNCTION public.guard_note_learning_round_artifact_failure() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_history_mutation', true) = 'on' THEN
    -- UPDATE 分支返回 NEW（放行修改），DELETE 分支返回 OLD——BEFORE DELETE 里 NEW 是
    -- NULL，返回 NULL 的语义是"跳过这一行"（0283 真踩过：DELETE 0 行且不报错）。
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION
    'note_learning_round_artifact_failures is append-only: % is not allowed (round %, teaching %)',
    TG_OP, OLD.round_id, OLD.teaching_id;
END;
$$ LANGUAGE plpgsql;
