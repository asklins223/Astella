/**
 * `verifyEmailCode` 的纯单测：注入一份手搓的 database 替身，不连库。
 *
 * 覆盖的判据：单次使用（成功即删行）、5 分钟过期、5 次尝试上限、
 * 摘要绑定 purpose+email（换用途/换邮箱的码对不上）、错码累计 attempts。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  EMAIL_CODE_MAX_ATTEMPTS,
  verifyEmailCode,
  type EmailCodeDatabase,
  type EmailCodePurpose,
} from "../email-code-service.ts";

type Row = {
  id: string;
  email: string;
  purpose: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
};

/** 与服务端同一算法：sha256(purpose \\n email \\n code)。 */
function hashOf(purpose: EmailCodePurpose, email: string, code: string): string {
  return createHash("sha256").update(`${purpose}\n${email}\n${code}`).digest("hex");
}

function stub(row: Row | null) {
  const calls = { deleted: 0, updated: null as Record<string, unknown> | null };
  const database = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (row ? [row] : []),
        }),
      }),
    }),
    delete: () => ({
      where: async () => {
        calls.deleted += 1;
        return [];
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          calls.updated = values;
          return [];
        },
      }),
    }),
    insert: () => ({
      values: async () => {
        throw new Error("verify 不该 insert");
      },
    }),
  } as unknown as EmailCodeDatabase;
  return { database, calls };
}

const EMAIL = "Learner@Example.com"; // 服务端会 trim+lowercase 再比对
const NORMALIZED = "learner@example.com";

test("正确验证码：通过并消费（删行）", async () => {
  const { database, calls } = stub({
    id: "1",
    email: NORMALIZED,
    purpose: "login",
    codeHash: hashOf("login", NORMALIZED, "042517"),
    attempts: 0,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const result = await verifyEmailCode(EMAIL, "login", "042517", database);
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.deleted, 1, "成功核对必须删行，码只能用一次");
});

test("错码：返回 invalid 且 attempts +1，行留着继续试", async () => {
  const { database, calls } = stub({
    id: "1",
    email: NORMALIZED,
    purpose: "login",
    codeHash: hashOf("login", NORMALIZED, "042517"),
    attempts: 2,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const result = await verifyEmailCode(NORMALIZED, "login", "000000", database);
  assert.deepEqual(result, { ok: false, error: "invalid" });
  assert.equal(calls.updated?.attempts, 3);
  assert.equal(calls.deleted, 0, "没到上限不该作废整枚码");
});

test("到尝试上限：整枚码作废", async () => {
  const { database, calls } = stub({
    id: "1",
    email: NORMALIZED,
    purpose: "login",
    codeHash: hashOf("login", NORMALIZED, "042517"),
    attempts: EMAIL_CODE_MAX_ATTEMPTS,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const result = await verifyEmailCode(NORMALIZED, "login", "042517", database);
  assert.deepEqual(result, { ok: false, error: "too_many_attempts" });
  assert.equal(calls.deleted, 1);
});

test("过期：作废并报 expired，正确码也进不去", async () => {
  const { database, calls } = stub({
    id: "1",
    email: NORMALIZED,
    purpose: "register",
    codeHash: hashOf("register", NORMALIZED, "042517"),
    attempts: 0,
    expiresAt: new Date(Date.now() - 1),
  });
  const result = await verifyEmailCode(NORMALIZED, "register", "042517", database);
  assert.deepEqual(result, { ok: false, error: "expired" });
  assert.equal(calls.deleted, 1);
});

test("没有这一行：invalid（发都没发过的码进不来）", async () => {
  const { database } = stub(null);
  const result = await verifyEmailCode(NORMALIZED, "reset_password", "042517", database);
  assert.deepEqual(result, { ok: false, error: "invalid" });
});

test("摘要绑定 purpose：register 的码不能拿去登录", async () => {
  const { database } = stub({
    id: "1",
    email: NORMALIZED,
    purpose: "register",
    codeHash: hashOf("register", NORMALIZED, "042517"),
    attempts: 0,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const result = await verifyEmailCode(NORMALIZED, "login", "042517", database);
  assert.deepEqual(result, { ok: false, error: "invalid" });
});
