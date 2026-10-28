import assert from "node:assert/strict";
import test from "node:test";
import { createCompanionRouteRecorder } from "../agent/companion-route-record.ts";

test("the route record keeps the entry mode and is written once per turn", async () => {
  const writes: Array<{ route: unknown }> = [];
  const recorder = createCompanionRouteRecorder({ entryMode: "direct_fast" },
    async (_event, patch) => { writes.push(patch); });
  recorder.record({ read: { runId: "run" } } as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!.route, { version: 1, entryMode: "direct_fast" });
});

test("a failed run-meta write is swallowed and never reaches the caller", async () => {
  const recorder = createCompanionRouteRecorder({}, async () => { throw new Error("db down"); });
  recorder.record({ read: { runId: "run" } } as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(true, "record returns synchronously without throwing the rejection");
});
