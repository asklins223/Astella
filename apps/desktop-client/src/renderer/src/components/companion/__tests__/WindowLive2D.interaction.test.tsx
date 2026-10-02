// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WindowLive2D } from "../WindowLive2D";

vi.mock("../WindowLive2DDriver", () => ({
  WindowLive2DDriver: class {
    constructor(private options: { onStatus: (status: string) => void }) {}
    async init() { this.options.onStatus("ready"); }
    destroy() {}
    setPresentation() {}
    setVoiceLevel() {}
    setPaused() {}
    setModel() {}
    setFraming() {}
    pushEmotion() {}
  },
}));
vi.mock("../../../app/companion-voice-level", () => ({ subscribeHomeV2VoiceLevel: () => () => {} }));

let styles: HTMLStyleElement;
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  styles = document.createElement("style");
  styles.textContent = readFileSync("src/renderer/src/components/companion/companion-root.css", "utf8");
  document.head.append(styles);
});
afterEach(() => { cleanup(); styles.remove(); vi.unstubAllGlobals(); });

it("accepts a home gesture through a pointer-transparent visual shell", () => {
  const events: string[] = [];
  const invite = vi.fn();
  render(<div style={{ pointerEvents: "none" }}><WindowLive2D active motionMode="off" onInviteRequest={invite}
    onPointerDown={() => events.push("down")} onPointerMove={() => events.push("move")}
    onPointerUp={() => events.push("up")} /></div>);
  const button = screen.getByRole("button", { name: "与AI 伴星互动" });
  expect(getComputedStyle(button).pointerEvents).toBe("auto");
  expect(button.getAttribute("data-draggable")).toBe("true");
  expect(button.draggable).toBe(false);
  expect(getComputedStyle(button).cursor).toBe("grab");
  fireEvent.pointerDown(button);
  fireEvent.pointerMove(button);
  fireEvent.pointerUp(button);
  expect(events).toEqual(["down", "move", "up"]);
  fireEvent.click(button);
  expect(invite).toHaveBeenCalledOnce();
});

it("keeps a task-page invite clickable without advertising a drag gesture", () => {
  const invite = vi.fn();
  render(<WindowLive2D active motionMode="off" onInviteRequest={invite} />);
  const button = screen.getByRole("button", { name: "与AI 伴星互动" });
  expect(getComputedStyle(button).pointerEvents).toBe("auto");
  expect(button.hasAttribute("data-draggable")).toBe(false);
  expect(getComputedStyle(button).cursor).toBe("pointer");
  fireEvent.click(button);
  expect(invite).toHaveBeenCalledOnce();
});
