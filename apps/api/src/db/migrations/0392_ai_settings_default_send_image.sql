-- 「允许发送图片内容」的默认值改到**数据库这一侧**（2026-10-06 用户决定）。
--
-- ## 为什么光改代码不够
--
-- 新账号那一行不是由业务代码填出来的：`getAIPrivacySettings` 走的是
-- `insert(userAiSettings).values({ userId })`——只给主键，`data_policy` 由
-- **列默认值**决定。所以 2026-10-06 把 `packages/shared/src/db-schema/identity.ts`
-- 里的 `.default({...sendImageContent: true})` 改掉之后，**没有迁移去改列默认值**，
-- 库里仍然是 `sendImageContent: false`。
--
-- ## 这是怎么被发现的
--
-- 真窗口验证输入框传图：注册一个新账号 → 在设置里签了 AI 同意 → 传一张图问伴星，
-- 她回的是失败兜底那句「我走神了一下下」。库里这一轮的状态是 dead，
-- worker 报 `AIDataPolicyDeniedError`；查 `user_ai_settings` 那一行，
-- `data_policy.sendImageContent` 是 **false**——正是列默认值，而不是用户选的。
-- 换句话说：那份「默认打开」的决定只活在 TS 里，从没落到这台库的形状上。
--
-- ## 只改默认值，不动既有行
--
-- 已经存在的行**一律不改**：今天这一列里 `false` 有两种来源——列默认值给的，
-- 和用户自己在设置里关掉的——两者在数据上无法区分。默认值只影响**之后新建**的
-- 那一行，这是能做到的最小改动，也不会把任何人已经收回的授权重新打开。
--
-- `sendToExternal` 保持 **false**：那一道仍是「签了同意 + 用户明确允许外发」才开，
-- 与 `ai-consent-service.ts` 上面那句「绝不自动授权」同源。图片这一项管的只是
-- 「已经允许外发之后，图片这一路是否也放行」。

ALTER TABLE public.user_ai_settings
  ALTER COLUMN data_policy
  SET DEFAULT '{"auditLogging": true, "piiDetection": true, "sendToExternal": false, "sendImageContent": true}'::jsonb;
