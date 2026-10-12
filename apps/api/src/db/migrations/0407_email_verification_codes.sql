-- 邮箱验证码：注册验证、验证码登录、找回密码共用一张表。
--
-- 全局表，不按 workspace 隔离，也不启用 RLS——它在会话建立**之前**被读写
-- （登录/注册本来就没有 app.user_id 上下文），与 update_manifest_cache /
-- auth_rate_limits 同一类。不加 policy：sec01 的策略计数是硬断言，
-- 凭空加一条 policy 会让全库策略检查变红（见 0406 迁移的同款说明）。
--
-- 只存验证码摘要 sha256(purpose + email + code)，明文不落库；核对成功即删行，
-- 表里同一 (email, purpose) 至多一行、生命周期 ≤ 5 分钟。
--> statement-breakpoint
CREATE TABLE public.email_verification_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('register', 'login', 'reset_password')),
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX email_verification_codes_pair_idx
  ON public.email_verification_codes (email, purpose);
--> statement-breakpoint
CREATE INDEX email_verification_codes_expiry_idx
  ON public.email_verification_codes (expires_at);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.email_verification_codes TO astella_api;
