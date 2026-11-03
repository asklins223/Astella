import assert from "node:assert/strict";
import test from "node:test";
import { resolveAllCompanionAgentTools, type AgentTurnRequest } from "@astella/shared";
import { agentReadRequirementsV1Schema } from "@astella/shared/agent-contracts";
import { companionApplicationReadOperations, companionReadRequirementsMessages,
  missingCompanionReadRequirements, companionIndependentEvidenceMissing, companionExecutionOperations,
  missingCompanionExecutionRequirements } from "../agent/companion-read-requirements.ts";

const decision = agentReadRequirementsV1Schema.parse({ version: 1, inputHash: "a".repeat(64), policyHash: "b".repeat(64),
  status: "resolved", requirements: [{ description: "current learning statistics", operations: ["observe.stats"] }] });
const request: AgentTurnRequest["messages"][number] = { role: "user", content: "How have I studied lately?", requestBoundary: true };
test("a legacy evidence decision never implicitly permits a non-reasoning knowledge answer", () => {
  assert.equal(decision.requiresReasoning, true);
  assert.equal(agentReadRequirementsV1Schema.parse({ ...decision, requiresReasoning: false }).requiresReasoning, false);
});
const read = (id: string, action = "stats", ok = true): AgentTurnRequest["messages"] => [
  { role: "assistant", content: "", toolCalls: [{ id, name: "companion_observe", arguments: { action } }] },
  { role: "tool", toolCallId: id, content: JSON.stringify({ ok, status: ok ? "succeeded" : "failed", data: { totalNotes: 0 } }) },
];

test("application evidence requires the corresponding successful read owned by this request", () => {
  assert.deepEqual(missingCompanionReadRequirements(decision, [request]), decision.requirements);
  assert.deepEqual(missingCompanionReadRequirements(decision, [...read("old"), request]), decision.requirements);
  assert.deepEqual(missingCompanionReadRequirements(decision, [request, ...read("failed", "stats", false)]), decision.requirements);
  assert.deepEqual(missingCompanionReadRequirements(decision, [request, ...read("other", "context")]), decision.requirements);
  assert.deepEqual(missingCompanionReadRequirements(decision, [request, ...read("current")]), []);
  assert.deepEqual(missingCompanionReadRequirements(decision, [request], read("owned-compacted")), []);
});

test("tool loading, invented receipts and assistant claims do not become application evidence", () => {
  const loader: AgentTurnRequest["messages"] = [request,
    { role: "assistant", content: "You studied four days", toolCalls: [{ id: "load", name: "companion_load_tools", arguments: { groups: ["observe"] } }] },
    { role: "tool", toolCallId: "load", content: JSON.stringify({ ok: true, data: { tools: ["companion_observe"] } }) },
    { role: "tool", toolCallId: "nonexistent", content: JSON.stringify({ ok: true, data: { studiedDays: 4 } }) }];
  assert.deepEqual(missingCompanionReadRequirements(decision, loader), decision.requirements);
});

test("each independent fact is required but alternative operations do not prescribe a sequence", () => {
  const both = { ...decision, requirements: [...decision.requirements,
    { description: "recent activities", operations: ["observe.activity", "observe.history"] }] };
  const partial = [request, ...read("stats")];
  assert.deepEqual(missingCompanionReadRequirements(both, partial), [both.requirements[1]]);
  assert.deepEqual(missingCompanionReadRequirements(both, [...partial, ...read("history", "history")]), []);
});

test("evidence catalog exposes read identities and cannot grant writes or arbitrary model operations", () => {
  const operations = companionApplicationReadOperations(resolveAllCompanionAgentTools("full", {}));
  assert.ok(operations.some(operation => operation.name === "observe.stats"));
  assert.ok(operations.some(operation => operation.name === "notes.read.read"));
  assert.ok(operations.every(operation => !operation.name.startsWith("notes.write.") && !operation.name.startsWith("web.")));
  assert.ok(!operations.some(operation => operation.name === "companion_load_tools" || operation.name === "observe.calculate"));
  const messages = companionReadRequirementsMessages([request, { role: "system", content: "Private persona irrelevant to this evidence check" }], operations);
  const payload = JSON.parse(String(messages[1]!.content));
  assert.equal(payload.conversation.length, 1);
  assert.equal(payload.conversation[0].currentRequest, true);
  assert.deepEqual(payload.operations.flatMap((group: { operations: string[] }) => group.operations).sort(),
    operations.map(operation => operation.name).sort(), "deduplication preserves every operation identity");
  assert.equal(payload.operations.length, new Set(operations.map(operation => operation.description)).size);
});

test("empirical/current evidence needs an actual original source, not a loaded tool, failed search, or unrelated app read", () => {
  const empirical = { ...decision, requirements: [], requiresIndependentEvidence: true };
  assert.equal(companionIndependentEvidenceMissing(empirical, [request]), true);
  assert.equal(companionIndependentEvidenceMissing(empirical, [request, ...read("stats")]), true);
  const web = (action: string, ok: boolean): AgentTurnRequest["messages"] => [request,
    { role: "assistant", content: "", toolCalls: [{ id: "web", name: "companion_web", arguments: { action, url: "https://example.com/original" } }] },
    { role: "tool", toolCallId: "web", content: JSON.stringify({ ok, status: ok ? "succeeded" : "failed", data: { text: "source text" } }) }];
  assert.equal(companionIndependentEvidenceMissing(empirical, web("search", true)), true);
  assert.equal(companionIndependentEvidenceMissing(empirical, web("read_document", false)), true);
  assert.equal(companionIndependentEvidenceMissing(empirical, web("read_document", true)), false);
  assert.equal(companionIndependentEvidenceMissing(empirical, [request], web("read_document", true).slice(1)), false);
  assert.equal(companionIndependentEvidenceMissing(empirical, [...web("read_document", true), request]), true);
  assert.equal(companionIndependentEvidenceMissing(decision, [request]), false, "ordinary app/physical-principle turns need no external source");
});

test("mixed web research and saved-note requests keep their independent evidence obligations", () => {
  const mixed = { ...decision, requiresIndependentEvidence: true,
    requirements: [{ description: "the user's actual saved lunar note", operations: ["notes.read.read"] }] };
  const web: AgentTurnRequest["messages"] = [request,
    { role: "assistant", content: "", toolCalls: [{ id: "web", name: "companion_web", arguments: { action: "read_document", url: "https://science.nasa.gov/moon/" } }] },
    { role: "tool", toolCallId: "web", content: JSON.stringify({ ok: true, data: { text: "original public material" } }) }];
  assert.equal(companionIndependentEvidenceMissing(mixed, web), false);
  assert.deepEqual(missingCompanionReadRequirements(mixed, web), mixed.requirements,
    "reading a public page cannot stand in for the saved note");
  const complete: AgentTurnRequest["messages"] = [...web,
    { role: "assistant", content: "", toolCalls: [{ id: "note", name: "companion_notes_read", arguments: { action: "read", noteId: "owned-note" } }] },
    { role: "tool", toolCallId: "note", content: JSON.stringify({ ok: true, data: { text: "actual saved note" } }) }];
  assert.deepEqual(missingCompanionReadRequirements(mixed, complete), []);
});

test("an explicit save needs its corresponding actual successful write, never a read or unrelated self-note", () => {
  const save = { ...decision, requirements: [], executionRequirements: [{ description: "save personal preference", operations: ["memory.write.save"] }] };
  assert.deepEqual(missingCompanionExecutionRequirements(save, [request, ...read("stats")]), save.executionRequirements);
  const write = (tool: string, args: Record<string, unknown>, ok = true): AgentTurnRequest["messages"] => [
    { role: "assistant", content: "", toolCalls: [{ id: "write", name: tool, arguments: args }] },
    { role: "tool", toolCallId: "write", content: JSON.stringify({ ok, data: { status: ok ? "succeeded" : "failed" } }) }];
  assert.deepEqual(missingCompanionExecutionRequirements(save, [request, ...write("companion_persona_write", { action: "self_note" })]), save.executionRequirements);
  assert.deepEqual(missingCompanionExecutionRequirements(save, [request, ...write("companion_memory_save", {}, false)]), save.executionRequirements);
  assert.deepEqual(missingCompanionExecutionRequirements(save, [...write("companion_memory_save", {}), request]), save.executionRequirements);
  assert.deepEqual(missingCompanionExecutionRequirements(save, [request, ...write("companion_memory_save", {})]), []);
  const operations = companionExecutionOperations(resolveAllCompanionAgentTools("full", {}));
  for (const name of ["memory.write.save", "persona.write.self_note", "notes.write.create", "goals.write.start", "visual.diagram", "observe.calculate", "open.page"])
    assert.ok(operations.some(operation => operation.name === name), name);
  assert.ok(!operations.some(operation => ["companion_finish", "companion_load_tools", "observe.stats"].includes(operation.name)));
});
