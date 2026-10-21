import { describe, expect, it } from "vitest";
import { RendererGatewayError } from "../client/desktop-client";
import { companionReplyFailureMessage, companionTurnErrorMessage } from "../companion-session/companion-chat-routing";

const failure = (code: "conflict" | "api_unavailable") => new RendererGatewayError({
  code, retry: "never", safeMessageKey: `error.${code}`,
});

describe("被上一条挡住时的措辞", () => {
  it("认得出是哪条在挡，就指向那颗真存在的按钮", () => {
    expect(companionTurnErrorMessage(failure("conflict"), true)).toContain("停掉上一条");
  });

  it("认不出那条 run 时不许指向不存在的停止，也不许声称系统会自动收掉", () => {
    // 2026-10-17 线上：旧文案说「系统几十秒内会自动收掉它」，实际一条 run 也没挂着
    // （本地接替号过期），用户照着等只会一直发不出去。现在客户端会先清号重发，
    // 走到这句说明确实还有一条读不到的活动 run——只陈述能确认的事实。
    const message = companionTurnErrorMessage(failure("conflict"), false);
    expect(message).not.toContain("点停止");
    expect(message).not.toContain("停掉上一条");
    expect(message).not.toContain("自动收掉");
    expect(message).toContain("暂时对不上");
    expect(message).toContain("再发一次");
  });

  it("别的失败照旧走通用文案，不套这条", () => {
    expect(companionTurnErrorMessage(failure("api_unavailable"))).not.toContain("上一条");
  });
  it("区分服务首输出超时和输出中断，并说明可继续", () => {
    expect(companionReplyFailureMessage("PROVIDER_FIRST_OUTPUT_TIMEOUT", true)).toContain("首段内容");
    expect(companionReplyFailureMessage("PROVIDER_IDLE_TIMEOUT", true)).toContain("新的进展超时");
    expect(companionReplyFailureMessage("PROVIDER_FIRST_OUTPUT_TIMEOUT", true)).toContain("从中断处继续");
  });
});
