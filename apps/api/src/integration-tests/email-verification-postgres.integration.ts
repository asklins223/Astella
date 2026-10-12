/**
 * 邮箱验证码三链路的真库验收：注册验证、验证码登录、找回密码。
 *
 * 三态都钉：
 * - **开发旁路**（`EMAIL_VERIFICATION_DISABLED=true`）：注册不要求验证码——
 *   集测与无凭据的本地开发靠这一条，生产 compose 不透传该变量；
 * - **强制 + 通道未配置**：发码 503 `email_channel_unavailable`；注册不带码也回
 *   503——谁都拿不到码，这是服务端配置问题，不该让人去升级没出错的客户端；
 * - **强制 + 通道已配置**：注册不带码 = 只有旧客户端才会这样 → 400
 *   `client_update_required`；带有效码能建号（码一次性）；验证码登录发会话；
 *   找回密码改密后旧密码作废、新密码可登录；过期码进不去。
 *
 * 码**不靠真发信取得**：测试往 `email_verification_codes` 直插一行（摘要算法
 * 与服务端同一份 sha256(purpose\\nemail\\ncode)），这样整份测试不依赖外网与
 * 真实邮箱凭据——真发信属于真窗验收。通道与旁路的判据都在请求时读 env，
 * 所以三种状态可以在同一进程里切换。
 *
 * 真实 Postgres（夹具 = 超级用户连接，被测 = 应用自己的连接池）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { authRoutes } from "../modules/identity/routes.ts";
import { emailCodeRoutes } from "../modules/identity/email-code-routes.ts";

const CONN = process.env.DATABASE_URL ?? process.env.DATABASE_URL_API;
if (!CONN) {
  throw new Error("DATABASE_URL 未配置——邮箱验证码集成测试要求真实 Postgres");
}

const sql = postgres(CONN, { max: 3 });

const tag = randomUUID().slice(0, 8);
const EMAIL_EXISTING = `emailcode-a-${tag}@example.test`;
const EMAIL_BYPASS = `emailcode-b-${tag}@example.test`;
const EMAIL_GATED = `emailcode-c-${tag}@example.test`;
const PASSWORD = "initial-pass-123";
const RESET_PASSWORD = "reset-pass-456";

/** 与 email-code-service 同一份摘要算法；两处任一改动这里都会红。 */
function hashOf(purpose: string, email: string, code: string): string {
  return createHash("sha256").update(`${purpose}\n${email}\n${code}`).digest("hex");
}

async function insertCode(
  email: string,
  purpose: string,
  code: string,
  options: { expired?: boolean } = {},
): Promise<void> {
  const expiresAt = options.expired
    ? new Date(Date.now() - 60_000)
    : new Date(Date.now() + 5 * 60_000);
  await sql`
    INSERT INTO email_verification_codes (email, purpose, code_hash, expires_at)
    VALUES (${email}, ${purpose}, ${hashOf(purpose, email, code)}, ${expiresAt})
  `;
}

let app: FastifyInstance;

const savedEnv = new Map<string, string | undefined>();
for (const name of ["EMAIL_QQ_USER", "EMAIL_QQ_PASS", "EMAIL_QQ_FROM", "EMAIL_2925_USER", "EMAIL_2925_PASS", "EMAIL_2925_FROM", "EMAIL_VERIFICATION_DISABLED"]) {
  savedEnv.set(name, process.env[name]);
  delete process.env[name];
}
// 这份文件的靶子不是登录限流，是三条链路的读写；默认 5 次/15 分钟会被本文件
// 自己的正反用例耗光。放宽到 50 只影响本进程，测完还原。
savedEnv.set("AUTH_RATE_LIMIT_MAX_ATTEMPTS", process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS);
process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS = "50";

before(async () => {
  app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(authRoutes);
  await app.register(emailCodeRoutes);
  await app.ready();
});

after(async () => {
  await app.close();
  await sql`DELETE FROM email_verification_codes WHERE email LIKE ${`emailcode-%${tag}@example.test`}`;
  await sql`DELETE FROM users WHERE email IN (${EMAIL_EXISTING}, ${EMAIL_BYPASS}, ${EMAIL_GATED})`.catch(() => undefined);
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await sql.end();
});

function post(
  url: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: string; json(): any }> {
  return app.inject({ method: "POST", url, payload });
}

test("开发旁路：声明后注册不要求验证码", async () => {
  process.env.EMAIL_VERIFICATION_DISABLED = "true";

  const seeded = await post("/auth/register-v2", {
    email: EMAIL_EXISTING,
    password: PASSWORD,
  });
  assert.equal(seeded.statusCode, 200, `旁路下建预置账号应成功：${seeded.body}`);

  const bypassed = await post("/auth/register-v2", {
    email: EMAIL_BYPASS,
    password: PASSWORD,
  });
  assert.equal(bypassed.statusCode, 200, `旁路下注册不该要验证码：${bypassed.body}`);
});

test("强制 + 通道未配置：发码与注册都回 503，不说成客户端过旧", async () => {
  delete process.env.EMAIL_VERIFICATION_DISABLED;

  const send = await post("/auth/email-code", { email: EMAIL_EXISTING, purpose: "login" });
  assert.equal(send.statusCode, 503, send.body);
  assert.equal(send.json().error, "email_channel_unavailable");

  const registered = await post("/auth/register-v2", {
    email: EMAIL_GATED,
    password: PASSWORD,
  });
  assert.equal(registered.statusCode, 503, registered.body);
  assert.equal(registered.json().error, "email_channel_unavailable");
});

test("强制 + 通道已配置：不带码 = 旧客户端，带有效码能建号", async () => {
  // 测试专用的假凭据：只让"配置判据"成立；本用例不走真发信。
  process.env.EMAIL_QQ_USER = `probe-${tag}@example.test`;
  process.env.EMAIL_QQ_PASS = "not-a-real-authcode";

  const missing = await post("/auth/register-v2", {
    email: EMAIL_GATED,
    password: PASSWORD,
  });
  assert.equal(missing.statusCode, 400, missing.body);
  assert.equal(missing.json().error, "client_update_required");

  await insertCode(EMAIL_GATED, "register", "042517");
  const withCode = await post("/auth/register-v2", {
    email: EMAIL_GATED,
    password: PASSWORD,
    emailCode: "042517",
  });
  assert.equal(withCode.statusCode, 200, `带有效码注册应成功：${withCode.body}`);
  assert.ok(withCode.json().token, "注册回执必须带令牌");

  // 码是一次性的：同一个码再来一次进不去。
  const replay = await post("/auth/register-v2", {
    email: `${randomUUID().slice(0, 8)}-${tag}@example.test`,
    password: PASSWORD,
    emailCode: "042517",
  });
  assert.equal(replay.statusCode, 400, replay.body);
  assert.equal(replay.json().error, "invalid_code");
});

test("验证码登录：错码 400，对码发会话", async () => {
  const wrong = await post("/auth/login-with-code", {
    email: EMAIL_EXISTING,
    code: "000000",
    remember: false,
  });
  assert.equal(wrong.statusCode, 400, wrong.body);
  assert.equal(wrong.json().error, "invalid_code");

  await insertCode(EMAIL_EXISTING, "login", "135790");
  const ok = await post("/auth/login-with-code", {
    email: EMAIL_EXISTING,
    code: "135790",
    remember: false,
  });
  assert.equal(ok.statusCode, 200, `验证码登录应成功：${ok.body}`);
  const session = ok.json();
  assert.ok(session.token, "登录回执必须带令牌");
  assert.ok(session.ctx?.userId, "登录回执必须带用户");
});

test("验证码登录不回答邮箱在不在：没注册与输错码回的是同一个体", async () => {
  const ghost = `emailcode-e-${tag}@example.test`;
  const missing = await post("/auth/login-with-code", {
    email: ghost,
    code: "111111",
    remember: false,
  });
  const wrong = await post("/auth/login-with-code", {
    email: EMAIL_EXISTING,
    code: "222222",
    remember: false,
  });
  // 这一条钉的是路由里那句"这条路不回答邮箱在不在"。此前先查账号再核对码，
  // 没注册的邮箱会拿到 401，界面把它翻成「当前密码不正确，请重新输入」——
  // 既把账号存在与否说了出来，又指着一屏里根本没有的密码格。
  assert.equal(missing.statusCode, 400, missing.body);
  assert.deepEqual(missing.json(), wrong.json(), "两种失败必须一字不差地一样");

  const [noUser] = await sql`SELECT 1 FROM users WHERE email = ${ghost}`;
  assert.equal(noUser, undefined, "被拒的这次不该留下任何账号");
});

test("找回密码：码有效则 204，旧密码作废、新密码可登录", async () => {
  await insertCode(EMAIL_EXISTING, "reset_password", "246810");
  const reset = await post("/auth/reset-password", {
    email: EMAIL_EXISTING,
    code: "246810",
    newPassword: RESET_PASSWORD,
  });
  assert.equal(reset.statusCode, 204, reset.body);

  const oldPassword = await post("/auth/login", {
    email: EMAIL_EXISTING,
    password: PASSWORD,
    remember: false,
  });
  assert.equal(oldPassword.statusCode, 401, `改密后旧密码必须失效：${oldPassword.body}`);

  const newPassword = await post("/auth/login", {
    email: EMAIL_EXISTING,
    password: RESET_PASSWORD,
    remember: false,
  });
  assert.equal(newPassword.statusCode, 200, `新密码应能登录：${newPassword.body}`);
});

test("当日额度：一个邮箱一天 20 封，第 21 封被挡下", async () => {
  const cappedEmail = `emailcode-d-${tag}@example.test`;
  // 冷却/时额度会让 20 次真请求跑不完，直接给当日桶打底：判据看的是闸门本身。
  await sql`
    INSERT INTO auth_rate_limits (bucket_key, count, reset_at, updated_at)
    VALUES (${`emailcode:day:${cappedEmail}`}, 20, now() + interval '6 hours', now())
    ON CONFLICT (bucket_key) DO UPDATE SET "count" = 20
  `;

  const send = await post("/auth/email-code", { email: cappedEmail, purpose: "login" });
  assert.equal(send.statusCode, 429, send.body);
  assert.equal(send.json().error, "daily_limit_reached");
  await sql`DELETE FROM auth_rate_limits WHERE bucket_key = ${`emailcode:day:${cappedEmail}`}`;
});

test("过期码：即使码本身正确也进不去，行被作废", async () => {
  await insertCode(EMAIL_EXISTING, "login", "999999", { expired: true });
  const expired = await post("/auth/login-with-code", {
    email: EMAIL_EXISTING,
    code: "999999",
    remember: false,
  });
  assert.equal(expired.statusCode, 400, expired.body);
  assert.equal(expired.json().error, "expired_code");

  const [left] = await sql`
    SELECT 1 FROM email_verification_codes
    WHERE email = ${EMAIL_EXISTING} AND purpose = 'login'
  `;
  assert.equal(left, undefined, "过期码应当被删掉，不留第二次机会");
});
