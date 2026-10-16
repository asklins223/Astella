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

/**
 * 2026-10-16：交付闸要的权威事实（`writesLanded`）要能过检查点。
 *
 * 这条红的姿势很难看：CI 的 Worker 作业不跑 postgres 集成测，所以"schemas 少一个字段、
 * 每一轮都在 `finishBoundary` 抛 `unrecognized_keys`"这件事只有真库跑一遍才看得见。
 * 反向对照同一条里给：严格对象仍然要挡住没登记的键，否则检查点就成了随便塞东西的口袋。
 */
test("settled 结果带着 writesLanded 也要编得进去，未登记的键仍然挡", () => {
  const snapshot = { phase: "settled" as const, state: state(), result: { status: "completed" as const,
    text: "已经做成的事要说给你听", blocks: [], memoryRefs: [], writesLanded: true } };
  assert.deepEqual(decodeCompanionRuntimeCheckpoint(encodeCompanionRuntimeCheckpoint("same", snapshot), "same"), snapshot);
  // 故意塞一个没登记的键：要的是运行时挡住，所以这里绕过类型检查（TS 先拦就测不到 schema）。
  const smuggled = { ...snapshot.result, landedSomethingElse: true } as unknown as typeof snapshot.result;
  assert.throws(() => encodeCompanionRuntimeCheckpoint("same", { ...snapshot, result: smuggled }));
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
