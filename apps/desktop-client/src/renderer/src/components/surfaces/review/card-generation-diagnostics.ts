import type { CardGenerationRunFailureV1 } from "@astella/shared/card-generation-desktop-contracts";

/** Render the safe failure projection from main, without provider error text. */
export function cardGenerationDiagnostic(failure: CardGenerationRunFailureV1 | null): {
  title: string; detail: string; permission?: "consent_required" | "external_disabled";
} | null {
  if (!failure) return null;
  if (failure.reason === "consent_required") return {
    title: "还需要签署 AI 使用同意", detail: "开启 AI 使用权限后，再重新生成。已有草稿会保留。", permission: "consent_required",
  };
  if (failure.reason === "external_disabled") return {
    title: "外部 AI 使用尚未开启", detail: "在 AI 使用设置中开启「允许发送到外部模型服务」后，再重新生成。", permission: "external_disabled",
  };
  if (failure.reason === "quality_failed") return {
    title: "这批草稿未通过核对", detail: "这批题面没有达到依据与内容要求，暂时不能保存为学习卡。草稿已保留，可以检查原文或重新生成。",
  };
  if (failure.reason === "output_invalid") {
    const stage = failure.stage === "check" ? "核对" : failure.stage === "rewrite" ? "修订" : "生成";
    return { title: `${stage}结果未能读取`, detail: `模型返回的${stage}内容不完整或格式不符合要求，本次已停止。已有题面保留，可以重新生成。` };
  }
  if (failure.reason === "timeout") return {
    title: "生成等待超时", detail: "模型未在本次等待时间内完成。已有题面保留，稍后可以重新生成。",
  };
  return null;
}
