-- 0419：速看的要点条数与引用条数、脑图的节点数都不再设本地配额。
--
-- 这三条上限和 0412 去掉的正文上限是同一件事的另一半：正文放开了，要点仍卡在 6 条、
-- 引用卡在 32 条、脑图卡在 120 个节点——长笔记写出的东西在**落库那一刻**才失败，
-- 界面上只看到"这次生成没有完成"，而内容本身完全合法。
--
-- 条数由材料与模型输出额度决定（分段数不设上限、每段重点由内容定），存储这一层只管
-- 形状与非空：要点要么没有、要么至少一条；引用至少一条（没有可回原文的依据时，
-- handler 会先以"速看没有留下可回到原文的依据"收口，不靠库来挡）。
ALTER TABLE public.note_overviews
  DROP CONSTRAINT IF EXISTS note_overviews_overview_points_shape_check;
--> statement-breakpoint
ALTER TABLE public.note_overviews
  ADD CONSTRAINT note_overviews_overview_points_shape_check
  CHECK (
    overview_points IS NULL
    OR (jsonb_typeof(overview_points) = 'array' AND jsonb_array_length(overview_points) >= 1)
  );
--> statement-breakpoint
ALTER TABLE public.note_overviews
  DROP CONSTRAINT IF EXISTS note_overviews_source_references_shape_check;
--> statement-breakpoint
ALTER TABLE public.note_overviews
  ADD CONSTRAINT note_overviews_source_references_shape_check
  CHECK (jsonb_typeof(source_references) = 'array' AND jsonb_array_length(source_references) >= 1);
--> statement-breakpoint
-- 脑图：一张图有多少节点由材料决定（合同侧早已放开 `MIND_MAP_MAX_NODES`），
-- 库这边只留"至少两个节点才成图"。
ALTER TABLE public.note_mind_maps
  DROP CONSTRAINT IF EXISTS note_mind_maps_content_check;
--> statement-breakpoint
ALTER TABLE public.note_mind_maps
  ADD CONSTRAINT note_mind_maps_content_check
  CHECK (jsonb_typeof(content->'nodes') = 'array' AND jsonb_array_length(content->'nodes') >= 2);
