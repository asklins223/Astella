import assert from "node:assert/strict";
import test from "node:test";
import { buildDesktopCapabilityProjection, type WorkspaceAiConsentFacts } from "../capability-projection.ts";

const originalDialogue = process.env.COMPANION_DIALOGUE_V1_ENABLED;
const originalVoice = process.env.COMPANION_VOICE_DIALOGUE_V1_ENABLED;

function restoreFlags(): void {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("COMPANION_DIALOGUE_V1_ENABLED", originalDialogue);
  restore("COMPANION_VOICE_DIALOGUE_V1_ENABLED", originalVoice);
}

/** 纯 mock 部署：不需要同意，因此内容外发本身是允许的。 */
const mockOnlyAi: WorkspaceAiConsentFacts = { requiresConsent: false, consentSigned: false, sendToExternal: true };

test("desktop capability projection: retired learning surfaces are never granted", () => {
  const projection = buildDesktopCapabilityProjection({ role: "owner", ai: mockOnlyAi, workspaceEpoch: 1 });
  for (const capability of ["learning_run.start", "card_generation.activate", "review.read", "objective.read"]) {
    assert.equal(capability in projection.actionCapabilities, false, capability);
  }
  for (const feature of ["learning_run_v2", "card_generation_v2"]) {
    assert.equal(feature in projection.featureAvailability, false, feature);
  }
  assert.equal(projection.actionCapabilities["note.save"], "allowed");
  assert.equal(projection.actionCapabilities["settings.update"], "allowed");
});

test("desktop capability projection: member writes stay denied while reads work", () => {
  const projection = buildDesktopCapabilityProjection({ role: "member", ai: mockOnlyAi, workspaceEpoch: 1 });
  assert.equal(projection.actionCapabilities["note.save"], "denied");
  assert.equal(projection.actionCapabilities["note.read"], "allowed");
});

test("desktop capability projection: AI consent gates every companion capability", () => {
  const unsigned: WorkspaceAiConsentFacts = { requiresConsent: true, consentSigned: false, sendToExternal: true };
  const signedButHeld: WorkspaceAiConsentFacts = { requiresConsent: true, consentSigned: true, sendToExternal: false };
  const signedAndSending: WorkspaceAiConsentFacts = { requiresConsent: true, consentSigned: true, sendToExternal: true };

  for (const [label, ai, expected] of [
    ["未签署", unsigned, "denied"],
    ["已签署但策略禁止外发", signedButHeld, "denied"],
    ["已签署且允许外发", signedAndSending, "allowed"],
  ] as const) {
    const projection = buildDesktopCapabilityProjection({ role: "owner", ai , workspaceEpoch: 1 });
    for (const capability of ["companion.read", "companion.sendMessage", "companion.decideProposal"] as const) {
      assert.equal(projection.actionCapabilities[capability], expected, `${label} → ${capability}`);
    }
  }
});

test("desktop capability projection: a missing workspace row fails closed", () => {
  const projection = buildDesktopCapabilityProjection({ role: "owner", ai: null , workspaceEpoch: 1 });
  assert.equal(projection.actionCapabilities["companion.read"], "denied");
  assert.equal(projection.actionCapabilities["companion.sendMessage"], "denied");
});

test("desktop capability projection: policy management follows the owner role", () => {
  assert.equal(buildDesktopCapabilityProjection({ role: "owner", ai: mockOnlyAi , workspaceEpoch: 1 }).actionCapabilities["settings.update"], "allowed");
  assert.equal(buildDesktopCapabilityProjection({ role: "member", ai: mockOnlyAi , workspaceEpoch: 1 }).actionCapabilities["settings.update"], "denied");
  assert.equal(buildDesktopCapabilityProjection({ role: "member", ai: mockOnlyAi , workspaceEpoch: 1 }).actionCapabilities["settings.read"], "allowed");
});

test("desktop capability projection: companion dialogue features follow their real flags", () => {
  try {
    process.env.COMPANION_DIALOGUE_V1_ENABLED = "true";
    process.env.COMPANION_VOICE_DIALOGUE_V1_ENABLED = "false";
    const projection = buildDesktopCapabilityProjection({ role: "owner", ai: mockOnlyAi , workspaceEpoch: 1 });
    assert.equal(projection.featureAvailability.companion_dialogue_v1.state, "enabled");
    assert.equal(projection.featureAvailability.companion_voice_dialogue_v1.state, "disabled");
  } finally {
    restoreFlags();
  }
});
