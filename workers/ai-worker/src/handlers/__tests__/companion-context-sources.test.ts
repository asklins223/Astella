import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCompanionHandoffSourcesCurrent } from "../companion-context-sources.ts";
import { CompanionContextChangedError, isNonRetryableError } from "../../lib/non-retryable-errors.ts";
import { type AgentSqlExecutor } from "@astella/agent-host";

const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };
const memoryId = "33333333-3333-4333-8333-333333333333";
const snapshot = { memoryRefs: [{ memoryId, kind: "preference", content: "先举例" }], memorySourceVersions: [{ memoryId, revision: 2 }] };
const tx = (rows: unknown[]): AgentSqlExecutor => ({ async execute() { return rows; } });

test("snapshot replay requires every exposed memory's current version; disappearance and correction are terminal for that prompt", async () => {
  await assertCompanionHandoffSourcesCurrent(tx([{ id: memoryId, revision: 2 }]), scope, snapshot);
  for (const rows of [[], [{ id: memoryId, revision: 3 }]])
    await assert.rejects(assertCompanionHandoffSourcesCurrent(tx(rows), scope, snapshot), CompanionContextChangedError);
  assert.equal(isNonRetryableError(new CompanionContextChangedError()), true);
});

test("unversioned/invalid memory-bearing snapshots cannot silently reuse their old text", async () => {
  await assert.rejects(assertCompanionHandoffSourcesCurrent(tx([{ id: memoryId, revision: 2 }]), scope, {
    memoryRefs: snapshot.memoryRefs,
  }), CompanionContextChangedError);
  await assert.rejects(assertCompanionHandoffSourcesCurrent(tx([]), scope, {
    memoryRefs: [], memoryDirectory: [{ memoryId, kind: "preference", title: "先举例", appliesWhen: null,
      validFrom: null, validUntil: null, revision: 2, epistemicStatus: "supported" }], memorySourceVersions: [],
  }), CompanionContextChangedError);
  await assertCompanionHandoffSourcesCurrent(tx([]), scope, { memoryRefs: [], memorySourceVersions: [] });
});
