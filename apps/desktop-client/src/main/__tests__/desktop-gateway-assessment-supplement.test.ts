import { describe, expect, it, vi } from "vitest";
import { supplementAssessmentDispute } from "../desktop-gateway-ns-assessment";
import type { GatewayTransport } from "../desktop-gateway-transport";

const assessmentId = "bffcad7b-ce6f-4159-8483-8eccc8a87dcd";
const disputeId = "11111111-1111-4111-8111-111111111111";
const request = { assessmentId, supplement: "right 包含端点本身" };
function transport(body: unknown) {
  const request = vi.fn(async () => ({ status: 200, body }));
  return { request, ensureConnected: vi.fn(async () => {}) } as unknown as GatewayTransport;
}

describe("判定异议补充说明的真实 HTTP 回执", () => {
  it("接受服务器带版本和争议编号的回执，返回既有 IPC 确认", async () => {
    const t = transport({ version: 2, disputeId, accepted: true });
    await expect(supplementAssessmentDispute(t, request)).resolves.toEqual({ accepted: true });
    expect(t.request).toHaveBeenCalledWith(`/learning/assessments/${assessmentId}/disputes/supplement`,
      { method: "POST", body: JSON.stringify({ supplement: request.supplement }) }, true, true, undefined);
  });

  it.each([
    { accepted: true },
    { version: 3, disputeId, accepted: true },
    { version: 2, disputeId: "invalid", accepted: true },
  ])("不把不完整或不支持的回执当成保存成功", async body => {
    await expect(supplementAssessmentDispute(transport(body), request)).rejects.toMatchObject({ code: "unsupported_contract" });
  });
});
