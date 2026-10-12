/**
 * 邮箱验证码：生成、落库、核对（注册验证 / 邮箱登录 / 找回密码共用）。
 *
 * 安全边界：
 * - 明文验证码不落库，只存 sha256(purpose + email + code)——摘要泄漏也
 *   不能跨用途、跨邮箱复用；核对用 timingSafeEqual。
 * - 6 位数字、5 分钟过期、每码最多 5 次尝试，核对成功即删行（单次使用）。
 * - 重发即覆盖同一 (email, purpose) 的旧行；发送与重发的限流在路由层
 *   （那里才有请求 IP 与统一的 RateLimiter 实例）。
 * - 反枚举：login / reset_password 用途下邮箱不存在时**不发信但照常返回成功**，
 *   与真实发送的响应不可区分；register 用途邮箱已存在才报 email_exists
 *   （register-v2 本来就会公开这个事实，藏它没有收益）。
 *
 * DB 访问经 `database` 形参注入（默认 `db`，与 PostgresRateLimitStore 的
 * 构造默认值同一惯例）：这张表无 RLS、在会话建立之前读写，进不了 actor 事务，
 * 但**可注入**这一条不能丢——不连库的单测靠它。
 */

import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { emailVerificationCodes } from "@astella/shared/db-schema/identity";
import {
  EmailChannelUnavailableError,
  EmailSendFailedError,
  sendOutboundEmail,
} from "../../lib/outbound-email.ts";
import { buildVerificationEmail, type EmailCodePurpose } from "./verification-email.ts";
import { findLoginUserByEmail } from "./session-service.ts";

export type { EmailCodePurpose };

export const EMAIL_CODE_TTL_MS = 5 * 60 * 1000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;

/** 注入缝：只需要这一张表的四种语句构造能力。 */
export type EmailCodeDatabase = Pick<typeof db, "select" | "insert" | "update" | "delete">;

export type IssueEmailCodeResult =
  | { ok: true }
  | { ok: false; error: "email_exists" | "channel_unavailable" | "send_failed" };

/**
 * 注册验证码的**显式开发旁路**：只有环境变量写着 `true` 才跳过。
 *
 * 默认值是"强制"——生产 compose 不配这个变量，注册就必须过邮箱这一关；
 * 集测与无凭据的本地开发要跑注册流程时显式声明它，而不是靠"通道没配所以不算数"
 * 那种隐式降级（那会让配错凭据的生产环境静默变成不设防）。
 */
export function emailVerificationDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EMAIL_VERIFICATION_DISABLED?.trim().toLowerCase() === "true";
}

export type EmailCodeVerifyError = "invalid" | "expired" | "too_many_attempts";

export type VerifyEmailCodeResult =
  | { ok: true }
  | { ok: false; error: EmailCodeVerifyError };

/** 核对失败的统一错误体：三种失败分开说人话，但都不区分"账号在不在"。 */
export const EMAIL_CODE_VERIFY_MESSAGES: Record<
  EmailCodeVerifyError,
  { status: number; error: string; message: string }
> = {
  invalid: { status: 400, error: "invalid_code", message: "验证码不正确。" },
  expired: { status: 400, error: "expired_code", message: "验证码已过期，请重新获取。" },
  too_many_attempts: {
    status: 400,
    error: "code_attempts_exhausted",
    message: `验证码尝试次数过多（最多 ${EMAIL_CODE_MAX_ATTEMPTS} 次），请重新获取。`,
  },
};

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashCode(purpose: EmailCodePurpose, email: string, code: string): string {
  return createHash("sha256").update(`${purpose}\n${email}\n${code}`).digest("hex");
}

/**
 * 生成并发送一枚验证码，覆盖同 (email, purpose) 的旧码。
 * 发送失败时把刚写的行删掉、不留一个"发不出却存在"的码。
 */
export async function issueEmailCode(
  emailInput: string,
  purpose: EmailCodePurpose,
  database: EmailCodeDatabase = db,
): Promise<IssueEmailCodeResult> {
  // 落库与摘要都用归一化形态：发码与校验可能来自不同端点，字符串必须一致。
  const email = emailInput.trim().toLowerCase();
  const user = await findLoginUserByEmail(email);
  if (purpose === "register") {
    if (user) return { ok: false, error: "email_exists" };
  } else if (!user) {
    // 反枚举：邮箱不存在也走完整发送路径的成功分支，但不真的发信。
    return { ok: true };
  }

  const code = generateCode();
  const now = new Date();
  // 顺手清掉全表已过期的码：这张表的行生命周期 ≤ TTL，不该有常驻垃圾。
  await database.delete(emailVerificationCodes).where(lt(emailVerificationCodes.expiresAt, now));
  await database
    .delete(emailVerificationCodes)
    .where(
      and(
        eq(emailVerificationCodes.email, email),
        eq(emailVerificationCodes.purpose, purpose),
      ),
    );
  await database.insert(emailVerificationCodes).values({
    email,
    purpose,
    codeHash: hashCode(purpose, email, code),
    expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS),
  });

  try {
    const mail = buildVerificationEmail(purpose, code);
    await sendOutboundEmail({ to: email, ...mail });
  } catch (error) {
    // 发不出去的码不能留在库里：它对用户不可见，只会让下次重发白覆盖一次。
    await database
      .delete(emailVerificationCodes)
      .where(
        and(
          eq(emailVerificationCodes.email, email),
          eq(emailVerificationCodes.purpose, purpose),
        ),
      );
    if (error instanceof EmailChannelUnavailableError) return { ok: false, error: "channel_unavailable" };
    if (error instanceof EmailSendFailedError) return { ok: false, error: "send_failed" };
    throw error;
  }
  return { ok: true };
}

/** 核对一枚验证码；成功即消费（删行），失败按次数上限逐步作废。 */
export async function verifyEmailCode(
  emailInput: string,
  purpose: EmailCodePurpose,
  code: string,
  database: EmailCodeDatabase = db,
): Promise<VerifyEmailCodeResult> {
  const email = emailInput.trim().toLowerCase();
  const [row] = await database
    .select()
    .from(emailVerificationCodes)
    .where(
      and(
        eq(emailVerificationCodes.email, email),
        eq(emailVerificationCodes.purpose, purpose),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, error: "invalid" };

  const consume = () =>
    database
      .delete(emailVerificationCodes)
      .where(eq(emailVerificationCodes.id, row.id));

  if (row.expiresAt.getTime() <= Date.now()) {
    await consume();
    return { ok: false, error: "expired" };
  }
  if (row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
    await consume();
    return { ok: false, error: "too_many_attempts" };
  }

  const expected = Buffer.from(row.codeHash, "hex");
  const actual = Buffer.from(hashCode(purpose, email, code), "hex");
  const matched = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!matched) {
    await database
      .update(emailVerificationCodes)
      .set({ attempts: row.attempts + 1 })
      .where(eq(emailVerificationCodes.id, row.id));
    return { ok: false, error: "invalid" };
  }

  await consume();
  return { ok: true };
}
