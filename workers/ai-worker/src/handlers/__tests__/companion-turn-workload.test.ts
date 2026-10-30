import assert from "node:assert/strict";
import { test } from "node:test";
import { companionDirectInterpretation, createCompanionDirectControls } from "../turn/companion-entry-mode.ts";
import { companionStepReasoning, resolveCompanionTurnWorkload } from "../turn/companion-turn-workload.ts";
import { createCompanionMessageDelivery } from "../turn/companion-message-delivery.ts";

const unknown = companionDirectInterpretation("a".repeat(64));
const casual = { ...unknown, status: "interpreted" as const, intent: "conversation" as const,
  toolUse: "none" as const, resourceDecision: { version: 1 as const, path: "chat" as const, source: "model" as const, policyHash: "b".repeat(64) } };

test("fast entry is casual by default; grounding and thinking mode raise cost", () => {
  assert.equal(resolveCompanionTurnWorkload({ mode: "direct_fast", attention: unknown, requiresGrounding: false }), "casual");
  assert.equal(resolveCompanionTurnWorkload({ mode: "direct_fast", attention: casual, requiresGrounding: false }), "casual");
  assert.equal(resolveCompanionTurnWorkload({ mode: "direct_fast", attention: casual, requiresGrounding: true }), "adaptive");
  assert.equal(resolveCompanionTurnWorkload({ mode: "direct_thinking", attention: casual, requiresGrounding: false }), "adaptive");
  const staleActionLabel = { ...casual, toolUse: "act" as const };
  assert.equal(resolveCompanionTurnWorkload({ mode: "direct_fast", attention: staleActionLabel, requiresGrounding: false }), "casual");
});

test("new evidence, repairs and explicit deepening raise the semantic opening effort", async () => {
  const base = { mode: "direct_fast", resourcePath: "chat", deepened: false,
    repairing: false, readOnlyRequiredStep: false, toolCallCount: 0 } as const;
  assert.equal(companionStepReasoning(base), "none");
  assert.equal(companionStepReasoning({ ...base, toolCallCount: 1 }), "high");
  assert.equal(companionStepReasoning({ ...base, repairing: true, readOnlyRequiredStep: true }), "high");
  assert.equal(companionStepReasoning({ ...base, mode: "direct_thinking" }), "high");
  assert.equal(companionStepReasoning({ ...base, resourcePath: undefined }), "high");
  const controls = createCompanionDirectControls({ mode: "direct_fast", userText: "unseen slang or any language", attention: casual });
  assert.equal(controls.disableThinking(), true);
  await controls.apply("companion_deepen", {});
  assert.equal(controls.disableThinking(), false);
  assert.equal(companionStepReasoning({ ...base, deepened: controls.deepened() }), "high");
});

test("message delivery counts persisted publications against the semantic contract and restores them idempotently", () => {
  const delivery = createCompanionMessageDelivery();
  delivery.record("recovered-first");
  delivery.require(2);
  assert.equal(delivery.incomplete(), true);
  delivery.record("recovered-first");
  assert.equal(delivery.incomplete(), true);
  delivery.record("second");
  assert.equal(delivery.incomplete(), false);
  assert.equal(delivery.full(), true);
  delivery.require(2);
  assert.throws(() => delivery.require(3), /changed/);
  assert.throws(() => createCompanionMessageDelivery().require(-1), /invalid/);
  assert.equal(createCompanionMessageDelivery().incomplete(), false);
});
