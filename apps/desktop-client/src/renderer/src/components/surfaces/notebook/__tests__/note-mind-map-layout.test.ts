import { test, expect } from "vitest";
import type { MindMapContentV1 } from "@astella/shared/note-mind-map-contracts";
import { layoutMindMap } from "../note-mind-map-layout";
const map: MindMapContentV1={schemaVersion:1,rootId:"root",nodes:[
{id:"root",parentId:null,kind:"root",label:"中心主题",explanation:null,references:[]},
...Array.from({length:6},(_,i)=>({id:`n${i}`,parentId:"root",kind:"concept" as const,label:"保留条件与因果关系的知识点".repeat(2),explanation:null,references:[{blockOrdinal:i,quote:"依据"}]})),
{id:"deep",parentId:"n0",kind:"concept",label:"下一层",explanation:null,references:[{blockOrdinal:0,quote:"依据"}]}]};
test("branches use both sides without overlapping nodes and folding hides descendants",()=>{
 const result=layoutMindMap(map,new Set());
 expect(result.positions.some(p=>p.x<0)).toBe(true); expect(result.positions.some(p=>p.x>0)).toBe(true);
 for(const a of result.positions) for(const b of result.positions) if(a!==b) expect(Math.abs(a.x-b.x)>=(a.width+b.width)/2||Math.abs(a.y-b.y)>=(a.height+b.height)/2).toBe(true);
 expect(layoutMindMap(map,new Set(["n0"])).positions.some(p=>p.node.id==="deep")).toBe(false);
 expect(layoutMindMap(map,new Set(["root"])).positions.length).toBe(1);
 const folded=layoutMindMap(map,new Set(["n0"]));
 for(const position of folded.positions) expect(position.side).toBe(result.positions.find(p=>p.node.id===position.node.id)?.side);
});
