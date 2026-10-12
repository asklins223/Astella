/**
 * 邮箱验证码的三条链路：发码、验证码登录、找回密码。
 *
 * 与 password 登录同一套限流惯例（IP + 双因子 key、Retry-After、成功才 reset），
 * 限流计数落在与 routes.ts 同一个 store 里——`auth:login:*` 的 key 直接复用，
 * 密码登录与验证码登录共享同一份爆破预算。
 *
 * 通道未配置（QQ/2925 都没配齐）时发码返回 503。注册端点**默认强制**验证码，
 * 只有显式 `EMAIL_VERIFICATION_DISABLED=true` 才跳过（见 routes.ts 的 register-v2）；
 * 发码本身不看这个旁路——没有通道就是发不出信，这是事实不是策略。
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody } from "../../lib/validate.ts";
import {
  createRateLimitStoreFromEnv,
  RateLimiter,
} from "../../lib/rate-limit-store.ts";
import { isEmailChannelConfigured } from "../../lib/outbound-email.ts";
import {
  EMAIL_CODE_VERIFY_MESSAGES,
  issueEmailCode,
  verifyEmailCode,
  type EmailCodePurpose,
} from "./email-code-service.ts";
import {
  establishLoginSession,
  findLoginUserByEmail,
  resetPassword,
} from "./session-service.ts";
import { positiveIntegerEnv, setSessionCookies } from "./routes.ts";
import { sessionClientKindSchema } from "./middleware.ts";

const emailSchema = z
  .string()
  .trim()
  .email()
  .max(320)
  .transform((email) => email.toLowerCase());
const codeSchema = z.string().trim().regex(/^\d{6}$/, "验证码为 6 位数字");

const emailCodeSchema = z.object({
  email: emailSchema,
  purpose: z.enum(["register", "login", "reset_password"]),
});

const RESEND_SECONDS = 60;

/**
 * 一个邮箱账号一天最多这么多封验证码。
 *
 * 发信走的是外部个人邮箱（QQ 普通账号日限约 100 封，2925 未公开），
 * 配额是对方给的、不是我们承诺的：按账号收 20 封，既够一个人反复注册/
 * 登录/找回用一天，也不会让一个脚本把整台服务器的发信额度烧光。
 */
export const EMAIL_CODE_DAILY_LIMIT = 20;

/** 单个邮箱一小时的发码次数：key 只看邮箱，所以换用途也占这一格。 */
export const EMAIL_CODE_HOURLY_LIMIT = 5;

function retryAfterSeconds(resetAt: number): number {
  return Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
}

export async function emailCodeRoutes(app: FastifyInstance) {
  const store = createRateLimitStoreFromEnv();
  const cleanupTimer = setInterval(() => {
    void store.sweep?.(Date.now());
  }, 5 * 60 * 1000);
  cleanupTimer.unref?.();

  // 与密码登录同参数、同 key 前缀：两条登录路共享一份爆破预算。
  const loginLimiter = new RateLimiter(store, {
    windowMs: positiveIntegerEnv("AUTH_RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000),
    maxAttempts: positiveIntegerEnv("AUTH_RATE_LIMIT_MAX_ATTEMPTS", 5),
  });
  const resetLimiter = new RateLimiter(store, {
    windowMs: 15 * 60 * 1000,
    maxAttempts: 5,
  });
  const sendCooldown = new RateLimiter(store, { windowMs: 60 * 1000, maxAttempts: 1 });
  const sendPerEmailHour = new RateLimiter(store, { windowMs: 60 * 60 * 1000, maxAttempts: EMAIL_CODE_HOURLY_LIMIT });
  const sendPerIpHour = new RateLimiter(store, { windowMs: 60 * 60 * 1000, maxAttempts: 15 });
  const sendPerEmailDay = new RateLimiter(store, {
    windowMs: 24 * 60 * 60 * 1000,
    maxAttempts: EMAIL_CODE_DAILY_LIMIT,
  });

  // POST /auth/email-code — 发一枚验证码（三种用途共用一个端点）。
  app.post("/auth/email-code", async (req, reply) => {
    if (!isEmailChannelConfigured()) {
      return reply
        .code(503)
        .send({ error: "email_channel_unavailable", message: "邮箱验证通道尚未配置，请稍后再试。" });
    }
    const body = parseBody(app, emailCodeSchema, req.body);
    const purpose: EmailCodePurpose = body.purpose;

    // 守卫顺序从宽到严：IP 时 quota → 邮箱当日额度 → 邮箱时 quota → 60s 重发冷却。
    // 冷却计数最后 consume，前面被拒时用户不用白等一分钟。
    const ipDecision = await sendPerIpHour.consume(`emailcode:send:ip:${req.ip}`);
    if (!ipDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(ipDecision.resetAt));
      return reply.code(429).send({ error: "rate_limited", message: "请求过于频繁，请稍后再试。" });
    }
    const dayDecision = await sendPerEmailDay.consume(`emailcode:day:${body.email}`);
    if (!dayDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(dayDecision.resetAt));
      return reply.code(429).send({
        error: "daily_limit_reached",
        message: `这个邮箱今天已经发了 ${EMAIL_CODE_DAILY_LIMIT} 封验证码，请明天再试。`,
      });
    }
    const emailDecision = await sendPerEmailHour.consume(`emailcode:send:email:${body.email}`);
    if (!emailDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(emailDecision.resetAt));
      return reply.code(429).send({ error: "rate_limited", message: `这个邮箱一小时内已经要了 ${EMAIL_CODE_HOURLY_LIMIT} 次验证码，请稍后再试。` });
    }
    const cooldownDecision = await sendCooldown.consume(`emailcode:cooldown:${purpose}:${body.email}`);
    if (!cooldownDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(cooldownDecision.resetAt));
      return reply.code(429).send({ error: "resend_too_soon", message: "发送太频繁了，请一分钟后再试。" });
    }

    const result = await issueEmailCode(body.email, purpose);
    if (!result.ok) {
      // 没发出去就不该占着冷却：把刚 consume 的一分钟还回来，允许立即重试。
      await sendCooldown.reset(`emailcode:cooldown:${purpose}:${body.email}`);
      if (result.error === "email_exists") {
        return reply
          .code(409)
          .send({ error: "email_exists", message: "该邮箱已注册，直接登录即可。" });
      }
      return reply
        .code(503)
        .send({ error: "email_send_failed", message: "验证码邮件发送失败，请稍后再试。" });
    }
    return { ok: true, resendInSeconds: RESEND_SECONDS };
  });

  // POST /auth/login-with-code — 邮箱验证码免密登录。
  const loginWithCodeSchema = z.object({
    email: emailSchema,
    code: codeSchema,
    remember: z.boolean().optional().default(false),
    // 0413：与 /auth/login 同一格——两条登录路共用 `establishLoginSession`，
    // 所以"这枚凭据给了手机"这件事只需要在签发那一站落一次。
    clientKind: sessionClientKindSchema,
  });
  app.post("/auth/login-with-code", async (req, reply) => {
    const ip = req.ip;
    const ipKey = `auth:login:ip:${ip}`;
    const ipDecision = await loginLimiter.consume(ipKey);
    if (!ipDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(ipDecision.resetAt));
      return reply.code(429).send({ error: "rate_limited", message: "登录尝试过于频繁，请稍后重试" });
    }
    const body = parseBody(app, loginWithCodeSchema, req.body);
    const emailKey = `auth:login:email:${body.email}`;
    const emailDecision = await loginLimiter.consume(emailKey);
    if (!emailDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(emailDecision.resetAt));
      return reply.code(429).send({ error: "rate_limited", message: "该账号登录尝试过于频繁，请稍后重试" });
    }

    // 这条路不回答"邮箱在不在"：**先核对码，再看账号**。没注册的邮箱在码表里本就
    // 没有行，核对结果就是 invalid——与输错码回的是同一个体。反过来先查账号就会分叉：
    // 401 那一路在界面上是「当前密码不正确，请重新输入」，既当场说出这个邮箱没注册过，
    // 又指着一屏里根本不存在的密码格。
    const verification = await verifyEmailCode(body.email, "login", body.code);
    const user = await findLoginUserByEmail(body.email);
    if (!verification.ok) {
      const mapped = EMAIL_CODE_VERIFY_MESSAGES[verification.error];
      return reply.code(mapped.status).send({ error: mapped.error, message: mapped.message });
    }
    // 码是对的，账号却没了（发码之后被删除）：码已消费，只能重新发起。
    if (!user) {
      throw app.httpErrors.unauthorized("invalid credentials");
    }
    const result = await establishLoginSession(user, body.clientKind);
    if (!result) {
      throw app.httpErrors.unauthorized("invalid credentials");
    }
    // 与 /auth/login 相同：成功登录只重置邮箱计数，IP 计数不重置。
    await loginLimiter.reset(emailKey);
    const csrfToken = setSessionCookies(reply, result.token, body.remember);
    return { ...result, csrfToken };
  });

  // POST /auth/reset-password — 邮箱验证码找回密码（成功即撤销全部会话）。
  const resetPasswordSchema = z.object({
    email: emailSchema,
    code: codeSchema,
    newPassword: z.string().min(8).max(200),
  });
  app.post("/auth/reset-password", async (req, reply) => {
    const ipKey = `auth:reset:ip:${req.ip}`;
    const ipDecision = await resetLimiter.consume(ipKey);
    if (!ipDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(ipDecision.resetAt));
      return reply.code(429).send({ error: "rate_limited", message: "操作过于频繁，请稍后重试。" });
    }
    const body = parseBody(app, resetPasswordSchema, req.body);
    const emailKey = `auth:reset:email:${body.email}`;
    const emailDecision = await resetLimiter.consume(emailKey);
    if (!emailDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(emailDecision.resetAt));
      return reply.code(429).send({ error: "rate_limited", message: "该账号操作过于频繁，请稍后重试。" });
    }

    const verification = await verifyEmailCode(body.email, "reset_password", body.code);
    if (!verification.ok) {
      const mapped = EMAIL_CODE_VERIFY_MESSAGES[verification.error];
      return reply.code(mapped.status).send({ error: mapped.error, message: mapped.message });
    }
    const user = await findLoginUserByEmail(body.email);
    // 码是本人的但账号已不存在（发码后被删除）：码已消费，要求重新走流程。
    if (!user) {
      return reply
        .code(400)
        .send({ error: "account_unavailable", message: "账号状态已变化，请重新发起找回。" });
    }
    await resetPassword(user.id, body.newPassword);
    await resetLimiter.reset(emailKey);
    reply.header("Cache-Control", "no-store");
    return reply.code(204).send();
  });
}
