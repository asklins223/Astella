import { expect, it } from "vitest";
import { projectCardGenerationRunFailureV1 } from "@astella/shared/card-generation-desktop-contracts";
import { cardGenerationDiagnostic } from "../review/card-generation-diagnostics";

const diagnostic = (error: Parameters<typeof projectCardGenerationRunFailureV1>[0]) => cardGenerationDiagnostic(projectCardGenerationRunFailureV1(error));

it("explains the interrupted stage without rendering raw model or credential text", () => {
  const result = diagnostic({ code: "generation_failed", message: "card_content_check_v3 output rejected: output_shape — secret provider response" });
  expect(result?.title).toBe("核对结果未能读取");
  expect(result?.detail).toContain("已有题面保留");
  expect(result?.detail).not.toContain("secret");
  expect(diagnostic({ code: "generation_output_invalid", message: "card_candidate_rewrite_v3" })?.title).toBe("修订结果未能读取");
  expect(diagnostic({ code: "generation_timeout", message: null })?.title).toContain("超时");
  expect(diagnostic({ code: "generation_failed", message: "unrecognized secret" })).toBeNull();
});
it("gives an actionable permission reason for historical stopped tasks", () => {
  expect(diagnostic({ code: "ai_data_policy_denied", message: null })?.permission).toBe("external_disabled");
  expect(diagnostic({ code: "ai_consent_required", message: null })?.permission).toBe("consent_required");
});

it("distinguishes finished checking with no passed cards from an interrupted check", () => {
  const result = diagnostic({ code: "quality_gate_failed", message: "批量内容检查没有放行任何一张" });
  expect(result?.title).toBe("这批草稿未通过核对");
  expect(result?.detail).toContain("暂时不能保存为学习卡");
});
