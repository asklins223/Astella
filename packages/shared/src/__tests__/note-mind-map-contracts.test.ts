import { test } from "node:test";
import assert from "node:assert/strict";
import { mindMapContentV1Schema, type MindMapContentV1 } from "../contracts/note/note-mind-map-contracts.ts";
const valid: MindMapContentV1 = {schemaVersion:1,rootId:"root",nodes:[
  {id:"root",parentId:null,kind:"root",label:"电功率",explanation:null,references:[]},
  {id:"a",parentId:"root",kind:"concept",label:"固定电压",explanation:"P=U²/R",references:[{blockOrdinal:1,quote:"固定电压"}]}]};
test("requires one rooted acyclic tree with evidence, but no node, depth or citation quota", () => {
  assert.ok(mindMapContentV1Schema.safeParse(valid).success);
  for (const nodes of [
    [...valid.nodes, {...valid.nodes[1]!,id:"a"}],
    valid.nodes.map(n=>n.id==="a"?{...n,parentId:"missing"}:n),
    valid.nodes.map(n=>n.id==="a"?{...n,parentId:"a"}:n),
    valid.nodes.map(n=>n.id==="a"?{...n,references:[]}:n),
    [...valid.nodes,{...valid.nodes[0]!,id:"second"}],
    [...valid.nodes,{...valid.nodes[1]!,id:"empty",kind:"group",explanation:null,references:[]}],
  ]) assert.equal(mindMapContentV1Schema.safeParse({...valid,nodes}).success,false);
  // 层数与每节点依据条数都不再设上限（2026-10-12）：一张 40 节点的图、一个挂了 7 条原文
  // 依据的节点，以前会让**整张图**判无效重跑一遍，而不是少一个节点或少一条依据。
  // 这两条钉的是"上限已经没了"，谁要加回来得先说清它从哪一份声明来。
  const chain = Array.from({length:40},(_,i)=>({...valid.nodes[1]!,id:`n${i}`,parentId:i?`n${i-1}`:"root"}));
  assert.ok(mindMapContentV1Schema.safeParse({...valid,nodes:[valid.nodes[0],...chain]}).success);
  const manyRefs = Array.from({length:7},(_,i)=>({blockOrdinal:i,quote:`第${i}段`}));
  assert.ok(mindMapContentV1Schema.safeParse({...valid,
    nodes:[valid.nodes[0]!,{...valid.nodes[1]!,references:manyRefs}]}).success);
});
