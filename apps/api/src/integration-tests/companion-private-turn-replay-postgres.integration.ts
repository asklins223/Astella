/**
 * Real PostgreSQL check for the private handoff replay boundary introduced by 0339.
 * The API role must read the owning user's bounded snapshot through one function,
 * while direct table reads and mismatched workspace/user identities stay denied.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import postgres from "postgres";
import { canonicalJsonV1, sha256Utf8V1 } from "@ailearn/shared/content-hash";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import { companionRunListQueryV1Schema } from "@ailearn/shared";
import { loadCompanionTurnReplayV1 } from "../modules/companion-conversation/run-turn-replay.ts";
import { loadCompanionRunListV1 } from "../modules/companion-conversation/run-list.ts";
import { loadCompanionRunIssueBundleV1 } from "../modules/companion-conversation/run-issue-bundle.ts";
import { loadCompanionRunDoctorV1 } from "../modules/companion-conversation/run-doctor.ts";

const MIGRATOR_URL = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
const API_URL = process.env.DATABASE_URL_API;
const migrationPool = MIGRATOR_URL ? postgres(MIGRATOR_URL, { max: 1 }) : null;
const apiPool = API_URL ? postgres(API_URL, { max: 1 }) : null;

after(async () => {
  await Promise.all([
    migrationPool?.end({ timeout: 5 }).catch(() => undefined),
    apiPool?.end({ timeout: 5 }).catch(() => undefined),
    closeDatabase().catch(() => undefined),
  ]);
});

function requirePools(t: TestContext) {
  if (migrationPool && apiPool) return { migrationPool, apiPool };
  const message = "DATABASE_URL_MIGRATOR / DATABASE_URL_API 未配置——private turn replay PostgreSQL 集成测试无法运行";
  if (process.env.CI === "true") assert.fail(message);
  t.skip(message);
  return null;
}

test("API can read only the matching owner's bounded handoff snapshot via the private function", async (t) => {
  const pools = requirePools(t);
  if (!pools) return;
  const { migrationPool: admin, apiPool: api } = pools;
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const conversationId = randomUUID();
  const runId = randomUUID();
  const userMessageId = randomUUID();
  const snapshot = {
    version: 1,
    runId,
    conversationId,
    watermark: { throughMessageSeq: "1", throughEventSeq: "0", historyStartSeq: "1", clippedMessageCount: 0 },
    currentRequest: {
      messageId: userMessageId,
      messageSeq: "1",
      contentSha256: sha256Utf8V1("owner-only replay"),
    },
    authorization: { contextGrantId: null, permissionLevel: "read_only", permissionSnapshot: null },
    runState: { status: "succeeded", cancelRequestedAt: null },
    pageSnapshotSha256: null,
    summaryCoverage: null,
    historyTail: [],
    actionLedger: { completed: [], unresolved: [], notCompleted: [] },
    proposals: [],
    memoryRefs: [],
    modelMessages: [{ role: "user", content: "owner-only replay" }],
  };
  const snapshotSha256 = sha256Utf8V1(canonicalJsonV1(snapshot));
  try {
    await admin.begin(async (tx) => {
      await tx`INSERT INTO public.users (id, email, password_hash, role)
               VALUES (${userId}, ${`replay-${userId}@example.test`}, 'test-hash', 'owner'),
                      (${otherUserId}, ${`replay-${otherUserId}@example.test`}, 'test-hash', 'owner')`;
      await tx`INSERT INTO public.workspaces (id, name, owner_id)
               VALUES (${workspaceId}, ${`replay-${workspaceId.slice(0, 8)}`}, ${userId}),
                      (${otherWorkspaceId}, ${`replay-${otherWorkspaceId.slice(0, 8)}`}, ${otherUserId})`;
      await tx`INSERT INTO public.workspace_members (workspace_id, user_id, role)
               VALUES (${workspaceId}, ${userId}, 'owner'), (${otherWorkspaceId}, ${otherUserId}, 'owner')`;
      await tx`INSERT INTO public.companion_conversations
                 (id, workspace_id, user_id, kind, title, title_source, status)
               VALUES (${conversationId}, ${workspaceId}, ${userId}, 'dialogue', 'replay', 'system', 'active')`;
      await tx`INSERT INTO public.companion_messages
                 (id, conversation_id, workspace_id, user_id, role, seq, kind, blocks, content_sha256)
               VALUES (${userMessageId}, ${conversationId}, ${workspaceId}, ${userId}, 'user', 1, 'text',
                       ${tx.json([{ type: "text", text: "owner-only replay" }])}, ${"b".repeat(64)})`;
      await tx`INSERT INTO public.companion_turn_runs
                 (id, conversation_id, workspace_id, user_id, user_message_id, generation, status,
                  idempotency_key_hash, request_body_hash)
               VALUES (${runId}, ${conversationId}, ${workspaceId}, ${userId}, ${userMessageId}, 1,
                       'succeeded', ${"c".repeat(64)}, ${"d".repeat(64)})`;
      await tx`INSERT INTO public.companion_context_handoff_snapshots
                 (run_id, workspace_id, user_id, conversation_id, snapshot, snapshot_sha256, snapshot_version)
               VALUES (${runId}, ${workspaceId}, ${userId}, ${conversationId}, ${tx.json(snapshot)},
                       ${snapshotSha256}, 1)`;
      await tx`INSERT INTO public.companion_run_failure_spans
                 (workspace_id, user_id, failure_class, span_started_at, last_failure_at,
                  failure_count, first_run_id, last_run_id)
               VALUES (${workspaceId}, ${userId}, 'transport', now() - interval '5 minutes', now(),
                       3, ${runId}, ${runId})`;
    });

    const readWithScope = (workspace: string, user: string) => api.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
      await tx`SELECT set_config('app.user_id', ${user}, true)`;
      return tx`SELECT snapshot, snapshot_sha256, snapshot_version
                FROM public.ailearn_read_companion_turn_handoff_snapshot_v1(${runId}::uuid)`;
    });

    const ownerRows = await readWithScope(workspaceId, userId);
    assert.equal(ownerRows.length, 1);
    assert.deepEqual(ownerRows[0]?.snapshot, snapshot);
    assert.equal(ownerRows[0]?.snapshot_sha256, snapshotSha256);
    assert.equal(Number(ownerRows[0]?.snapshot_version), 1);
    assert.equal((await readWithScope(workspaceId, otherUserId)).length, 0);
    assert.equal((await readWithScope(otherWorkspaceId, userId)).length, 0);

    const replay = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
      loadCompanionTurnReplayV1(tx, { workspaceId, userId }, runId),
    );
    assert.equal(replay?.context.snapshotStatus, "available");
    assert.equal(replay?.context.promptMessages[0]?.text, "owner-only replay");
    const ownRuns = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
      loadCompanionRunListV1(
        tx,
        { workspaceId, userId },
        companionRunListQueryV1Schema.parse({ conversationId, limit: "10" }),
      ),
    );
    assert.deepEqual(ownRuns.items.map((run) => run.id), [runId]);
    const anotherTaskRuns = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
      loadCompanionRunListV1(
        tx,
        { workspaceId, userId },
        companionRunListQueryV1Schema.parse({ conversationId: randomUUID() }),
      ),
    );
    assert.deepEqual(anotherTaskRuns.items, []);
    const issueBundle = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
      loadCompanionRunIssueBundleV1(tx, { workspaceId, userId }, runId),
    );
    assert.deepEqual(issueBundle?.files.map((file) => file.path), [
      "run.json", "execution.json", "timeline.json", "delivery.json",
    ]);
    const serializedBundle = JSON.stringify(issueBundle);
    assert.equal(serializedBundle.includes(runId), false);
    assert.equal(serializedBundle.includes(workspaceId), false);
    assert.equal(serializedBundle.includes(userId), false);
    assert.equal(serializedBundle.includes("owner-only replay"), false);
    const doctor = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
      loadCompanionRunDoctorV1(tx, { workspaceId, userId }, runId),
    );
    assert.equal(doctor?.failureSpans.length, 1);
    assert.equal(doctor?.failureSpans[0]?.failureClass, "transport");
    assert.equal(doctor?.failureSpans[0]?.failureCount, 3);
    assert.equal(doctor?.failureSpans[0]?.recoveredAt, null);
    const otherScopeSpans = await api.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${otherWorkspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${otherUserId}, true)`;
      return tx`SELECT failure_class FROM public.companion_run_failure_spans`;
    });
    assert.deepEqual(Array.from(otherScopeSpans), []);
    const inaccessibleReplay = await withWorkspaceTransaction(
      { workspaceId: otherWorkspaceId, userId: otherUserId },
      (tx) => loadCompanionTurnReplayV1(tx, { workspaceId: otherWorkspaceId, userId: otherUserId }, runId),
    );
    assert.equal(inaccessibleReplay, null);

    const directReadError = await api`
      SELECT snapshot FROM public.companion_context_handoff_snapshots WHERE run_id = ${runId}::uuid
    `.then(() => null, (error: { code?: string }) => error);
    assert.equal(directReadError?.code, "42501", "API must not get direct table SELECT even for an owned run");

    const privileges = await admin`
      SELECT has_function_privilege('ailearn_api',
               'public.ailearn_read_companion_turn_handoff_snapshot_v1(uuid)', 'EXECUTE') AS api_can_execute,
             has_function_privilege('ailearn_worker',
               'public.ailearn_read_companion_turn_handoff_snapshot_v1(uuid)', 'EXECUTE') AS worker_can_execute,
             has_table_privilege('ailearn_api', 'public.companion_context_handoff_snapshots', 'SELECT') AS api_can_select_table
    `;
    assert.equal(privileges[0]?.api_can_execute, true);
    assert.equal(privileges[0]?.worker_can_execute, false);
    assert.equal(privileges[0]?.api_can_select_table, false);
    const failureSpanPrivileges = await admin`
      SELECT has_table_privilege('ailearn_api', 'public.companion_run_failure_spans', 'SELECT') AS api_can_select,
             has_table_privilege('ailearn_api', 'public.companion_run_failure_spans', 'INSERT') AS api_can_insert,
             has_table_privilege('ailearn_worker', 'public.companion_run_failure_spans', 'INSERT') AS worker_can_insert,
             has_table_privilege('ailearn_worker', 'public.companion_run_failure_spans', 'UPDATE') AS worker_can_update,
             has_table_privilege('ailearn_worker', 'public.companion_run_failure_spans', 'DELETE') AS worker_can_delete
    `;
    assert.equal(failureSpanPrivileges[0]?.api_can_select, true);
    assert.equal(failureSpanPrivileges[0]?.api_can_insert, false);
    assert.equal(failureSpanPrivileges[0]?.worker_can_insert, true);
    assert.equal(failureSpanPrivileges[0]?.worker_can_update, true);
    assert.equal(failureSpanPrivileges[0]?.worker_can_delete, false);
  } finally {
    await admin.begin(async (tx) => {
      await tx`DELETE FROM public.companion_context_handoff_snapshots WHERE run_id = ${runId}`;
      await tx`DELETE FROM public.companion_turn_runs WHERE id = ${runId}`;
      await tx`DELETE FROM public.companion_messages WHERE id = ${userMessageId}`;
      await tx`DELETE FROM public.companion_conversations WHERE id = ${conversationId}`;
      await tx`DELETE FROM public.workspace_members WHERE workspace_id IN (${workspaceId}, ${otherWorkspaceId})`;
      await tx`DELETE FROM public.workspaces WHERE id IN (${workspaceId}, ${otherWorkspaceId})`;
      await tx`DELETE FROM public.users WHERE id IN (${userId}, ${otherUserId})`;
    });
  }
});
