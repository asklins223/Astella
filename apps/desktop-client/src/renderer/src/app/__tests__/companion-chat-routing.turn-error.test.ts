import { describe, expect, it } from "vitest";
import { RendererGatewayError } from "../desktop-client";
import { companionTurnErrorMessage } from "../companion-chat-routing";

const failure = (code: "conflict" | "api_unavailable") => new RendererGatewayError({
  code, retry: "never", safeMessageKey: `error.${code}`,
});

describe("被上一条挡住时的措辞", () => {
  it("认得出是哪条在挡，就指向那颗真存在的按钮", () => {
    expect(companionTurnErrorMessage(failure("conflict"), true)).toContain("停掉上一条");
  });

  it("认不出那条 run 时不许再指向不存在的停止，说的是服务端会自动收掉", () => {
    const message = companionTurnErrorMessage(failure("conflict"), false);
    expect(message).not.toContain("点停止");
    expect(message).not.toContain("停掉上一条");
    expect(message).toContain("自动收掉");
  });

  it("别的失败照旧走通用文案，不套这条", () => {
    expect(companionTurnErrorMessage(failure("api_unavailable"))).not.toContain("上一条");
  });
});
