import { test } from "node:test";
import assert from "node:assert/strict";
import { noteBlockMarkdown, noteMarkdownText, noteMarkdownTree, noteLinkHref, noteLinkTarget } from "../note-markdown.ts";
import { noteBlocksToPmNodes, pmNodesToNoteBlocks, noteBlockRenderedTextV1 } from "../note-doc-schema.ts";
import { markdownToBlocks } from "../markdown-parser.ts";

test("真实 Markdown 导入保留 Mermaid 语言、标题级别、任务项和嵌套列表", () => {
  const source = '# 一级\n\n###### 六级\n\n- [x] 已完成\n  - 子项\n- [ ] 待完成\n\n```mermaid\nflowchart LR\nA --> B\n```';
  const parsed = markdownToBlocks(source);
  const nodes = noteBlocksToPmNodes(parsed);
  assert.equal(nodes[0]?.attrs?.level, 1);
  assert.equal(nodes[1]?.attrs?.level, 6);
  assert.equal(nodes[2]?.content?.[0]?.attrs?.checked, true);
  assert.equal(nodes[2]?.content?.[0]?.content?.[1]?.type, "bullet_list");
  assert.equal(nodes[3]?.attrs?.language, "mermaid");
  const projected = pmNodesToNoteBlocks(nodes);
  assert.match(projected[3]!.content, /^```mermaid\nflowchart/);
  assert.equal(noteBlockRenderedTextV1("heading", projected[0]!.content), "一级");
  assert.equal(noteBlockRenderedTextV1("code", projected[3]!.content), "flowchart LR\nA --> B");
  assert.equal(noteBlockRenderedTextV1("list", projected[2]!.content), "已完成子项待完成");
});

test("HTML、嵌套强调、带括号和 title 的图片链接解析成结构，脚本和事件被移除", () => {
  const tree = noteMarkdownTree('<div align="center"><img src="https://example.com/a(1).png" width="96" height="96" onerror="alert(1)"><strong>重点 <em>嵌套</em></strong></div><script>alert(1)</script>');
  const serialized = JSON.stringify(tree);
  assert.match(serialized, /"align":"center"/);
  assert.match(serialized, /"width":96/);
  assert.doesNotMatch(serialized, /onerror|alert\(1\)|"tagName":"script"/);
  assert.equal(noteMarkdownText(tree), "重点 嵌套");
  const markdown = noteMarkdownTree('[![徽章](https://example.com/a.png "说明")](https://example.com) **粗体 *强调***');
  assert.match(JSON.stringify(markdown), /"tagName":"img"/);
  assert.equal(noteMarkdownText(markdown), " 粗体 强调");
});

test("Wiki 链接只识别正文，别名、中文标题和稳定 ID 均可解析", () => {
  const tree = noteMarkdownTree('[[微积分|先看定义]] 和 `[[代码]]`');
  assert.match(JSON.stringify(tree), /astella-note-title:/);
  assert.equal(noteMarkdownText(tree), "先看定义 和 [[代码]]");
  assert.deepEqual(noteLinkTarget(noteLinkHref("note-id")), { kind: "id", value: "note-id" });
  assert.deepEqual(noteLinkTarget('folder/%E5%BE%AE%E7%A7%AF%E5%88%86.md'), { kind: "title", value: "微积分" });
  assert.equal(noteLinkTarget('javascript:alert(1)'), null);
  const escaped = noteMarkdownTree('\\[\\[字面]] [[微积分|先看定义]] `[[代码]]`');
  assert.equal((JSON.stringify(escaped).match(/astella-note-title:/g) ?? []).length, 1);
  assert.equal(noteMarkdownText(escaped), '[[字面]] 先看定义 [[代码]]');
  const projected = pmNodesToNoteBlocks(noteBlocksToPmNodes(markdownToBlocks('[[微积分|先看定义]]')));
  assert.equal(projected[0]!.content, '[先看定义](astella-note-title:%E5%BE%AE%E7%A7%AF%E5%88%86)');
});

test("链接徽章和 HTML 经服务端结构存储往返仍可渲染", () => {
  const blocks = markdownToBlocks('<div align="center">\n\n[![版本][badge]](https://example.com/release)\n\n</div>\n\n[badge]: https://example.com/version.svg');
  const nodes = noteBlocksToPmNodes(blocks);
  assert.equal(nodes[0]!.content![0]!.type, "html");
  assert.equal(nodes[1]!.content![0]!.attrs?.linkHref, "https://example.com/release");
  const projected = pmNodesToNoteBlocks(nodes);
  assert.equal(projected[0]!.content, '<div align="center">');
  assert.equal(projected[1]!.content, '[![版本](https://example.com/version.svg)](https://example.com/release)');
});

test("代码原文中的 HTML 与空白不被解释，美元金额不会变成公式", () => {
  assert.equal(noteMarkdownText(noteMarkdownTree(noteBlockMarkdown("code", '<div>\n  **literal**\n</div>'))), '<div>\n  **literal**\n</div>');
  assert.equal(noteBlockRenderedTextV1("paragraph", '价格 $100 和 $200。'), '价格 $100 和 $200。');
});
