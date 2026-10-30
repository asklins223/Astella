import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAICompatibleProvider } from "../lib/providers/openai-compatible.ts";
import { OpenCodeGoProvider } from "../lib/providers/opencode-go.ts";

test("接口能力只在模型档案明确声明视觉时提供 visionModelId", () => {
  for (const Provider of [OpenAICompatibleProvider, OpenCodeGoProvider]) {
    for (const vision of [true, false, undefined]) {
      const provider = new Provider({ apiKey: "test-key", model: "fixture-model",
        baseUrl: Provider === OpenCodeGoProvider ? "https://opencode.ai/zen/v1" : "https://example.invalid/v1",
        ...(vision === undefined ? {} : { modelProfile: {
          contextWindowTokens: 65_536, maxOutputTokens: 8_192, vision,
        } }),
      });
      const expected = vision === true ? "fixture-model" : "";
      assert.equal(provider.visionModelId, expected, `${Provider.name}: vision=${vision}`);
      assert.equal(provider.getCapabilities().visionModelId, expected);
    }
  }
});
