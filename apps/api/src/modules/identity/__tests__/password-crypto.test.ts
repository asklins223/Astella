import { strict as assert } from "node:assert";
import { test } from "node:test";
import bcryptjs from "bcryptjs";
import { hashPassword, resolveLegacyPasswordPolicy, verifyPassword, verifyPasswordForLogin } from "../credentials.ts";

test("legacy bcrypt hashes retain bcryptjs compatibility across prefixes and passwords", async () => {
  for (const password of ["legacy-password", "😀".repeat(19), "prefix\0suffix"]) {
    const hash = await bcryptjs.hash(password, 4);
    for (const prefix of ["$2a$", "$2b$", "$2y$"]) {
      const stored = prefix + hash.slice(4);
      assert.equal(await verifyPassword(password, stored), true, prefix);
      assert.equal(await verifyPassword("incorrect", stored), false, prefix);
      assert.equal(await verifyPasswordForLogin(password, stored), true, prefix);
    }
  }
});

test("login accepts new hashes and rejects unknown or malformed credentials", async () => {
  const hash = await hashPassword("a password longer than the bcrypt compatibility boundary " + "x".repeat(40));
  assert.equal(await verifyPasswordForLogin("a password longer than the bcrypt compatibility boundary " + "x".repeat(40), hash), true);
  assert.equal(await verifyPasswordForLogin("wrong", hash), false);
  assert.equal(await verifyPasswordForLogin("wrong", null), false);
  assert.equal(await verifyPasswordForLogin("wrong", "$RESET_REQUIRED$"), false);
  assert.equal(await verifyPasswordForLogin("wrong", "$scrypt$v1$bad$bad"), false);
});

test("reset-required policy refuses legacy hashes but permits modern credentials", async () => {
  const prefix = "x".repeat(72);
  const legacy = await bcryptjs.hash(`${prefix}original`, 4);
  const modern = await hashPassword(`${prefix}original`);
  // Both suffixes match a bcrypt hash; neither may create a password session
  // in reset-required mode, even if the caller supplies the original suffix.
  for (const password of [`${prefix}original`, `${prefix}other`]) {
    assert.equal(await verifyPasswordForLogin(password, legacy, "allow"), true);
    assert.equal(await verifyPasswordForLogin(password, legacy, "require_reset"), false);
  }
  assert.equal(await verifyPasswordForLogin(`${prefix}original`, modern, "require_reset"), true);
  assert.equal(await verifyPasswordForLogin(`${prefix}other`, modern, "require_reset"), false);
  assert.equal(await verifyPasswordForLogin("anything", null, "require_reset"), false);
  // Existing authenticated users may still change their own password.
  assert.equal(await verifyPassword(`${prefix}original`, legacy), true);
});

test("short matching legacy passwords are not proof of the original password", async () => {
  // bcrypt cycles the NUL-terminated key; this 72-byte legacy password has the
  // same hash as the short string, so opportunistic rehashing could lock out
  // the original user even when the submitted string is shorter than 72 bytes.
  const original = "a\0".repeat(36);
  const legacy = await bcryptjs.hash(original, 4);
  assert.equal(await verifyPassword("a", legacy), true);
  assert.equal(await verifyPasswordForLogin("a", legacy, "require_reset"), false);
});

test("forcing legacy reset requires an explicitly configured recovery channel", () => {
  assert.equal(resolveLegacyPasswordPolicy({}, false), "allow");
  assert.equal(resolveLegacyPasswordPolicy({ AUTH_LEGACY_PASSWORD_POLICY: " ALLOW " }, false), "allow");
  assert.equal(resolveLegacyPasswordPolicy({ AUTH_LEGACY_PASSWORD_POLICY: "require_reset" }, true), "require_reset");
  assert.throws(() => resolveLegacyPasswordPolicy({ AUTH_LEGACY_PASSWORD_POLICY: "require_reset" }, false), /configured email recovery/);
  assert.throws(() => resolveLegacyPasswordPolicy({ AUTH_LEGACY_PASSWORD_POLICY: "req_reset" }, true), /must be allow or require_reset/);
});
