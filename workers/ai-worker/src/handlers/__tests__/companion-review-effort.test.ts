import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chatThinkingRequestFields } from "@astella/shared";

test("the configured reviewer sends low as requested while high, max and its default remain available", () => {
  const config = JSON.parse(readFileSync(new URL("../../../../../config/ai-platforms.json", import.meta.url), "utf8"));
  const route = config.capabilities.companion_fallback;
  const platform = config.platforms[route.platform], profile = platform.models[route.model];
  // The caller has always asked for low. An outdated high/max-only profile
  // silently raised that request to high, adding long review waits.
  assert.deepEqual(chatThinkingRequestFields(platform.options, profile, false, "low"), { reasoning_effort: "low" });
  assert.deepEqual(chatThinkingRequestFields(platform.options, profile, false, "high"), { reasoning_effort: "high" });
  assert.deepEqual(chatThinkingRequestFields(platform.options, profile, false, "max"), { reasoning_effort: "max" });
  assert.deepEqual(chatThinkingRequestFields(platform.options, profile, false), { reasoning_effort: "high" });
});
