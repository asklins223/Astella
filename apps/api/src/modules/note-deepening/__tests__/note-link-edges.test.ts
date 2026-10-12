/**
 * 笔记正文里的库内链接要变成星图上的 `references` 边（note → note）。
 *
 * 钉住四件事：
 *  1. **正文写了链接就有线**——这是「引用了却看不见」的那一件。三种写法（插入链接时
 *     写的 `astella-note:<id>`、`[[标题]]`、`xxx.md`）都得认，因为它们在阅读视图里
 *     都会变成点得动的链接。
 *  2. **认不出唯一一篇就不画**。同名多篇、目标读不到、指向自己——画出来是一条点开报错
 *     或压根打不开的线，比缺一条线更糟。
 *  3. **代码里的不是链接**：阅读视图里 `noteWikiLinks` 就不展开代码块与行内代码，星图
 *     跟着同一份解析，所以也不该长出边来。
 *  4. **不是本人可表态的那一类**：他写下的引用是事实，没有「我不这么认为」这一档，
 *     `decidable=false`（星图上是实线，不是待确认的虚线）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NOTE_LINK_RAW_HINTS,
  buildNoteReferenceEdgesV3,
} from "../note-link-edges.ts";
import { understandingEdgeProjectionV3Schema } from "@astella/shared/note-deepening-contracts";

const NOTE_CALCULUS = "11111111-1111-4111-8111-111111111111";
const NOTE_ALGEBRA = "22222222-2222-4222-8222-222222222222";
const NOTE_PROBABILITY = "33333333-3333-4333-8333-333333333333";
const NOTE_DUP_LEFT = "44444444-4444-4444-8444-444444444444";
const NOTE_DUP_RIGHT = "55555555-5555-4555-8555-555555555555";

const notes = [
  { id: NOTE_CALCULUS, title: "微积分" },
  { id: NOTE_ALGEBRA, title: "线性代数" },
  { id: NOTE_PROBABILITY, title: "概率论" },
  { id: NOTE_DUP_LEFT, title: "重名笔记" },
  { id: NOTE_DUP_RIGHT, title: "重名笔记" },
];

const edgesFor = (...blocks: Array<{ noteId: string; blockType?: string; content: string }>) =>
  buildNoteReferenceEdgesV3({
    blocks: blocks.map(block => ({
      noteId: block.noteId,
      blockType: block.blockType ?? "paragraph",
      content: block.content,
    })),
    notes,
  });

test("正文里的三种库内链接都连成一条边，且过得了合同", () => {
  const edges = edgesFor(
    { noteId: NOTE_CALCULUS, content: `[线代](astella-note:${NOTE_ALGEBRA})` },
    { noteId: NOTE_ALGEBRA, content: "前面说过 [[概率论]]，这里接着用。" },
    { noteId: NOTE_PROBABILITY, content: "[补充](folder/微积分.md)" },
    { noteId: NOTE_DUP_LEFT, content: `<a href="astella-note:${NOTE_ALGEBRA}">线代</a>` },
  );
  understandingEdgeProjectionV3Schema.array().parse(edges);

  assert.deepEqual(edges.map(edge => [edge.from.id, edge.to.id, edge.reasonCodes[0]]).sort(), [
    [NOTE_CALCULUS, NOTE_ALGEBRA, "link_id"],
    [NOTE_ALGEBRA, NOTE_PROBABILITY, "link_title"],
    [NOTE_DUP_LEFT, NOTE_ALGEBRA, "link_id"],
    [NOTE_PROBABILITY, NOTE_CALCULUS, "link_title"],
  ].sort());
  assert.equal(edges[0]!.kind, "references");
  assert.equal(edges[0]!.from.kind, "note");
  assert.equal(edges[0]!.to.kind, "note");
});

test("认不出唯一一篇就不画：读不到的 id、同名多篇、指向自己", () => {
  assert.deepEqual(edgesFor(
    { noteId: NOTE_CALCULUS, content: `[不存在](astella-note:${"00000000-0000-4000-8000-000000000000"})` },
    { noteId: NOTE_CALCULUS, content: "[[重名笔记]]" },
    { noteId: NOTE_CALCULUS, content: `[自己](astella-note:${NOTE_CALCULUS})` },
  ), []);
});

test("代码里的 `[[…]]` 不是链接：整块代码与行内代码都不算", () => {
  assert.deepEqual(edgesFor(
    { noteId: NOTE_CALCULUS, blockType: "code", content: "[[微积分]]" },
    { noteId: NOTE_CALCULUS, content: "配置写成 `[[概率论]]` 这样就行。" },
  ), []);
});

test("同一对笔记反复出现只算一条边", () => {
  const edges = edgesFor(
    { noteId: NOTE_CALCULUS, content: `[一篇](astella-note:${NOTE_ALGEBRA})` },
    { noteId: NOTE_CALCULUS, content: "再看 [[线性代数]] 与 [[线性代数]]。" },
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.edgeId, `ref-${NOTE_CALCULUS}-${NOTE_ALGEBRA}`);
});

test("引用是事实，不是待确认的建议", () => {
  const edges = edgesFor(
    { noteId: NOTE_CALCULUS, content: `[线代](astella-note:${NOTE_ALGEBRA})` },
    { noteId: NOTE_ALGEBRA, content: "[[概率论]]" },
  );
  assert.equal(edges.length, 2);
  for (const edge of edges) {
    assert.equal(edge.decidable, false, "正文写了的链接没有「我不这么认为」这一档");
  }
});

test("库里的粗筛是判定口径的超集：漏一样就是星图上少一条线", () => {
  for (const sample of [
    `[线代](astella-note:${NOTE_ALGEBRA})`,
    "[[概率论]]",
    "[补充](folder/微积分.md)",
    // 伴星写入门用的 HTML 形状（`companion-note-authoring.ts` 的同一条校验）
    `<a href="astella-note:${NOTE_ALGEBRA}">线代</a>`,
  ]) {
    assert.ok(
      NOTE_LINK_RAW_HINTS.some(hint => sample.includes(hint)),
      `这块正文写了链接，粗筛却会把它留在库里：${sample}`,
    );
  }
});
