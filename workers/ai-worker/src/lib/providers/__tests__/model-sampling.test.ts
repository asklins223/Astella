import assert from "node:assert/strict";
import { test } from "node:test";
import { modelTemperatureFields } from "../model-sampling.ts";
import { profileFingerprint } from "../profile-fingerprint.ts";

test("采样支持按实际发出的推理档位处理，最低档不等于关闭", () => {
  const profile = { temperature: "reasoning_none_only" as const };
  assert.deepEqual(modelTemperatureFields(profile, 0.9, "none"), { temperature: 0.9 });
  for (const effort of ["minimal", "medium", undefined]) assert.deepEqual(modelTemperatureFields(profile, 0.9, effort), {});
  assert.deepEqual(modelTemperatureFields({ temperature: "unsupported" }, 0.9, "none"), {});
  assert.deepEqual(modelTemperatureFields(undefined, 0.9, "high"), { temperature: 0.9 });
});

test("支持的最低档和采样策略变化都会改变能力指纹，档位排列不会", () => {
  const profile = { reasoning: { levels: ["none", "medium"] as Array<"none" | "medium">, default: "medium" as const } };
  assert.notEqual(profileFingerprint(profile), profileFingerprint({ ...profile, reasoning: { ...profile.reasoning, levels: ["medium"] } }));
  assert.notEqual(profileFingerprint(profile), profileFingerprint({ ...profile, temperature: "reasoning_none_only" }));
  assert.equal(profileFingerprint(profile), profileFingerprint({ ...profile, reasoning: { ...profile.reasoning, levels: ["medium", "none"] } }));
});
