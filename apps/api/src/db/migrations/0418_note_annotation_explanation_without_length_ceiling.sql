-- 0418：批注解释的长度随模型档案与原文走，不设本地配额。
--
-- worker 侧（`note-annotation-explain.ts`）原先按 650 字拒收：模型一写长，这一发就以
-- `output_shape` 终结，用户看到的是"批注解释缺少清楚的白话说明"——而内容本身是合法的。
-- 那道闸已随本次一并去掉（天花板只认模型档案声明的 `maxOutputTokens`）。
--
-- 存储侧这条 8000 是同一件事的另一半：worker 放开、库里仍卡着，就会变成"生成成功、
-- 落库失败"，比原来的拒收更难读。非空保留（空解释没有意义），长度不再另设上限——
-- 与其它生成内容（0415 动态讲解、0416 笔记链接、0417 建笔记正文）同一条纪律。
--
-- 两个约束名都要兜：0313 建表时那条 `CHECK (char_length(explanation) <= 8000)` 由
-- Postgres 自动命名为 `note_annotations_explanation_check`，而 drizzle schema 声明的是
-- `note_annotations_explanation_length_check`——两边名字本来就不同（既有漂移），只 drop
-- 其中一个会在另一半库上留下旧上限。两条都 drop，再统一加非空那条。
ALTER TABLE public.note_annotations
  DROP CONSTRAINT IF EXISTS note_annotations_explanation_check;
--> statement-breakpoint
ALTER TABLE public.note_annotations
  DROP CONSTRAINT IF EXISTS note_annotations_explanation_length_check;
--> statement-breakpoint
ALTER TABLE public.note_annotations
  ADD CONSTRAINT note_annotations_explanation_length_check CHECK (char_length(explanation) >= 1);
--> statement-breakpoint
COMMENT ON COLUMN public.note_annotations.explanation IS
  '白话解释正文。非空；长度不设本地上限，天花板只认模型档案声明的输出预算（0418）。';
