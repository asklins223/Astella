import { test } from "node:test";
import assert from "node:assert/strict";
import type { MindMapContentV1 } from "@astella/shared/note-mind-map-contracts";
import { parseMindMap, reconcileMergedMindMap } from "../note-mind-map-output.ts";
import { buildChunks, exactQuote, imageSafeText } from "../note-mind-map-source.ts";
const map: MindMapContentV1 = { schemaVersion:1,rootId:"root",nodes:[
  {id:"root",parentId:null,kind:"root",label:"功率",explanation:null,references:[]},
  {id:"c0_a",parentId:"root",kind:"concept",label:"固定电压",explanation:"保持电压不变才能使用这个比较。",references:[{blockOrdinal:1,quote:"固定电压"}]}] };
test("evidence is normalized back to source; invented or image evidence is rejected", () => {
  assert.equal(exactQuote("**固定电压**，P=U²/R", "固定 电压"), "固定电压");
  assert.equal(exactQuote("😀电阻", "😀"), "😀");
  assert.equal(parseMindMap(JSON.stringify(map),[{ordinal:1,type:"text",content:"固定电压"}]).nodes[1]!.references[0]!.quote,"固定电压");
  for (const content of ["不存在该引用", "![固定电压](image.png)", '<img alt="固定电压" src="image.png">']) assert.throws(()=>parseMindMap(JSON.stringify(map),[{ordinal:1,type:"text",content}]));
  assert.throws(()=>parseMindMap(JSON.stringify(map),[{ordinal:1,type:"image",content:"固定电压"}]));
});
test("chunks cover Unicode source without truncation, retain ordinal and omit image text", () => {
  const text="电😀阻".repeat(7000); const chunks=buildChunks([{ordinal:4,type:"text",content:text}],16000);
  assert.equal(chunks.flatMap(c=>c.lines.map(l=>l.text)).join(""),text);
  assert.ok(chunks.every(c=>c.ordinals.has(4)));
  assert.equal(imageSafeText('文字<img src="x">![alt](y)').imageCount,2);
  assert.equal(imageSafeText('![alt](y)').text,"");
});
test("merge preserves every concept and its frozen evidence, even if the model rewrites facts", () => {
  const edited={...map,nodes:map.nodes.map(n=>n.kind==="concept"?{...n,label:"错误改写",explanation:"伪造",references:[{blockOrdinal:9,quote:"伪造"}]}:n)};
  assert.deepEqual(reconcileMergedMindMap(edited,[map]).nodes[1],map.nodes[1]);
  assert.throws(()=>reconcileMergedMindMap({...map,nodes:[map.nodes[0]!]},[map]));
});
test("节点名、解释与引用都不再按固定字数拒收：写长一点不该让整张图判无效", () => {
  const source = "把复习安排在快要忘记的时候，比反复重读同一段材料更有效。间隔越长，回忆越费力，记住的也越牢。";
  const longLabel = "复习该安排在快要忘记的时候而不是反复重读".repeat(3);
  const longExplanation = "读者需要知道的是复习时机比复习次数更关键。".repeat(30);
  assert.ok(longLabel.length > 48 && longExplanation.length > 600, "用例必须真的越过原来那两道闸");
  const wide = { ...map, nodes: map.nodes.map(n => n.kind === "concept"
    ? { ...n, label: longLabel, explanation: longExplanation, references: [{ blockOrdinal: 1, quote: source }] }
    : n) };
  const parsed = parseMindMap(JSON.stringify(wide), [{ ordinal: 1, type: "text", content: source }]);
  assert.equal(parsed.nodes[1]!.label, longLabel, "长名字原样留下");
  assert.equal(parsed.nodes[1]!.explanation, longExplanation);
  assert.equal(parsed.nodes[1]!.references[0]!.quote, source, "整段引用照留，读者才回得到原文");
});
test("校验失败要说清是哪一处：重试提示得靠它指出该改哪里", () => {
  // 引用核不回原文：点名是哪个节点、哪一段、哪一句
  assert.throws(
    () => parseMindMap(JSON.stringify(map), [{ ordinal: 1, type: "text", content: "完全对不上的另一段话" }]),
    /节点 c0_a 引用第 1 段的/,
  );
  // 结构问题：带上 zod 的第一条问题，而不是一句"未通过校验"
  assert.throws(
    () => parseMindMap(JSON.stringify({ ...map, rootId: "missing" }), []),
    /脑图结构不完整或缺少原文依据：脑图必须只有一个主题根节点/,
  );
});
