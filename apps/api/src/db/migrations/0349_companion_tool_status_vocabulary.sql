-- 0349: 让 `not_executed` / `unavailable` 落得到账本与 SSE（40b §3.2）。
--
-- ## 起因：这两个状态此前只活在一半的路上
--
-- `classifyCompanionToolFailure` 已经能给出 40b §3.2 的精确分类，但
-- `companion_agent_tool_calls.status` 的 CHECK（0331 建的那条）只认八个词，
-- 于是当时的选择是把它们**降一级**写进账本：
--
--     not_executed → failed      unavailable → blocked
--
-- 那是一个**收敛映射**，不是翻译。后果有三处：
--
--  1. **用户看到的与实际发生的对不上**。`unavailable`（能力这一轮没有）
--     被写成 `blocked`（被权限阻止），而 §3.2 明确要求 unavailable
--     「指出实际影响及可用替代」——「你不能看图」和「你被禁止看图」是两回事。
--  2. **doctor / 回放查不出真实原因**。诊断面只能看到 failed/blocked。
--  3. 状态机是单调的（`status IN ('requested','executing')` 才可推进），
--     一旦降级写下去就再也改不回来了。
--
-- ## 这次补的是哪一半
--
-- 把两个词加进 CHECK 与 shared 枚举，**删掉那个映射**。账本、SSE、doctor
-- 与模型侧从此说同一句话。
--
-- 仍然**不**入这一列的是 §3.2 的另外两类，它们性质不同：
--   - `folded` / `omitted` 说的是**注入**层（内容因预算没进上下文），
--     不是某一次调用的结果；
--   - `pending` 说的是**在途**，对应本表的 `executing` + 提案表的
--     `waiting_confirmation`。

--> statement-breakpoint

ALTER TABLE public.companion_agent_tool_calls
  DROP CONSTRAINT companion_agent_tool_calls_status_check;

--> statement-breakpoint

ALTER TABLE public.companion_agent_tool_calls
  ADD CONSTRAINT companion_agent_tool_calls_status_check
  CHECK (status IN (
    'requested', 'executing', 'waiting_confirmation', 'succeeded',
    'outcome_unknown', 'failed', 'blocked', 'expired',
    -- 40b §3.2：从未开始执行（改对参数再来一次有意义）
    'not_executed',
    -- 40b §3.2：所需能力这一轮不可用（重调同一个工具没有意义）
    'unavailable'
  ));

--> statement-breakpoint

COMMENT ON CONSTRAINT companion_agent_tool_calls_status_check
  ON public.companion_agent_tool_calls IS
  '40b §3.2 的调用级状态。not_executed / unavailable 与 failed / blocked 不可互相折叠：'
  '前者要求模型改参数或换能力，后者才是「试过了但没成」。'
  'folded/omitted 属注入层、pending 属在途，都不进这一列。';