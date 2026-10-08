import { test } from "node:test";
import assert from "node:assert/strict";
import { noteBlockMarkdown, noteMarkdownText, noteMarkdownTree, noteLinkHref, noteLinkTarget, noteImageMarkdown, noteImageHtmlAttrs } from "../note-markdown.ts";
import { noteBlocksToPmNodes, pmNodesToNoteBlocks, noteBlockRenderedTextV1 } from "../note-doc-schema.ts";
import { markdownToBlocks } from "../markdown-parser.ts";

test("富文本排版经服务端分块重建保留脚注、行内公式和字体", () => {
  const content = '<p style="text-align:center;line-height:2.4"><span style="color:#a44b3b;font-size:24px">彩色</span> H<sub>2</sub>O $x^2$ 参考<sup data-note-ref="n">[n]</sup></p>';
  const nodes = noteBlocksToPmNodes([{ type: "paragraph", content }, { type: "paragraph", content: "[^n]: **注释**" }]);
  assert.equal(nodes[0]?.attrs?.noteStyle && (nodes[0].attrs.noteStyle as { align: string }).align, "center");
  assert.ok(nodes[0]?.content?.some(node => node.type === "note_ref" && node.attrs?.label === "n"));
  assert.ok(nodes[0]?.content?.some(node => node.text?.includes("$x^2$")));
  const roundTrip = pmNodesToNoteBlocks(nodes).map(block => block.content).join("\n\n");
  const tree = noteMarkdownTree(roundTrip), elements: { tagName: string; properties: Record<string, unknown> }[] = [];
  const walk = (node: unknown) => { const value = node as { type: string; tagName: string; properties: Record<string, unknown>; children?: unknown[] }; if (value.type === "element") elements.push(value); value.children?.forEach(walk); }; walk(tree);
  assert.ok(elements.some(node => node.tagName === "sub"));
  assert.ok(elements.some(node => node.properties.dataNoteMath === "x^2" && node.properties.dataNoteMathDisplay === undefined));
  assert.ok(noteMarkdownText(tree).includes("注释"));
});

test("普通脚注引用经独立分块重建仍是引用节点", () => {
  const nodes = noteBlocksToPmNodes([{ type: "paragraph", content: "参考[^n]" }, { type: "paragraph", content: "[^n]: 注释内容" }]);
  assert.equal(nodes[0]?.content?.at(-1)?.type, "note_ref");
  assert.equal(pmNodesToNoteBlocks(nodes)[0]?.content, "参考[^n]");
});

test("图片尺寸、说明和悬停提示通过服务端投影与 Markdown 再导入保留", () => {
  const attrs = { src: "https://example.com/a.png?a=1&b=2", alt: '图 [A] & "B"', title: "原图", width: 320, height: null };
  const content = noteImageMarkdown(attrs);
  const nodes = noteBlocksToPmNodes([{ type: "image", content, imageAssetId: "asset-1" }]);
  assert.deepEqual(nodes[0]?.content?.[0]?.attrs, { ...attrs, linkHref: null });
  const blocks = pmNodesToNoteBlocks(nodes);
  assert.deepEqual(blocks, [{ type: "image", content, imageAssetId: "asset-1" }]);
  assert.equal(noteImageHtmlAttrs(blocks[0]!.content)?.width, 320);
  assert.equal(noteImageHtmlAttrs('<img src="javascript:alert(1)" width="320" />'), null);
  assert.equal(noteImageHtmlAttrs('<img src="/a.png" onerror="evil()" width="320" />')?.src, "/a.png");
  assert.equal(noteImageHtmlAttrs('<div><img src="/a.png" /></div>'), null);
});

test("内嵌剪贴板图片跨共享文档保留，只允许安全的栅格图片 data URI", () => {
  const src = "data:image/png;base64,iVBORw0KGgo=";
  const nodes = noteBlocksToPmNodes([{ type: "image", content: `![图](${src})` }]);
  assert.equal(nodes[0]?.content?.[0]?.attrs?.src, src);
  assert.match(JSON.stringify(noteMarkdownTree(pmNodesToNoteBlocks(nodes)[0]!.content)), /data:image\/png;base64/);
  assert.doesNotMatch(JSON.stringify(noteMarkdownTree('<img src="data:image/svg+xml;base64,PHN2Zz4=" />')), /data:image\/svg/);
});

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
  const literal = pmNodesToNoteBlocks(noteBlocksToPmNodes(markdownToBlocks('\\[\\[字面]] [[微积分]] `[[代码]]`')));
  const restored = noteMarkdownTree(literal[0]!.content);
  assert.equal((JSON.stringify(restored).match(/astella-note-title:/g) ?? []).length, 1);
  assert.equal(noteMarkdownText(restored), '[[字面]] 微积分 [[代码]]');
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
