import { test } from "node:test";
import assert from "node:assert/strict";
import { assertProductionProbeConfiguration } from "../production-preflight.ts";

test("production probes reject legacy experiment flags before starting a fixture or paid call", () => {
  for (const name of ["COMPANION_DIALOGUE_FRAME_V1", "COMPANION_DIALOGUE_REVIEW_V1", "COMPANION_EXPLANATION_REVIEW_V1"]) {
    assert.throws(() => assertProductionProbeConfiguration({ [name]: "true" }), /no longer enables a production branch/);
  }
  assert.doesNotThrow(() => assertProductionProbeConfiguration({ COMPANION_DIALOGUE_REVIEW_V1: "false" }));
  assert.doesNotThrow(() => assertProductionProbeConfiguration({}));
});
