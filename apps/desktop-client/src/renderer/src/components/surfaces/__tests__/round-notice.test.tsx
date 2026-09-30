// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RoundNotice } from "../notebook/round-notice.tsx";

/**
 * 这一组盯的是 39 §13.3／§13.4 那一刀：**等待、失败、被挡是三件事**。
 *
 * 此前它们是同一样东西——一段灰字 + role="alert"，摆在纸片最底下。于是
 * 「这一轮正在准备讲解」（服务端**已经收下**这一发）顶着一张红色的脸，
 * 而「还没签署 AI 使用同意」给不出任何能按的按钮。
 */
// 这个工程没有注册 testing-library 的自动 cleanup：不收的话上一条用例的
// role="alert" 会留在 DOM 里，下一条 getByRole 就会撞上"找到多个"。
afterEach(() => {
  cleanup();
});

describe("RoundNotice · 四档的形状不一样", () => {
  it("pending 不是错误：不进 role=alert，也不给重试", () => {
    render(
      <RoundNotice
        kind="pending"
        message="这一轮正在准备讲解，稍后刷新就能接回；不用重复生成。"
        onRetry={() => { throw new Error("pending 不该有重试"); }}
      />,
    );
    const notice = screen.getByText(/正在准备讲解/).closest("[data-round-notice]");
    expect(notice).not.toBeNull();
    expect(notice!.getAttribute("data-round-notice")).toBe("pending");
    // 正在做一件事不是错误，播报它只会打断人
    expect(notice!.closest("[role='alert']")).toBeNull();
    // 给一颗按了会抛的按钮：真的渲染了就当场红
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("retryable 进 alert，且给就地重试", () => {
    const onRetry = vi.fn();
    render(<RoundNotice kind="retryable" message="学习服务暂时不可用" onRetry={onRetry} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("学习服务暂时不可用");
    screen.getByRole("button", { name: "重试这一步" }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("blocked 不给重试：重试一万次也没用，缺的是「去哪解决」", () => {
    render(
      <RoundNotice
        kind="blocked"
        message="还没签署 AI 使用同意"
        onRetry={() => { throw new Error("blocked 不该有重试"); }}
        secondary={<button type="button">去设置</button>}
      />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重试这一步" })).toBeNull();
    // 出路仍然要给
    expect(screen.getByRole("button", { name: "去设置" })).toBeTruthy();
  });

  it("失败那句必须原样留着——补上档位名不是替换它", () => {
    const message = "这条学习状态已经发生变化，请先同步后再继续。";
    render(<RoundNotice kind="failed" message={message} onRetry={() => {}} />);
    expect(screen.getByRole("alert").textContent).toContain(message);
  });
});
