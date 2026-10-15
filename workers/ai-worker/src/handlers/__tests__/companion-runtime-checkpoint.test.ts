import assert from "node:assert/strict";
import test from "node:test";
import { encodeCompanionRuntimeCheckpoint, decodeCompanionRuntimeCheckpoint, encodeCompanionToolResult,
  decodeCompanionToolResult, type CompanionRuntimeState } from "../companion-runtime-checkpoint.ts";
import { CompanionContextChangedError } from "../../lib/non-retryable-errors.ts";
import { sha256Utf8V1, stableStringify } from "@astella/shared/content-hash";

const state = (): CompanionRuntimeState => ({ messages: [{ role: "user", content: "original request" },
  { role: "assistant", content: "", toolCalls: [{ id: "read", name: "companion_read_history", arguments: { fromSeq: 1 } }] },
  { role: "tool", toolCallId: "read", content: JSON.stringify({ ok: true, data: { text: "complete evidence 🙂\n".repeat(20000) } }) }],
  compactedEvidence: [], stepCount: 2, toolCallCount: 1, elapsedMs: 400, visibleSegments: ["already shown"],
  visibleSegmentDelivered: [true], richBlocks: [], webSearchCalls: 0, historyFoldApplied: false,
  invalidArgumentCalls: ["unchanged bad args"], rejectedExecutionConstraints: ["forbidden time arrangement"],
  degenerateRetried: false, outputRepairToolCount: 1, actionSteerAttempts: 1, quoteCorrectionUsed: true,
  lookupClaimSteered: true, steerSwapToFallback: true, utterancePublished: false });

test("private runtime state preserves full tool evidence and no-progress correction state", () => {
  const original = { phase: "continue" as const, state: state() };
  const identity = { runId: "run", policy: "same", provider: "model-a" };
  const encoded = encodeCompanionRuntimeCheckpoint(identity, original);
  assert.deepEqual(decodeCompanionRuntimeCheckpoint(JSON.parse(JSON.stringify(encoded)), identity), original);
  assert.equal(decodeCompanionRuntimeCheckpoint(encoded, { ...identity, policy: "changed" }), null);
  assert.equal(decodeCompanionRuntimeCheckpoint({ ...encoded, stateJson: encoded.stateJson + " " }, identity), null);
  const invalid = stableStringify({ ...original, state: { ...original.state, visibleSegmentDelivered: [] } });
  assert.equal(decodeCompanionRuntimeCheckpoint({ ...encoded, stateJson: invalid, stateSha256: sha256Utf8V1(invalid) }, identity), null);
});

test("a durable final result is a distinct phase and can finish without a new model call", () => {
  const snapshot = { phase: "settled" as const, state: state(), result: { status: "completed" as const,
    text: "verified complete answer", blocks: [], memoryRefs: [] } };
  assert.deepEqual(decodeCompanionRuntimeCheckpoint(encodeCompanionRuntimeCheckpoint("same", snapshot), "same"), snapshot);
  assert.throws(() => encodeCompanionRuntimeCheckpoint("same", { ...snapshot, result: undefined }));
});

test("a confirmation checkpoint binds the pending proposal and original model call together", () => {
  const snapshot = { phase: "waiting" as const, state: state(),
    proposalId: "11111111-1111-4111-8111-111111111111", pendingCallId: "pending-write" };
  assert.deepEqual(decodeCompanionRuntimeCheckpoint(encodeCompanionRuntimeCheckpoint("same", snapshot), "same"), snapshot);
  assert.throws(() => encodeCompanionRuntimeCheckpoint("same", { ...snapshot, pendingCallId: undefined }));
  assert.throws(() => encodeCompanionRuntimeCheckpoint("same", { ...snapshot, phase: "continue" }));
});

test("complete private tool results retain payload, routes and blocks and reject changed hashes", () => {
  const original = { value: { text: "original source\n".repeat(20000), amount: 0.25 }, safeSummary: "read complete", resultRef: "real-id",
    route: { kind: "home" }, routeLabel: "Home", blocks: [{ type: "text" as const, text: "a tool-supplied block" }] };
  const encoded = encodeCompanionToolResult(original);
  assert.deepEqual(decodeCompanionToolResult(JSON.parse(JSON.stringify(encoded))), original);
  assert.equal(decodeCompanionToolResult(null), null);
  assert.throws(() => decodeCompanionToolResult({ ...encoded, json: encoded.json + " " }), CompanionContextChangedError);
});
