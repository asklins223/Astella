-- 0413：会话记住自己签发给了哪一种客户端（2026-10-11 产品规则）。
--
-- 规则是「手机上人不改笔记正文，伴星改」。伴星那条路没有 HTTP 入口
-- （`companion-edit-dispatch.ts` 走内部 tool call），所以这条规则在服务端的落点是
-- **拒掉来自手机会话的正文写入**，而不是拒掉一个请求头——头是调用方随时可以不带的
-- 东西，凭据才是改不了的。判据逐请求从这一行读回（`decodeToken`），
-- 谓词只有一处：`identity/middleware.ts` 的 `isNoteContentWriteForbiddenForSession`。
--
-- `DEFAULT 'desktop'` 是"桌面端一次调用都不用改"的那一半：不写这一列的签发路径
-- （切空间、导出导入夹具、既有会话行）自动留在桌面语义上。取值域写成 CHECK 而不
-- 只是 TS 里的 enum：这一列会被审计和排障直接读，非法值不该能待在库里。
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS client_kind text NOT NULL DEFAULT 'desktop';
--> statement-breakpoint
ALTER TABLE public.sessions
  DROP CONSTRAINT IF EXISTS sessions_client_kind_check;
--> statement-breakpoint
ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_client_kind_check CHECK (client_kind IN ('desktop', 'mobile'));
--> statement-breakpoint
COMMENT ON COLUMN public.sessions.client_kind IS
  '凭据签发时的客户端类型：desktop | mobile。mobile 会话不得写笔记正文（0413）；伴星改笔记走内部 tool call，不经过这里。';
