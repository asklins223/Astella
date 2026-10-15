-- 0435：把末条 assistant 的思考明文（`reasoning_text`）随消息落库，跨运行带回。
--
-- 为什么要这一列（2026-10-14 网关三发实验，`scripts/probe-plaintext-reasoning.ts`）：
-- `companion_initiative` 这类主动轮的历史以她上一条回复收尾，没有新的用户回合。
-- 在「思考开 + 带工具」下，网关把这种形状当成"上一轮没说完要接着写"，于是要求
-- 把那条 assistant 产出时的 `reasoning_text` 原样交回，否则 400
-- 「The `reasoning_text` in the thinking mode must be passed back to the API」。
-- 同一条 assistant 消息的三种回传实测：
--   带 `reasoning_text` 明文 → 200；只带 `encrypted_content` → 400；完全不带 → 400。
--
-- 这与旧约束正面冲突：`provider-capabilities.ts` 与 `readResponsesReasoningHandles`
-- 都写着"明文思考不落库"，句柄里 `content` 在产出时就被剥掉——剥掉之后就再也凑不回
-- 网关要的那句话。2026-10-14 用户决定改这条约束（选择全量落库），本迁移是它的实现。
--
-- 与工具循环那条链**无关**：`companion_agent_tool_calls.reasoning_handles` 现存 243 行
-- 全部只有 encrypted_content、0 行含明文，而工具循环续跑实测能过
-- （`scripts/probe-reasoning-passback-v4.ts` 的 E 发）。要明文的只有"末条 assistant 收尾"
-- 这一个形状，所以工具循环那张表不改。
--
-- 授权：`roles.sql` 对 `companion_messages` 是表级 GRANT（INSERT/UPDATE），
-- 加列不产生新的权限对象，无需补 GRANT。
--
-- 回填：不回填。历史 assistant 消息的思考明文当时就没保存，无从复原；
-- 旧消息没有这一列的值时，装配侧走"末条 assistant 无明文"的既有路径（关思考），
-- 那是可接受的降级，不是缺陷。

ALTER TABLE public.companion_messages
  ADD COLUMN IF NOT EXISTS reasoning jsonb;

--> statement-breakpoint

COMMENT ON COLUMN public.companion_messages.reasoning IS
  '该条 assistant 消息产出时的 reasoning item（含 reasoning_text 明文），由模型经 provider 原样带回。2026-10-14 用户决定解除"明文思考不落库"约束（0435）：网关在思考模式下要求交回末条 assistant 的 reasoning_text，只带 encrypted_content 不够。user/system 消息恒为 NULL；仅当本轮 provider 返回了 reasoning item 才有值。';
