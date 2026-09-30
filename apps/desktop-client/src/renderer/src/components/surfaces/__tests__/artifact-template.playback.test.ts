// @vitest-environment jsdom
/// <reference types="node" />
import { runInNewContext } from "node:vm";
import { afterEach, expect, test, vi } from "vitest";
import { assembleArtifactDocument } from "../../../../../main/artifact-surface";

afterEach(() => { document.body.innerHTML = ""; });

/**
 * 这一份模板**不再**有播放器，也不再有静态分镜（2026-09-28 用户裁决）。
 *
 * 上一版的产物是服务端渲染的一排格，所以模板要数 `[data-artifact-step]`、要一个
 * `window.__artifact.render(i)` 的步进机、还要在收到 `reduced` 时把每一步各快照一次
 * 铺成一列。现在画面是模型为这一个知识点写的整页，它有自己的玩法，通用步进机套上去
 * 只会把它压回"填好的表格"——所以那三样一起删掉。
 *
 * 留下来的判据是三条，每一条都在钉"删掉的东西不该以别的形式回来"：
 *   - 讲解条数由**我们自己**渲染的文字等价数出来（`data-artifact-outline-count`），
 *     不向产物要——让它报自己的步数等于让它决定界面上写"共几步"；
 *   - `motion: reduced` 只转给产物自己声明的 `window.setLessonMotion`，模板不重排 DOM；
 *   - 模型写的 `<style>`/`<script>` 各归其位（样式进 `<head>`、脚本进 `</body>` 前），
 *     且这段搬运发生在主进程，模板自己那份脚本不受影响。
 */
const CONTENT_V1 = [
  '<div class="ailearn-art" data-artifact-root data-outline-count="4">',
  '<style data-lesson>.n{fill:var(--lesson-mint)}</style>',
  '<div class="ailearn-art__scene" data-stage><svg viewBox="0 0 10 10"><circle class="n" cx="5" cy="5" r="4" /></svg></div>',
  '<ol class="ailearn-art__list"><li data-artifact-outline>第一步</li><li data-artifact-outline>第二步</li>',
  '<li data-artifact-outline>第三步</li><li data-artifact-outline>第四步</li></ol>',
  '</div>',
  '<script data-lesson>window.setLessonMotion = function (m) { window.__lastMotion = m; };</script>',
].join("");

function bootTemplate(document: string) {
  const assembled = assembleArtifactDocument({
    artifactId: "44444444-4444-4444-8444-444444444444",
    content: document,
  });
  expect(assembled.ok).toBe(true);
  if (!assembled.ok) return null;
  const parsed = new DOMParser().parseFromString(assembled.document, "text/html");
  document_ = parsed;
  return parsed;
}
let document_: Document | null = null;

test("条数由我们自己渲染出来的文字等价数出，不向产物要", () => {
  const parsed = bootTemplate(CONTENT_V1);
  if (!parsed) return;
  document.body.innerHTML = parsed.body.innerHTML;
  const script = parsed.querySelector("script:not([data-lesson])")!.textContent!;
  const messages: Array<{ phase: string; stepCount?: number }> = [];
  const frameParent = { postMessage: (message: typeof messages[number]) => messages.push(message) };
  runInNewContext(script, {
    document,
    parent: frameParent,
    setInterval: vi.fn(),
    window: {
      matchMedia: () => ({ matches: true }),
      parent: frameParent,
      addEventListener: vi.fn(),
    },
  });
  document.dispatchEvent(new Event("DOMContentLoaded"));
  expect(messages.find((message) => message.phase === "ready")?.stepCount).toBe(4);
});

test("产物没声明条数时退回数文字等价的条数，而不是数成 0", () => {
  const parsed = bootTemplate(CONTENT_V1.replace(' data-outline-count="4"', ""));
  if (!parsed) return;
  document.body.innerHTML = parsed.body.innerHTML;
  const script = parsed.querySelector("script:not([data-lesson])")!.textContent!;
  const messages: Array<{ phase: string; stepCount?: number }> = [];
  const frameParent = { postMessage: (message: typeof messages[number]) => messages.push(message) };
  runInNewContext(script, {
    document,
    parent: frameParent,
    setInterval: vi.fn(),
    window: { matchMedia: () => ({ matches: true }), parent: frameParent, addEventListener: vi.fn() },
  });
  document.dispatchEvent(new Event("DOMContentLoaded"));
  expect(messages.find((message) => message.phase === "ready")?.stepCount).toBe(4);
});

test("reduced 只转给产物自己声明的钩子，模板不重排 DOM", () => {
  const parsed = bootTemplate(CONTENT_V1);
  if (!parsed) return;
  document.body.innerHTML = parsed.body.innerHTML;
  const script = parsed.querySelector("script:not([data-lesson])")!.textContent!;
  const listeners: Record<string, (event: { data: unknown }) => void> = {};
  const frameParent = { postMessage: vi.fn() };
  // 产物自己的脚本在这份文档里会真的执行（它是 `</body>` 前的一个真 `<script>`）。
  // 这里由测试代它声明钩子：模板该负责的只是"把档位转过去"，钩子本身是不是模型的
  // 事——所以把钩子摆好，再看模板转不转。
  const seen: string[] = [];
  (window as unknown as { setLessonMotion?: (m: string) => void }).setLessonMotion = (m) => { seen.push(m); };
  runInNewContext(script, {
    document,
    parent: frameParent,
    setInterval: vi.fn(),
    window: {
      matchMedia: () => ({ matches: true }),
      parent: frameParent,
      setLessonMotion: (m: string) => { seen.push(m); },
      addEventListener: (type: string, handler: (event: { data: unknown }) => void) => { listeners[type] = handler; },
    },
  });
  const before = document.querySelector("#ailearn-artifact-root")!.innerHTML;
  listeners.message!({ data: {
    channel: "ailearn:artifact-frame", direction: "host->frame", command: "motion", motion: "reduced",
  } });
  // 产物声明的钩子被调用了，而且只被调用一次（重复投递不该重复通知）。
  expect(seen).toEqual(["reduced"]);
  listeners.message!({ data: {
    channel: "ailearn:artifact-frame", direction: "host->frame", command: "motion", motion: "reduced",
  } });
  expect(seen).toEqual(["reduced", "reduced"]);
  // 而模板自己没有把 root 重建成 N 段：内容一条不少、顺序不变。
  expect(document.querySelector("#ailearn-artifact-root")!.innerHTML).toBe(before);
  expect(document.querySelectorAll("#ailearn-artifact-root [data-artifact-outline]")).toHaveLength(4);
  delete (window as unknown as { setLessonMotion?: unknown }).setLessonMotion;
});

test("产物没声明钩子时模板不报错，也不重排 DOM", () => {
  const parsed = bootTemplate(CONTENT_V1.replace(/<script data-lesson>[\s\S]*?<\/script>/, ""));
  if (!parsed) return;
  document.body.innerHTML = parsed.body.innerHTML;
  const script = parsed.querySelector("script:not([data-lesson])")!.textContent!;
  const listeners: Record<string, (event: { data: unknown }) => void> = {};
  const messages: Array<{ phase: string }> = [];
  const frameParent = { postMessage: (message: typeof messages[number]) => messages.push(message) };
  runInNewContext(script, {
    document,
    parent: frameParent,
    setInterval: vi.fn(),
    window: {
      matchMedia: () => ({ matches: true }),
      parent: frameParent,
      addEventListener: (type: string, handler: (event: { data: unknown }) => void) => { listeners[type] = handler; },
    },
  });
  const before = document.querySelector("#ailearn-artifact-root")!.innerHTML;
  expect(() => listeners.message!({ data: {
    channel: "ailearn:artifact-frame", direction: "host->frame", command: "motion", motion: "reduced",
  } })).not.toThrow();
  expect(document.querySelector("#ailearn-artifact-root")!.innerHTML).toBe(before);
  // 没有钩子就没有"产物报错误"——那份页面照旧跑，宿主不替它下结论。
  expect(messages.some((message) => message.phase === "error")).toBe(false);
});

test("模型写的样式进 head、脚本进 body 末尾，root 里只剩内容", () => {
  const parsed = bootTemplate(CONTENT_V1);
  if (!parsed) return;
  expect(parsed.querySelectorAll("head style[data-lesson]")).toHaveLength(1);
  const headStyles = [...parsed.querySelectorAll("head style")].map((el) => el.textContent ?? "").join("");
  expect(headStyles).toContain("--lesson-mint");
  const bodyMarkup = parsed.body.innerHTML;
  // 脚本在 root 之外、body 的末尾；root 内部不再有 style/script。
  expect(parsed.querySelectorAll("body > script[data-lesson]")).toHaveLength(1);
  expect(parsed.querySelectorAll("#ailearn-artifact-root style")).toHaveLength(0);
  expect(parsed.querySelectorAll("#ailearn-artifact-root script")).toHaveLength(0);
  expect(bodyMarkup).toContain("ailearn-art__scene");
});
