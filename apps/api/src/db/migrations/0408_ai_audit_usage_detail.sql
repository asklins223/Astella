-- 缓存命中与请求/产出拆分：前缀缓存要优化，先要能看见它。
--
-- `ai_audit_log` 原来只有一个 `cost_tokens` 总数。provider 交回的
-- `promptTokens`／`completionTokens`／`cacheHitTokens` 在 `opencode-go.ts:285`
-- 和 `json-response.ts:104` 解析出来之后就被丢掉了，于是这三件事无法回答：
-- 上游到底有没有命中前缀缓存、命中多少、一次请求里输入占多大头。
-- 2026-10-11 的探针实测这个网关会缓存（逐字相同的请求第二遍 12,288/12,512 命中，
-- 而把每轮必变的时钟从第 4 块挪到尾部后，时钟跳一格命中率不掉），
-- 但那是隔离实验的读数；要判断重排在生产上真的省下多少，得让每一次真实调用自己带数。
--
-- 这三列**只作观测**，不参与预算：`measure-request.ts` 的计数端口刻意不接
-- `cacheHitTokens`（`measure-request.test.ts:174` 记着原因——不给字段，就没人能
-- 顺手把缓存当作免费的输入去放宽预算）。这条边界不能因为列有了就被绕过。
ALTER TABLE public.ai_audit_log ADD COLUMN IF NOT EXISTS prompt_tokens integer;
--> statement-breakpoint
ALTER TABLE public.ai_audit_log ADD COLUMN IF NOT EXISTS completion_tokens integer;
--> statement-breakpoint
ALTER TABLE public.ai_audit_log ADD COLUMN IF NOT EXISTS cached_tokens integer;
