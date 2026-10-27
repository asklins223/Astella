import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCompanionHandoffSourcesCurrent } from "../context/companion-context-sources.ts";
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

// 取数侧现实上界是 resident ≤6 + directory ≤500；解析上限曾写死 32，账号第 33 条
// active 记忆入库后每轮都撞 too_big → CONTEXT_STALE（2026-10-12 实测复盘）。
test("33+ memory sources parse fine — the bound is anti-malformed, not a freshness rule", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    memoryId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    revision: 1,
  }));
  const rows = many.map(source => ({ id: source.memoryId, revision: 1 }));
  await assertCompanionHandoffSourcesCurrent(tx(rows), scope, {
    memoryRefs: [],
    memoryDirectory: many.map(source => ({ ...source, kind: "preference", title: "t", appliesWhen: null,
      validFrom: null, validUntil: null, epistemicStatus: "supported" })),
    memorySourceVersions: many,
  });
});

test("后台精修推进版本不掐断这一轮；用户自己改写才掐断", async () => {
  // Memory extraction/merge bumps revisions while a turn is in flight. Treating
  // that as "the user changed the context" killed healthy turns (2026-10-26).
  await assertCompanionHandoffSourcesCurrent(tx([{ id: memoryId, revision: 3, author_type: "extractor" }]), scope, snapshot);
  await assertCompanionHandoffSourcesCurrent(tx([{ id: memoryId, revision: 3, author_type: "companion" }]), scope, snapshot);
  await assert.rejects(assertCompanionHandoffSourcesCurrent(
    tx([{ id: memoryId, revision: 3, author_type: "user" }]), scope, snapshot), CompanionContextChangedError);
});
