import test from "node:test";
import assert from "node:assert/strict";
import { companionMemoryMutationLockKey } from "../db-schema/assistant-memory.ts";

test("companion memory mutation lock key is stable and user scoped", () => {
  const userId = "33333333-3333-4333-8333-333333333333";
  assert.equal(companionMemoryMutationLockKey(userId), `companion-memory-write:${userId}`);
  assert.notEqual(
    companionMemoryMutationLockKey(userId),
    companionMemoryMutationLockKey("44444444-4444-4444-8444-444444444444"),
  );
});
