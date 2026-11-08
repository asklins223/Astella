// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as tokens from "../code-tokens";
import { CodePaper } from "../code-paper";
import { renderCompanionStreamingMarkdown } from "../../companion/content/companion-markdown-reveal";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("retains the code block and highlighted tokens while only its reveal cursor advances", async () => {
  const source = "const answer = 42;";
  const highlight = vi.spyOn(tokens, "highlightCodeBlock").mockResolvedValue({ source, label: "JavaScript", lines: [[
    { text: "const", classes: "code-keyword", start: 0 }, { text: " answer = 42;", classes: "", start: 5 },
  ]] });
  const markdown = "```js\n" + source + "\n```";
  const view = render(<>{renderCompanionStreamingMarkdown(markdown, "```js\nconst")}</>);
  await waitFor(() => expect(view.container.querySelector(".code-keyword")?.textContent).toBe("const"));
  const figure = view.container.querySelector("figure"), keyword = view.container.querySelector(".code-keyword");
  for (let count = 6; count <= source.length; count++) {
    view.rerender(<>{renderCompanionStreamingMarkdown(markdown, "```js\n" + source.slice(0, count))}</>);
    expect(view.container.querySelector("figure")).toBe(figure);
    expect(view.container.querySelector(".code-keyword")).toBe(keyword);
    expect(view.container.querySelector("code")?.textContent).toBe(source.slice(0, count));
  }
  view.rerender(<>{renderCompanionStreamingMarkdown(markdown, markdown)}</>);
  expect(view.container.querySelector("figure")).toBe(figure);
  expect(view.container.querySelector(".code-keyword")).toBe(keyword);
  expect(highlight).toHaveBeenCalledTimes(1);
});

it("keeps existing token colors and the language label while an appended packet waits for highlighting", async () => {
  const source = "const x = 1;";
  const spy = vi.spyOn(tokens, "highlightCodeBlock").mockResolvedValue({ source, label: "JavaScript", lines: [[
    { text: "const", classes: "code-keyword", start: 0 }, { text: " x = 1;", classes: "", start: 5 },
  ]] });
  const view = render(<CodePaper source={source} fence="js" />);
  await waitFor(() => expect(view.container.querySelector(".code-keyword")).not.toBeNull());
  const keyword = view.container.querySelector(".code-keyword");
  let resolve!: (value: tokens.CodeHighlight) => void;
  spy.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const next = source + "\nconsole.log(x);";
  view.rerender(<CodePaper source={next} fence="js" />);
  expect(view.container.querySelector(".code-keyword")).toBe(keyword);
  expect(view.container.querySelector(".code-paper__language")?.textContent).toBe("JavaScript");
  expect(view.container.querySelector("code")?.textContent).toBe(next);
  await act(async () => resolve({ source: next, label: "JavaScript", lines: null }));
});
