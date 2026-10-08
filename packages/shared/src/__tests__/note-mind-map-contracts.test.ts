import { test } from "node:test";
import assert from "node:assert/strict";
import { mindMapContentV1Schema, type MindMapContentV1 } from "../contracts/note-mind-map-contracts.ts";
const valid: MindMapContentV1 = {schemaVersion:1,rootId:"root",nodes:[
  {id:"root",parentId:null,kind:"root",label:"电功率",explanation:null,references:[]},
  {id:"a",parentId:"root",kind:"concept",label:"固定电压",explanation:"P=U²/R",references:[{blockOrdinal:1,quote:"固定电压"}]}]};
test("requires one rooted acyclic tree, evidence and finite depth", () => {
  assert.ok(mindMapContentV1Schema.safeParse(valid).success);
  for (const nodes of [
    [...valid.nodes, {...valid.nodes[1]!,id:"a"}],
    valid.nodes.map(n=>n.id==="a"?{...n,parentId:"missing"}:n),
    valid.nodes.map(n=>n.id==="a"?{...n,parentId:"a"}:n),
    valid.nodes.map(n=>n.id==="a"?{...n,references:[]}:n),
    [...valid.nodes,{...valid.nodes[0]!,id:"second"}],
    [...valid.nodes,{...valid.nodes[1]!,id:"empty",kind:"group",explanation:null,references:[]}],
  ]) assert.equal(mindMapContentV1Schema.safeParse({...valid,nodes}).success,false);
  const chain = Array.from({length:7},(_,i)=>({...valid.nodes[1]!,id:`n${i}`,parentId:i?`n${i-1}`:"root"}));
  assert.equal(mindMapContentV1Schema.safeParse({...valid,nodes:[valid.nodes[0],...chain]}).success,false);
});
