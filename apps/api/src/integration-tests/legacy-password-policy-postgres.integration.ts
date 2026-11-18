import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { hashPassword } from "../modules/identity/credentials.ts";
import { authRoutes } from "../modules/identity/routes.ts";
import { emailCodeRoutes } from "../modules/identity/email-code-routes.ts";
import { MemoryRateLimitStore } from "../lib/rate-limit-store.ts";
import { closeDatabase } from "../db/client.ts";
import { changePassword, decodeToken, establishLoginSession, findLoginUserByEmail, revokeSession } from "../modules/identity/session-service.ts";
import { leaveWorkspace, switchWorkspace } from "../modules/identity/workspace-membership-service.ts";
import { captureSmtp } from "./fixtures/capture-smtp.ts";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 1 });
const restricted = postgres(testDatabaseUrl("DATABASE_URL_API"), { max: 1 });
const legacyId = randomUUID();
const modernId = randomUUID();
const workspaceId = randomUUID();
const personalWorkspaceId = randomUUID();
const legacyEmail = `legacy-${legacyId}@astella.test`;
const modernEmail = `modern-${modernId}@astella.test`;
const legacyPassword = `${"x".repeat(72)}original`;
const modernPassword = "modern-password-example";
const resetPasswordValue = "reset-password-example";
const allowApp = Fastify({ logger: false });
const resetApp = Fastify({ logger: false });

before(async () => {
  const [role] = await restricted`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`;
  assert.equal(role.rolbypassrls, false);
  assert.equal(role.rolsuper, false);
  const legacyHash = await bcrypt.hash(legacyPassword, 4);
  const modernHash = await hashPassword(modernPassword);
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id,email,password_hash) VALUES
      (${legacyId},${legacyEmail},${legacyHash}),(${modernId},${modernEmail},${modernHash})`;
    await tx`INSERT INTO workspaces (id,owner_id,name,workspace_type)
      VALUES (${workspaceId},${legacyId},'legacy password policy test','collaborative'),
        (${personalWorkspaceId},${modernId},'personal workspace test','personal')`;
    await tx`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES
      (${workspaceId},${legacyId},'owner'),(${workspaceId},${modernId},'member'),
      (${personalWorkspaceId},${modernId},'owner')`;
    await tx`UPDATE users SET personal_workspace_id = ${personalWorkspaceId} WHERE id = ${modernId}`;
  });
  await allowApp.register(sensible);
  await resetApp.register(sensible);
  const previousPolicy = process.env.AUTH_LEGACY_PASSWORD_POLICY;
  const previousUser = process.env.EMAIL_QQ_USER;
  const previousPass = process.env.EMAIL_QQ_PASS;
  try {
    delete process.env.AUTH_LEGACY_PASSWORD_POLICY; // exercise the compatibility default
    await allowApp.register(authRoutes, { rateLimitStore: new MemoryRateLimitStore(), rateLimitMaxAttempts: 100 });
    await allowApp.ready();
    process.env.AUTH_LEGACY_PASSWORD_POLICY = "require_reset";
    // Configuration is required for registration; no mail is sent by this test.
    process.env.EMAIL_QQ_USER = "configured@example.test";
    process.env.EMAIL_QQ_PASS = "dummy-test-value";
    await resetApp.register(authRoutes, { rateLimitStore: new MemoryRateLimitStore(), rateLimitMaxAttempts: 100 });
    await resetApp.register(emailCodeRoutes, { rateLimitStore: new MemoryRateLimitStore() });
    await resetApp.ready();
  } finally {
    for (const [key, value] of Object.entries({
      AUTH_LEGACY_PASSWORD_POLICY: previousPolicy,
      EMAIL_QQ_USER: previousUser,
      EMAIL_QQ_PASS: previousPass,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

after(async () => {
  try {
    await Promise.all([allowApp.close(), resetApp.close()]);
    await admin.begin(async (tx) => {
      await tx`DELETE FROM email_verification_codes WHERE email IN (${legacyEmail},${modernEmail})`;
      await tx`DELETE FROM sessions WHERE user_id IN (${legacyId},${modernId})`;
      await tx`UPDATE users SET personal_workspace_id = NULL WHERE id = ${modernId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id IN (${workspaceId}, ${personalWorkspaceId})`;
      await tx`DELETE FROM workspaces WHERE id IN (${workspaceId}, ${personalWorkspaceId})`;
      await tx`DELETE FROM users WHERE id IN (${legacyId},${modernId})`;
    });
  } finally {
    await Promise.all([admin.end(), restricted.end(), closeDatabase()]);
  }
});

test("strict rollout rejects legacy passwords and recovers the account with an SMTP-delivered code", async (t) => {
  const login = (app: typeof allowApp, email: string, password: string) =>
    app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  assert.equal((await login(allowApp, legacyEmail, legacyPassword)).statusCode, 200);
  for (const password of [legacyPassword, `${"x".repeat(72)}different`]) {
    assert.equal((await login(resetApp, legacyEmail, password)).statusCode, 401);
  }
  const [before] = await admin`SELECT password_hash FROM users WHERE id = ${legacyId}`;
  assert.match(before.password_hash, /^\$2[aby]\$/);
  assert.equal((await login(resetApp, modernEmail, modernPassword)).statusCode, 200);

  const smtp = await captureSmtp();
  const smtpSettings = {
    EMAIL_QQ_USER: "sender@astella.test",
    EMAIL_QQ_PASS: "dummy-test-value",
    EMAIL_QQ_FROM: "sender@astella.test",
  };
  const previous = Object.keys(smtpSettings).map(key => [key, process.env[key]] as const);
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await smtp.close();
  });
  Object.assign(process.env, smtpSettings);
  const createTransport = nodemailer.createTransport.bind(nodemailer);
  t.mock.method(nodemailer, "createTransport", () =>
    createTransport({ host: "127.0.0.1", port: smtp.port, ignoreTLS: true }));

  async function sendCode(purpose: "login" | "reset_password") {
    const result = await resetApp.inject({
      method: "POST", url: "/auth/email-code", payload: { email: legacyEmail, purpose },
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(smtp.messages.length, 1);
    const message = smtp.messages.shift()!;
    assert.equal(message.recipient, `<${legacyEmail}>`);
    const part = message.data.match(/Content-Type: text\/plain;[^\r\n]*\r\nContent-Transfer-Encoding: (base64|quoted-printable)\r\n\r\n([\s\S]*?)\r\n--/i);
    assert.ok(part, "message contains a plain-text MIME part");
    const text = part[1] === "base64"
      ? Buffer.from(part[2], "base64").toString("utf8")
      : Buffer.from(part[2].replace(/=\r\n/g, "").replace(/=([\dA-F]{2})/g,
        (_, byte) => String.fromCharCode(Number.parseInt(byte, 16))), "latin1").toString("utf8");
    const code = text.match(/验证码：(\d{6})/)?.[1];
    assert.ok(code, "message contains the generated verification code");
    return code;
  }
  const loginCode = await sendCode("login");
  const codeLogin = await resetApp.inject({ method: "POST", url: "/auth/login-with-code", payload: { email: legacyEmail, code: loginCode } });
  assert.equal(codeLogin.statusCode, 200, codeLogin.body);
  const resetCode = await sendCode("reset_password");
  const submitReset = () => resetApp.inject({ method: "POST", url: "/auth/reset-password", payload: {
    email: legacyEmail, code: resetCode, newPassword: resetPasswordValue,
  } });
  const reset = await submitReset();
  assert.equal(reset.statusCode, 204, reset.body);
  assert.equal((await submitReset()).statusCode, 400, "a consumed reset code cannot be reused");
  assert.equal(await decodeToken(codeLogin.json<{ token: string }>().token), null);
  const [after] = await admin`SELECT password_hash FROM users WHERE id = ${legacyId}`;
  assert.match(after.password_hash, /^\$scrypt\$v1\$/);
  assert.equal((await login(resetApp, legacyEmail, resetPasswordValue)).statusCode, 200);
  assert.equal((await login(resetApp, legacyEmail, legacyPassword)).statusCode, 401);
});

test("forced reset is rejected at app startup without a configured email channel", async () => {
  const app = Fastify({ logger: false });
  const keys = ["AUTH_LEGACY_PASSWORD_POLICY", "EMAIL_QQ_USER", "EMAIL_QQ_PASS", "EMAIL_2925_USER", "EMAIL_2925_PASS"] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.AUTH_LEGACY_PASSWORD_POLICY = "require_reset";
    await assert.rejects(async () => {
      await app.register(sensible);
      await app.register(authRoutes, { rateLimitStore: new MemoryRateLimitStore() });
      await app.ready();
    }, /requires a configured email recovery channel/);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await app.close();
  }
});

test("workspace transitions require a live credential and preserve the client kind", async () => {
  const user = await findLoginUserByEmail(modernEmail);
  assert.ok(user);
  const startup = await establishLoginSession(user, "mobile");
  assert.ok(startup);
  const switched = await switchWorkspace(modernId, workspaceId, startup.token, "mobile");
  assert.ok(switched);
  assert.equal(await decodeToken(startup.token), null);
  assert.equal((await decodeToken(switched.token))?.clientKind, "mobile");

  await revokeSession(switched.token);
  const revokedCredential = { token: switched.token, workspaceId, clientKind: "mobile" };
  assert.equal(await switchWorkspace(modernId, personalWorkspaceId, switched.token, "mobile"), null);
  assert.deepEqual(await leaveWorkspace(modernId, workspaceId, revokedCredential), { ok: false, error: "invalid_session" });
  assert.equal(await changePassword(modernId, modernPassword, "must-not-change", switched.token), false);

  const fresh = await establishLoginSession(user, "mobile");
  assert.ok(fresh);
  const active = await switchWorkspace(modernId, workspaceId, fresh.token, "mobile");
  assert.ok(active);
  const response = await resetApp.inject({
    method: "POST", url: "/auth/leave-workspace",
    headers: { authorization: `Bearer ${active.token}` }, payload: { workspaceId },
  });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.equal(result.switchedToPersonalWorkspace, true);
  assert.equal(await decodeToken(active.token), null);
  const replacement = await decodeToken(result.token);
  assert.equal(replacement?.workspaceId, personalWorkspaceId);
  assert.equal(replacement?.clientKind, "mobile");
});

test("password verification and password change cannot race a completed reset", async () => {
  const user = await findLoginUserByEmail(modernEmail);
  assert.ok(user);
  async function resetWhileWaiting<T>(hash: string, operation: () => Promise<T>): Promise<T> {
    let locked!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const reset = admin.begin(async tx => {
      await tx`SELECT id FROM users WHERE id = ${modernId} FOR UPDATE`;
      locked();
      await proceed;
      await tx`UPDATE users SET password_hash = ${hash} WHERE id = ${modernId}`;
    });
    await ready;
    const pending = operation();
    try {
      // Verify that the API attempt actually waited for the row lock.
      const outcome = await Promise.race([pending.then(() => "completed"), new Promise(resolve => setTimeout(() => resolve("waiting"), 150))]);
      assert.equal(outcome, "waiting");
    } finally {
      release();
      await reset;
    }
    return pending;
  }
  const newPassword = "after-concurrent-reset";
  assert.equal(await resetWhileWaiting(await hashPassword(newPassword),
    () => establishLoginSession(user, "desktop", user.passwordHash)), null,
  "a verification of the previous hash must not issue a session after reset");
  assert.equal(await resetWhileWaiting(await hashPassword("after-second-reset"),
    () => changePassword(modernId, newPassword, "stale-change")), false,
  "a stale password change must not overwrite a completed reset");
  const [current] = await admin`SELECT password_hash FROM users WHERE id = ${modernId}`;
  assert.notEqual(current.password_hash, user.passwordHash);
});
