-- 0357: 放宽 `reset` 版本行的形状约束（配合 40b §5.2 的「只恢复声明的表达项」）。
--
-- ## 起因：这条约束编码的是**旧**的 reset 语义
--
-- 0341 建表时写的是：
--     (action <> 'reset' OR profile IS NULL)
-- 也就是「reset ⇒ 快照为 null ⇒ 整份回到当前发布的默认」。那时 reset 确实
-- 把用户改过的名字、活跃度、行为边界一起抹掉，而 A51 明令那是不该发生的。
--
-- 改成只重置表达项之后，reset 产出的当前档案**不是 null**
-- （名字/开关必须留着），于是那条 CHECK 让「恢复默认表达」在真库上必然失败。
--
-- ## 为什么不干脆把 profile 写回 null
--
-- 那样能过约束，但会让版本历史**不再忠实**：那一行记录的是"整份回到默认"，
-- 而实际发生的是"表达回到默认、身份与开关保留"。下次用户翻历史、或者我们
-- 要回滚时，那一行会撒谎。§40b §5.3.1 要求旧版本按既有保留规则保存，
-- 存一份假的比存一份真的差。
--
-- ## 放宽成什么
--
-- 保留原来那条有价值的部分——**空文本不是有效覆盖**（§40b §5.2「不把空文本当
-- 有效覆盖」）：reset 行的 speakingStyle 必须非空。原来被禁掉的是"reset 带
-- 非空 profile"整体，现在只禁"reset 带空表达"。

--> statement-breakpoint

ALTER TABLE public.companion_persona_profile_versions
  DROP CONSTRAINT companion_persona_profile_versions_action_shape_check;

--> statement-breakpoint

ALTER TABLE public.companion_persona_profile_versions
  ADD CONSTRAINT companion_persona_profile_versions_action_shape_check CHECK (
    (profile IS NOT NULL OR action IN ('reset', 'restore'))
    AND (action <> 'reset' OR COALESCE(profile->>'speakingStyle', '') <> '')
  );

--> statement-breakpoint

COMMENT ON CONSTRAINT companion_persona_profile_versions_action_shape_check
  ON public.companion_persona_profile_versions IS
  'reset 行现在允许非空 profile（40b §5.2：只恢复表达项，名字与开关保留），'
  '但表达不能是空文本 —— 空文本不是有效覆盖。';