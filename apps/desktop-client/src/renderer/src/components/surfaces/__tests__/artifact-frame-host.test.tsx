// @vitest-environment jsdom
/**
 * 产物宿主组件的状态机用例（39d W4-1 第二段）。
 *
 * jsdom 里 iframe 没有 contentWindow，所以受信 source 判据经 `isTrustedFrameSource`
 * 接缝喂假 source——生产默认（`source === iframe.contentWindow`）的真窗口验证是
 * T6 探针（随 W4-6 的挂载点），这里钉的是**状态机与判据的"且"关系**：
 * 来源不可信（哪怕数据合法）不收、数据不合法（哪怕来源可信）不收、
 * 心跳养着 live、心跳没了重建一次、第二次降级、frame 自报 error 不摘 frame。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ArtifactFrameHost } from "../source/artifact-frame-host.tsx";

const ARTIFACT_ID = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";
const FAKE_FRAME_SOURCE = { postMessage: vi.fn() } as unknown as MessageEventSource;

const trusted = (source: MessageEventSource | null) => source === FAKE_FRAME_SOURCE;

/** jsdom 会校验 MessageEventInit.source 的接口类型，假 source 要构造后手动覆盖。 */
function withSource(event: MessageEvent, source: MessageEventSource): MessageEvent {
  Object.defineProperty(event, "source", { value: source });
  return event;
}

function frameMessage(phase: "ready" | "heartbeat" | "error", extra: Record<string, unknown> = {}): MessageEvent {
  return withSource(new MessageEvent("message", {
    data: { channel: "ailearn:artifact-frame", direction: "frame->host", phase, ...extra },
  }), FAKE_FRAME_SOURCE);
}

function foreignMessage(): MessageEvent {
  return withSource(new MessageEvent("message", {
    data: { channel: "ailearn:artifact-frame", direction: "frame->host", phase: "ready", stepCount: 3 },
  }), { postMessage: vi.fn() } as unknown as MessageEventSource);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-26T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("ArtifactFrameHost", () => {
  it("ready（来源可信）后进入 live，心跳养着它不降级", async () => {
    render(<ArtifactFrameHost artifactId={ARTIFACT_ID} isTrustedFrameSource={trusted} />);
    expect(screen.getByText("正在准备动态内容…")).toBeTruthy();

    act(() => {
      window.dispatchEvent(frameMessage("ready", { stepCount: 3 }));
    });
    expect(screen.getByText("这一页讲了 3 个要点")).toBeTruthy();

    // 心跳每秒一拍：喂满二十秒，看门没有理由动手（不喂它才会降级——那是
    // 降级用例的事，这里只证"喂着心跳就一直活着"）。
    for (let i = 0; i < 20; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      act(() => {
        window.dispatchEvent(frameMessage("heartbeat"));
      });
    }
    expect(screen.getByText("这一页讲了 3 个要点")).toBeTruthy();
    expect(screen.queryByText(/没能跑起来/)).toBeNull();
  });

  it("来源不可信的消息（数据再合法）不收；来源可信但数据不合法也不收", () => {
    render(<ArtifactFrameHost artifactId={ARTIFACT_ID} isTrustedFrameSource={trusted} />);
    act(() => {
      window.dispatchEvent(foreignMessage());
    });
    expect(screen.getByText("正在准备动态内容…")).toBeTruthy();

    // 合法来源、错误通道。
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
      source: FAKE_FRAME_SOURCE,
      data: { channel: "ailearn:artifact-frame", direction: "host->frame", phase: "ready" },
    }));
    });
    expect(screen.getByText("正在准备动态内容…")).toBeTruthy();

    act(() => {
      window.dispatchEvent(frameMessage("ready", { stepCount: 2 }));
    });
    expect(screen.getByText("这一页讲了 2 个要点")).toBeTruthy();
  });

  it("没有 ready：看门到点重建一次，第二次仍无心跳 ⇒ 降级并摘掉 iframe", async () => {
    const { container } = render(
      <ArtifactFrameHost artifactId={ARTIFACT_ID} isTrustedFrameSource={trusted} />,
    );
    expect(container.querySelector("iframe")).toBeTruthy();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(screen.getByText("正在准备动态内容…")).toBeTruthy();
    expect(container.querySelector("iframe")).toBeTruthy();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(screen.getByText(/这份动态内容没能跑起来，已停止等待/)).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
    // 重建与降级都发生在看门的节拍上，主页面（本测试自身）从未被卡住。
  });

  it("心跳消失一次 → 重建后 ready 回来（崩溃被重建救回），不再降级", async () => {
    const { container } = render(
      <ArtifactFrameHost artifactId={ARTIFACT_ID} isTrustedFrameSource={trusted} />,
    );
    act(() => {
      window.dispatchEvent(frameMessage("ready", { stepCount: 4 }));
    });
    // 心跳停了：看门到点重建。
    await vi.advanceTimersByTimeAsync(5_000);
    expect(screen.getByText("正在准备动态内容…")).toBeTruthy();
    const rebuilt = container.querySelector("iframe");
    expect(rebuilt).toBeTruthy();

    // 新 frame 的 ready 把它救回 live。
    act(() => {
      window.dispatchEvent(frameMessage("ready", { stepCount: 4 }));
    });
    // 「共 N 步」是上一版的说法（那一版的产物是自己的一排格，按顺序推一遍）。现在 N 是
    // 这一页讲的**要点**条数，说法跟着改——留着旧文案就是在教用户一个已经不存在的操作。
    expect(screen.getByText("这一页讲了 4 个要点")).toBeTruthy();
    expect(rebuilt).toBeTruthy();
  });

  it("frame 自报 error：如实亮出 detail，但 frame 不摘（心跳可能还在）", () => {
    const { container } = render(
      <ArtifactFrameHost artifactId={ARTIFACT_ID} isTrustedFrameSource={trusted} />,
    );
    act(() => {
      window.dispatchEvent(frameMessage("ready", { stepCount: 1 }));
    });
    act(() => {
      window.dispatchEvent(frameMessage("error", { detail: "render 第 2 步除零" }));
    });
    expect(screen.getByText(/render 第 2 步除零/)).toBeTruthy();
    expect(container.querySelector("iframe")).toBeTruthy();
  });

  it("降级时渲染调用方给的等价内容", async () => {
    const { container } = render(
      <ArtifactFrameHost
        artifactId={ARTIFACT_ID}
        isTrustedFrameSource={trusted}
        fallback={<p data-testid="storyboard">静态分镜占位</p>}
      />,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(screen.getByTestId("storyboard")).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("降级时没有等价内容就只有那句话，不编造分镜", async () => {
    const { container } = render(
      <ArtifactFrameHost artifactId={ARTIFACT_ID} isTrustedFrameSource={trusted} />,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.queryByTestId("storyboard")).toBeNull();
    expect(screen.getByText(/文字等价与分镜如下（若有）/)).toBeTruthy();
  });

  it("非法的产物 id：就地说明，不渲染 iframe", () => {
    const { container } = render(
      <ArtifactFrameHost artifactId="not-a-uuid" isTrustedFrameSource={trusted} />,
    );
    expect(screen.getByText(/引用不合法/)).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
  });
});

// ── 高度握手（真窗口里那一格缩成一小块、内容自己出滚动条的根因）──────────────
//
// 父侧量不到 frame 的内容（不透明 origin），所以高度只能由产物自己报。不报的话
// 宿主只能给一个写死的行高：画面被压扁、iframe 内部自己长出滚动条，而"共 N 步"
// 孤零零飘在旁边——那是两边对不上尺寸，不是设计。
it("产物报上来的高度直接变成 iframe 的高度，产物内部因此不滚", () => {
  render(<ArtifactFrameHost artifactId={ARTIFACT_ID} isTrustedFrameSource={trusted} />);
  const frame = () => document.querySelector("iframe") as HTMLIFrameElement;
  // 还没量到时给一个中位起始高度，不塌成 iframe 默认的 150px
  expect(parseInt(frame().style.height, 10)).toBeGreaterThanOrEqual(180);

  act(() => { window.dispatchEvent(frameMessage("ready", { stepCount: 4, contentHeight: 640 })); });
  expect(parseInt(frame().style.height, 10)).toBe(640);
});

it("高度被夹在上下限之间：过短不塌成空框，过长不由产物内部滚", () => {
  render(<ArtifactFrameHost artifactId={ARTIFACT_ID} isTrustedFrameSource={trusted} />);
  const frame = () => document.querySelector("iframe") as HTMLIFrameElement;

  act(() => { window.dispatchEvent(frameMessage("heartbeat", { contentHeight: 12 })); });
  expect(parseInt(frame().style.height, 10)).toBe(180);

  act(() => { window.dispatchEvent(frameMessage("heartbeat", { contentHeight: 99999 })); });
  expect(parseInt(frame().style.height, 10)).toBe(1600);
  // 超上限时由**外层**滚，并如实告诉用户这一份比较长
  expect(document.querySelector(".artifact-frame-host")?.getAttribute("data-overflow")).toBe("true");
  expect(screen.getByText(/这一份比较长/)).toBeTruthy();
});

it("静态分镜在 ready 之后才重排：只认 ready 会停在旧高度上", () => {
  render(<ArtifactFrameHost artifactId={ARTIFACT_ID} isTrustedFrameSource={trusted} />);
  const frame = () => document.querySelector("iframe") as HTMLIFrameElement;
  act(() => { window.dispatchEvent(frameMessage("ready", { stepCount: 2, contentHeight: 300 })); });
  expect(parseInt(frame().style.height, 10)).toBe(300);
  // 切静态分镜之后产物又报了一次更高的内容
  act(() => { window.dispatchEvent(frameMessage("heartbeat", { contentHeight: 900 })); });
  expect(parseInt(frame().style.height, 10)).toBe(900);
});

it("坏掉的高度不参与：NaN / 负数 / 缺省都当没报", () => {
  render(<ArtifactFrameHost artifactId={ARTIFACT_ID} isTrustedFrameSource={trusted} />);
  const frame = () => document.querySelector("iframe") as HTMLIFrameElement;
  const before = frame().style.height;
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, "tall"]) {
    act(() => { window.dispatchEvent(frameMessage("heartbeat", { contentHeight: bad })); });
  }
  expect(frame().style.height).toBe(before);
});
