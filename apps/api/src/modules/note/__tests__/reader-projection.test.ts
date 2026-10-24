import assert from "node:assert/strict";
import test from "node:test";
import { projectReaderBlock } from "../reader-projection.ts";
import { readNoteAnchorTextV1 } from "@astella/shared/note-annotation-contracts";

test("reader HTML is the canonical sanitized tree and cannot include active source markup", () => {
  const block = {ordinal:0,type:"paragraph",content:'<script>alert(1)</script><p onclick="alert(1)">正文 <a href="javascript:alert(2)">链接</a><img src="/uploads/a.png" onerror="alert(3)"></p>'};
  const output = projectReaderBlock(block);
  assert.doesNotMatch(output.renderedHTML,/<script|onclick|onerror|javascript:/i);
  assert.match(output.renderedHTML,/正文/);
});

test("image representations retain resource identity without introducing annotation characters", () => {
  for (const content of [JSON.stringify({url:"/uploads/a%20b.png",alt:"原图"}), "![原图](/uploads/a%20b.png)", "/uploads/a%20b.png"]) {
    const value = projectReaderBlock({type:"image",content});
    assert.match(value.renderedHTML,/img/); assert.match(value.renderedHTML,/\/uploads\/a%20b.png/);
    assert.equal(value.renderedText,"");
  }
});

test("math decorations retain exact shared text coordinates for native selections", () => {
  const blocks = [{ordinal:5,type:"paragraph",content:"给定 $x^2$，选择公式之后的内容。"}];
  const output = projectReaderBlock(blocks[0]!);
  assert.match(output.renderedHTML,/data-note-math="x\^2"/);
  assert.equal(output.renderedText,readNoteAnchorTextV1(blocks,{startBlockOrdinal:5,startOffset:0,endBlockOrdinal:5,endOffset:output.renderedText.length})?.excerpt);
});
