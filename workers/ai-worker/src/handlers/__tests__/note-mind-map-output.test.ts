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
