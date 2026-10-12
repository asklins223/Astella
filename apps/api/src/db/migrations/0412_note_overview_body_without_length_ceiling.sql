-- 速看正文是一发真实生成的产物：窗口更大的模型、更长的笔记都会写出超过两万字的一版。
-- 旧的 1..20000 CHECK 不会报错，它让落库直接失败，用户在界面上只看到"这次生成没有完成"。
-- 长度由输出额度与上下文预算管，存储这一层只管"有没有内容"。
ALTER TABLE public.note_overviews
  DROP CONSTRAINT IF EXISTS note_overviews_body_check;
--> statement-breakpoint
ALTER TABLE public.note_overviews
  ADD CONSTRAINT note_overviews_body_present_check CHECK (char_length(body) >= 1);
