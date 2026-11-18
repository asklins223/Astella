import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { closeDatabase, db } from "../db/client.ts";
import { EmailSendFailedError } from "../lib/outbound-email.ts";
import { EMAIL_CODE_MAX_ATTEMPTS, issueEmailCode, verifyEmailCode } from "../modules/identity/email-code-service.ts";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 1 });
const restricted = postgres(testDatabaseUrl("DATABASE_URL_API"), { max: 1 });
const emails: string[] = [];
const code = "731942";

async function fixture(): Promise<string> {
  const email = `otp-concurrency-${randomUUID()}@example.test`;
  emails.push(email);
  const hash = createHash("sha256").update(`login\n${email}\n${code}`).digest("hex");
  await admin`INSERT INTO email_verification_codes (email, purpose, code_hash, expires_at)
    VALUES (${email}, 'login', ${hash}, now() + interval '5 minutes')`;
  return email;
}

after(async () => {
  try {
    for (const email of emails) await admin`DELETE FROM email_verification_codes WHERE email = ${email}`;
  } finally {
    await Promise.all([admin.end(), restricted.end(), closeDatabase()]);
  }
});

test("a verification code is consumed only once under simultaneous requests", async () => {
  const [role] = await restricted`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`;
  assert.equal(role.rolbypassrls, false);
  assert.equal(role.rolsuper, false);
  const email = await fixture();
  const results = await Promise.all(Array.from({ length: 20 }, () => verifyEmailCode(email, "login", code)));
  assert.equal(results.filter(result => result.ok).length, 1);
});

test("concurrent wrong guesses do not lose attempts or permit a later correct code", async () => {
  const email = await fixture();
  const results = await Promise.all(Array.from({ length: EMAIL_CODE_MAX_ATTEMPTS }, () =>
    verifyEmailCode(email, "login", "000000")));
  assert.ok(results.every(result => !result.ok));
  const [row] = await admin`SELECT attempts FROM email_verification_codes WHERE email = ${email} AND purpose = 'login'`;
  assert.equal(row?.attempts, EMAIL_CODE_MAX_ATTEMPTS);
  assert.equal((await verifyEmailCode(email, "login", code)).ok, false);
});

test("an earlier failed send cannot delete a newer replacement code", { timeout: 10_000 }, async () => {
  const email = `otp-concurrency-${randomUUID()}@example.test`;
  emails.push(email);
  let markStarted!: () => void;
  let releaseFirst!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const release = new Promise<void>(resolve => { releaseFirst = resolve; });
  let replacementCode = "";
  const first = issueEmailCode(email, "register", db, async () => {
    markStarted();
    await release;
    throw new EmailSendFailedError([]);
  });
  await Promise.race([started, first.then(() => { throw new Error("first send did not start"); })]);
  try {
    const second = await issueEmailCode(email, "register", db, async message => {
      replacementCode = message.text.match(/验证码：(\d{6})/)?.[1] ?? "";
      return "qq";
    });
    assert.deepEqual(second, { ok: true });
    assert.match(replacementCode, /^\d{6}$/);
  } finally {
    releaseFirst();
  }
  assert.deepEqual(await first, { ok: false, error: "send_failed" });
  assert.deepEqual(await verifyEmailCode(email, "register", replacementCode), { ok: true });
});
