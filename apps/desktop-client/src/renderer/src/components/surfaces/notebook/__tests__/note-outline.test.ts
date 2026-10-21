import { describe, expect, it } from "vitest";
import type { NoteBlockProjectionV1 } from "@astella/shared/note-projection-contracts";
import { noteOutline } from "../document/note-outline.ts";

/**
 * 目录（「这一篇」那张纸）列出的是给人读的标题。
 *
 * 实时文档还没接上时走的是 `fallback` 分支：块里存的是 Markdown（`# 标题`、
 * `<h2>标题</h2>`），直接拿 `content` 当标题就会把标记符号带进目录。这一组钉住
 * 「目录说人话」：标题按显示文本列出，序号仍是块号。
 */

const blocks = (...items: readonly (readonly [string, string])[]): NoteBlockProjectionV1[] =>
  items.map(([type, content], ordinal) => ({ ordinal, type, content })) as unknown as NoteBlockProjectionV1[];

describe("目录标题不漏 Markdown/HTML 标记", () => {
  it("fallback 分支把 `# 标题` 与 `<h2>标题</h2>` 都读成标题文字", () => {
    const outline = noteOutline(null, blocks(
      ["heading", "# 宋朝的经济与社会变迁"],
      ["paragraph", "正文"],
      ["heading", "<h2>商业与城市</h2>"],
      ["heading", "坊市不再封闭"],
    ));
    expect(outline).toEqual([
      { block: 0, level: 1, title: "宋朝的经济与社会变迁" },
      { block: 2, level: 1, title: "商业与城市" },
      { block: 3, level: 1, title: "坊市不再封闭" },
    ]);
  });

  it("空标题仍给一个占位名，不列出空的目录项", () => {
    expect(noteOutline(null, blocks(["heading", "#"], ["paragraph", "正文"])))
      .toEqual([{ block: 0, level: 1, title: "未命名小节" }]);
  });
});
