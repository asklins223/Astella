// @vitest-environment jsdom
/// <reference types="node" />
import { afterEach, expect, it, vi } from "vitest";
import { artifactDocumentTemplate } from "../../../../../main/artifact-template";
import { runInNewContext } from "node:vm";

afterEach(() => { document.body.replaceChildren(); document.body.style.removeProperty("margin-bottom"); vi.restoreAllMocks(); vi.useRealTimers(); });

it("reports generated content height without feeding the iframe viewport back into itself", () => {
  vi.useFakeTimers();
  const template = new DOMParser().parseFromString(artifactDocumentTemplate(), "text/html");
  const root = template.getElementById("ailearn-artifact-root")!;
  document.body.append(document.importNode(root, true));
  const content = document.getElementById("ailearn-artifact-root")!;
  let height = 260;
  vi.spyOn(content, "scrollHeight", "get").mockImplementation(() => height);
  vi.spyOn(content, "offsetHeight", "get").mockImplementation(() => height);
  vi.spyOn(content, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 600, height));
  vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(1600);
  vi.spyOn(document.body, "offsetHeight", "get").mockReturnValue(1600);
  const post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  const script = template.querySelector("script")!.textContent!;
  window.eval(script);
  document.dispatchEvent(new Event("DOMContentLoaded"));
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ phase: "ready", contentHeight: 260 }), "*");
  height = 210;
  vi.advanceTimersByTime(1000);
  expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "heartbeat", contentHeight: 210 }), "*");
  const hostStyle = template.querySelector("style[data-artifact-host]")!.textContent!;
  expect(hostStyle).toContain("min-height: 0 !important");
  expect(hostStyle).not.toMatch(/display: block|background: transparent.*body|margin: 0|padding: 0.*body/);
});

it("includes the generated page's own body spacing in its measured height", () => {
  vi.useFakeTimers();
  document.body.style.marginBottom = "8px";
  const template = new DOMParser().parseFromString(artifactDocumentTemplate(), "text/html");
  document.body.append(document.importNode(template.getElementById("ailearn-artifact-root")!, true));
  const root = document.getElementById("ailearn-artifact-root")!;
  vi.spyOn(root, "scrollHeight", "get").mockReturnValue(260);
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 20, 600, 260));
  vi.spyOn(document.body, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 300));
  const post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  window.eval(template.querySelector("script")!.textContent!);
  document.dispatchEvent(new Event("DOMContentLoaded"));
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ phase: "ready", contentHeight: 308 }), "*");
});

it.each([true, false])("embeds only the generated scene while retaining its nodes and interactions; content view: %s", (contentOnly) => {
  const template = new DOMParser().parseFromString(artifactDocumentTemplate(), "text/html");
  document.body.innerHTML = `<div id="ailearn-artifact-root"><div class="ailearn-art" data-outline-count="3"><h2 class="ailearn-art__title">Saved title</h2><div class="ailearn-art__scene"><h2>Generated title</h2><button>Try this</button></div></div></div>`;
  const root = document.getElementById("ailearn-artifact-root")!;
  const before = root.innerHTML;
  const generatedHeading = document.querySelector(".ailearn-art__scene h2")!;
  const button = document.querySelector<HTMLButtonElement>(".ailearn-art__scene button")!;
  const onClick = vi.fn();
  button.addEventListener("click", onClick);
  runInNewContext(template.querySelector("script")!.textContent!, {
    document, getComputedStyle, parent: { postMessage: vi.fn() }, setInterval: vi.fn(),
    window: { location: { hash: contentOnly ? "#content" : "" }, matchMedia: () => ({ matches: false }), addEventListener: vi.fn() },
  });
  if (contentOnly) {
    expect(root.querySelector(".ailearn-art")).toBeNull();
    expect(root.querySelector(".ailearn-art__scene")).toBeNull();
    expect(root.getAttribute("data-artifact-outline-count")).toBe("3");
    expect(root.children).toHaveLength(2);
  } else {
    expect(root.innerHTML).toBe(before);
  }
  expect(root.contains(generatedHeading)).toBe(true);
  expect(root.querySelector("button")).toBe(button);
  button.click();
  expect(onClick).toHaveBeenCalledOnce();
});
