import { test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { hashPassword, verifyPassword, verifyPasswordForLogin } from "../modules/identity/credentials.ts";
import { reindexWorkspaceSearch } from "../modules/search/service.ts";
import type { ApiTransaction } from "../db/client.ts";
import { logSearchProjectionFailure } from "../lib/search-index-upsert.ts";
import { logger } from "../lib/logger.ts";
import { createNoteConnectionBudget, createNoteMessageBudget } from "../modules/note/connection-budget.ts";
import { trackNoteConnectionForRevocation, type NoteDocContext } from "../modules/note/collaboration.ts";
import { notifySessionRevoked } from "../modules/identity/session-revocations.ts";
import type { Connection } from "@hocuspocus/server";

test("new passwords compare every UTF-8 byte and legacy hashes remain usable", async () => {
  const prefix = "字".repeat(24);
  const hash = await hashPassword(`${prefix}first`);
  assert.equal(await verifyPassword(`${prefix}first`, hash), true);
  assert.equal(await verifyPassword(`${prefix}second`, hash), false);
  assert.equal(await verifyPassword("anything", "$scrypt$v1$bad$bad"), false);
  const legacy = await bcrypt.hash("legacy-password", 4);
  assert.equal(await verifyPassword("legacy-password", legacy), true);
  assert.equal(await verifyPassword("wrong", legacy), false);
  assert.equal(await verifyPasswordForLogin(`${prefix}first`, hash), true);
  assert.equal(await verifyPasswordForLogin("legacy-password", legacy), true);
  assert.equal(await verifyPasswordForLogin("legacy-password", null), false);
  assert.equal(await verifyPasswordForLogin("wrong", hash), false);
});

test("search rebuild pages beyond 50,000 without dropping any item", async () => {
  const total = 50_001;
  let fetched = 0;
  let inserted = 0;
  let largestPage = 0;
  let removed = 0;
  let lastPageSize = 0;
  let inCleanup = false;
  let locking = true;
  const tx = {
    query: {
      notes: { findMany: async ({ limit }: { limit: number }) => {
        largestPage = Math.max(largestPage, limit);
        const count = Math.min(limit, total - fetched);
        lastPageSize = count;
        return Array.from({ length: count }, () => {
          const id = String(fetched++).padStart(8, "0");
          return { id, title: id, currentVersionId: id };
        });
      } },
      sources: { findMany: async () => { inCleanup = true; return []; } },
    },
    execute: async () => {
      if (inCleanup) { removed++; return [{ count: "2" }]; }
      if (locking) { locking = false; return []; }
      locking = true;
      inserted += lastPageSize;
      return [{ count: String(lastPageSize) }];
    },
  };
  const executor = { transaction: async (fn: (tx: unknown) => Promise<void>) => fn(tx) } as unknown as ApiTransaction;
  const result = await reindexWorkspaceSearch(executor, "workspace");
  assert.deepEqual(result, { deleted: 2, indexed: { note: total, source: 0 }, errors: 0, capped: false });
  assert.equal(inserted, total);
  assert.equal(largestPage, 100);
  assert.equal(removed, 1);
});

test("a failed rebuild reports no committed work and does not perform cleanup", async () => {
  let cleanup = 0;
  const tx = {
    query: { notes: { findMany: async () => [{ id: "n", title: "t", currentVersionId: "v" }] } },
    execute: async () => { cleanup++; throw new Error("write failed"); },
  };
  const executor = { transaction: async (fn: (tx: unknown) => Promise<void>) => fn(tx) } as unknown as ApiTransaction;
  assert.deepEqual(await reindexWorkspaceSearch(executor, "workspace"),
    { deleted: 0, indexed: { note: 0, source: 0 }, errors: 1, capped: false });
  assert.equal(cleanup, 1);
});

test("failed search projections log identifiers but never content", () => {
  const original = logger.error;
  let logged: unknown;
  try {
    logger.error = ((fields: unknown) => { logged = fields; }) as typeof logger.error;
    logSearchProjectionFailure(new Error("failed"), {
      workspaceId: "w", objectType: "note", objectId: "n", title: "private title", body: "private body",
      metadata: { secret: "private metadata" },
    });
  } finally { logger.error = original; }
  assert.deepEqual(Object.keys(logged as object).sort(), ["err", "objectId", "objectType", "workspaceId"]);
});

test("connection budget includes unauthenticated clients and releases exactly once", () => {
  const budget = createNoteConnectionBudget(1);
  const release = budget.acquire();
  assert.ok(release);
  assert.equal(budget.acquire(), null);
  release();
  release();
  const next = budget.acquire();
  assert.ok(next);
  assert.equal(budget.acquire(), null);
  next();
});

test("message budget permits a full document but bounds bursts", () => {
  let time = 0;
  const allow = createNoteMessageBudget(() => time);
  assert.equal(allow(100 * 1024 * 1024), true);
  assert.equal(allow(100 * 1024 * 1024), true);
  assert.equal(allow(100 * 1024 * 1024), false);
  time = 10_000;
  assert.equal(allow(1), true);
  for (let i = 1; i < 600; i++) assert.equal(allow(0), true);
  assert.equal(allow(0), false);
});

test("revocation closes matching session or workspace connections only", () => {
  let first = 0;
  let second = 0;
  const base = { workspaceId: "w", noteId: "n", versionId: "v", readOnly: true };
  const a = { context: { ...base, userId: "a", sessionTokenHash: "one" }, close: () => { first++; } } as unknown as Connection<NoteDocContext>;
  const b = { context: { ...base, userId: "b", sessionTokenHash: "two" }, close: () => { second++; } } as unknown as Connection<NoteDocContext>;
  const removeA = trackNoteConnectionForRevocation(a);
  const removeB = trackNoteConnectionForRevocation(b);
  try {
    notifySessionRevoked({ tokenHash: "one" });
    assert.deepEqual([first, second], [1, 0]);
    notifySessionRevoked({ userId: "b", workspaceId: "other" });
    assert.deepEqual([first, second], [1, 0]);
    notifySessionRevoked({ userId: "b", workspaceId: "w" });
    assert.deepEqual([first, second], [1, 1]);
  } finally { removeA(); removeB(); }
});
