// @vitest-environment jsdom
/// <reference types="node" />
import { runInNewContext } from "node:vm";
import { afterEach, expect, test, vi } from "vitest";
import { assembleArtifactDocument } from "../../../../main/artifact-surface";

afterEach(() => { document.body.innerHTML = ""; });

test("server storyboards report their real step count and reduced motion preserves each pane exactly once", () => {
  const content = Array.from({ length: 4 }, (_, index) =>
    `<section data-artifact-step="${index}"><p>第 ${index + 1} 段内容</p></section>`).join("");
  const assembled = assembleArtifactDocument({ artifactId: "44444444-4444-4444-8444-444444444444", content });
  expect(assembled.ok).toBe(true); if (!assembled.ok) return;
  const parsed = new DOMParser().parseFromString(assembled.document, "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
  const script = parsed.querySelector("script")!.textContent!;
  const messages: Array<{ phase: string; stepCount?: number }> = [];
  const listeners: Record<string, (event: { data: unknown }) => void> = {};
  const frameParent = { postMessage: (message: typeof messages[number]) => messages.push(message) };
  runInNewContext(script, { document, parent: frameParent, setInterval: vi.fn(), window: {
    matchMedia: () => ({ matches: true }), parent: frameParent,
    addEventListener: (type: string, handler: typeof listeners[string]) => { listeners[type] = handler; },
  } });
  document.dispatchEvent(new Event("DOMContentLoaded"));
  expect(messages.find((message) => message.phase === "ready")?.stepCount).toBe(4);
  for (let index = 0; index < 2; index++) listeners.message({ data: {
    channel: "ailearn:artifact-frame", direction: "host->frame", command: "motion", motion: "reduced",
  } });
  expect(document.querySelectorAll("#ailearn-artifact-root [data-artifact-step]")).toHaveLength(4);
  expect(document.querySelector("#ailearn-artifact-root")!.textContent).toBe("第 1 段内容第 2 段内容第 3 段内容第 4 段内容");
});
