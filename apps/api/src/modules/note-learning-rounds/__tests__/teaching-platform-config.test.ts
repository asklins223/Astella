import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { setPlatformConfig, resetPlatformConfigCache } from "@astella/shared/platform-config-node";
import type { AIPlatformConfig } from "@astella/shared/platform-config";
import { resolveTeachingModelConfig, resolveArtifactModelConfig, teachingModelBody, teachingModelHeaders } from "../teaching/teaching-llm.ts";

afterEach(() => resetPlatformConfigCache());

test("MiMo-only text routing starts teaching and artifact providers using Responses JSON", () => {
  const config = JSON.parse(readFileSync(new URL("../../../../../../config/ai-platforms.json", import.meta.url), "utf8")) as AIPlatformConfig;
  config.platforms["mimo-agent"]!.apiKey = "synthetic-mimo-key";
  setPlatformConfig(config);
  for (const resolved of [resolveTeachingModelConfig(), resolveArtifactModelConfig()]) {
    assert.ok(resolved, "configured teaching provider must be available at route startup");
    assert.equal(resolved.model, "mimo-v2.6-flash");
    assert.equal(resolved.url, "https://api.xiaomimimo.com/v1/responses");
    assert.equal(resolved.protocol, "responses");
    assert.deepEqual(teachingModelHeaders(resolved), { "api-key": "synthetic-mimo-key", "content-type": "application/json" });
    const body = teachingModelBody(resolved, "synthetic prompt", 0.2);
    assert.deepEqual(body.reasoning, { effort: "none" });
    assert.deepEqual(body.text, { format: { type: "json_object" } });
    assert.equal(body.max_output_tokens, 131072);
    assert.equal(body.messages, undefined);
  }
});
