import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import type { ChatMessage, ChatOptions } from "@astella/shared";
import type { MindMapContentV1 } from "@astella/shared/note-mind-map-contracts";
import { MockProvider } from "../lib/providers/mock.ts";
import { runNoteMindMapGenerate } from "../handlers/note-mind-map-generate.ts";
import { closeDatabase as closeWorker } from "../db.ts";
import { closeDatabase as closeApi, withWorkspaceTransaction } from "../../../../apps/api/src/db/client.ts";
import { startNoteMindMapTask, getNoteMindMapTask, getNoteMindMapSource, listNoteMindMaps } from "../../../../apps/api/src/modules/note-mind-maps/service.ts";
import { agentStore } from "../../../../apps/api/src/agent/runtime.ts";
import { readOperationResultReceipt } from "@astella/agent-host";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });
testDatabaseUrl("DATABASE_URL_API"); testDatabaseUrl("DATABASE_URL_WORKER");
const userId=randomUUID(), workspaceId=randomUUID(), memberId=randomUUID(), otherWorkspaceId=randomUUID();
const scope={userId,workspaceId};
before(async()=>{
 await admin.begin(async tx=>{
  for(const id of [userId,memberId]) await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${id},${`mindmap-${id}@test.invalid`},'fixture','owner')`;
  for(const id of [workspaceId,otherWorkspaceId]) { await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${id},'mind map fixture',${userId})`; await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${id},${userId},'owner')`; }
  await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${memberId},'member')`;
  await tx`INSERT INTO user_ai_settings(user_id,consent_at,consent_version,data_policy) VALUES(${userId},now(),'test-fixture','{"sendToExternal":true,"piiDetection":true,"auditLogging":true}')`;
 });
});
after(async()=>{
 try { await admin.begin(async tx=>{
  await tx`SET LOCAL app.allow_history_mutation='on'`;
  await tx`DELETE FROM agent_runs WHERE workspace_id IN (${workspaceId},${otherWorkspaceId})`;
  await tx`DELETE FROM note_mind_maps WHERE workspace_id=${workspaceId}`;
  await tx`DELETE FROM jobs WHERE workspace_id IN (${workspaceId},${otherWorkspaceId})`;
  await tx`UPDATE notes SET current_version_id=NULL WHERE workspace_id=${workspaceId}`;
  await tx`DELETE FROM note_blocks WHERE workspace_id=${workspaceId}`;
  await tx`DELETE FROM note_versions WHERE workspace_id=${workspaceId}`;
  await tx`DELETE FROM notes WHERE workspace_id=${workspaceId}`;
  await tx`DELETE FROM workspaces WHERE id IN (${workspaceId},${otherWorkspaceId})`;
  await tx`DELETE FROM users WHERE id IN (${userId},${memberId})`;
 }); } finally { await Promise.all([admin.end(),closeWorker(),closeApi()]); }
});
async function note(content:string[]) {
 const noteId=randomUUID(),noteVersionId=randomUUID();
 await admin.begin(async tx=>{
  await tx`INSERT INTO notes(id,workspace_id,title,created_by,share_scope) VALUES(${noteId},${workspaceId},'功率和约束条件',${userId},'shared')`;
  await tx`INSERT INTO note_versions(id,note_id,workspace_id,version_no,content_json,created_by,content_hash) VALUES(${noteVersionId},${noteId},${workspaceId},1,'{}',${userId},${createHash('sha256').update(content.join('\n')).digest('hex')})`;
  for(const [ordinal,text] of content.entries()) await tx`INSERT INTO note_blocks(version_id,workspace_id,ordinal,type,content) VALUES(${noteVersionId},${workspaceId},${ordinal},'paragraph',${text})`;
  await tx`UPDATE notes SET current_version_id=${noteVersionId} WHERE id=${noteId}`;
 }); return {noteId,noteVersionId};
}
async function lease(taskId:string) {
 const leaseToken=randomUUID();const [row]=await admin`UPDATE jobs SET status='running',started_at=now(),lease_token=${leaseToken} WHERE id=${taskId} RETURNING payload`;
 return {id:taskId,workspaceId,requestedBy:userId,leaseToken,payload:row!.payload};
}
function providerFactory(options:{failPartTwo?:boolean}={}) {
 const state={calls:0,fail:options.failPartTwo ? 2 : 0};
 return {state,create:()=>{
  const provider=new MockProvider();
  provider.chatCompletion=async(messages:ChatMessage[],_options:ChatOptions)=>{
   ++state.calls;const prompt=String(messages.find(m=>m.role==='user')!.content);
   if(state.fail&&prompt.includes('第2/')) {--state.fail;throw new Error('simulated transport interruption');}
   let map:MindMapContentV1;
   if(prompt.startsWith('将以下各段脑图')) {
    const parts=JSON.parse(prompt.split('\n\n').at(-1)!) as MindMapContentV1[];
    map={schemaVersion:1,rootId:'root',nodes:[{id:'root',parentId:null,kind:'root',label:'功率与约束',explanation:null,references:[]},...parts.flatMap(p=>p.nodes.filter(n=>n.kind==='concept').map(n=>({...n,parentId:'root'})))]};
   } else {
    const lines=[...prompt.matchAll(/\[原文段落 (\d+)\]\n([\s\S]*?)(?=\n\n\[原文段落|$)/gu)];
    map={schemaVersion:1,rootId:'root',nodes:[{id:'root',parentId:null,kind:'root',label:'功率与约束',explanation:null,references:[]},...lines.map((line,i)=>({id:`n${i}`,parentId:'root',kind:'concept' as const,label:Array.from(line[2]!).slice(0,12).join(''),explanation:null,references:[{blockOrdinal:Number(line[1]),quote:Array.from(line[2]!).slice(0,40).join('')}]}))]};
   }
   return {content:JSON.stringify(map),usage:{promptTokens:100,completionTokens:100}};
  };return provider;
 }};
}
test('independent generation saves once, publishes a real Agent artifact and reads an exact old snapshot',async()=>{
 const n=await note(['固定电压时，功率 P=U²/R，电阻越小功率越大。','固定电流时，功率 P=I²R，电阻越大功率越大。','![图片](image.png)']);
 const task=await startNoteMindMapTask(scope,n.noteId,{noteVersionId:n.noteVersionId,requestId:randomUUID()});assert.ok(task.agentRunId);
 const job=await lease(task.taskId), factory=providerFactory();
 await runNoteMindMapGenerate(job,factory.create); await runNoteMindMapGenerate(job,factory.create); assert.equal(factory.state.calls,1);
 await admin`UPDATE jobs SET status='succeeded',finished_at=now() WHERE id=${task.taskId}`;
 const result=await withWorkspaceTransaction(scope,tx=>getNoteMindMapTask(tx,scope,n.noteId,task.taskId));assert.equal(result.status,'ready');assert.ok(result.mindMap);assert.equal(result.mindMap.coverage.imageBlocksNotRead,1);
 const run=await agentStore.get(scope,task.agentRunId!);
 const receipt=await withWorkspaceTransaction(scope,tx=>readOperationResultReceipt(tx,{scope,capability:'note_mind_map_generate',execution:{kind:'job',id:task.taskId},inputs:run.inputs}));
 assert.equal(receipt.kind,'result'); assert.ok(receipt.kind==='result'&&receipt.result.kind==='artifact'&&receipt.result.artifact.kind==='note_mind_map');
 assert.equal((await withWorkspaceTransaction(scope,tx=>listNoteMindMaps(tx,scope,n.noteId))).items.length,1);
 const newer=randomUUID();await admin`INSERT INTO note_versions(id,note_id,workspace_id,version_no,content_json,created_by,content_hash) VALUES(${newer},${n.noteId},${workspaceId},2,'{}',${userId},'changed')`;
 await admin`UPDATE notes SET current_version_id=${newer},title='改写后的笔记' WHERE id=${n.noteId}`;
 const old=await withWorkspaceTransaction(scope,tx=>getNoteMindMapSource(tx,scope,n.noteId,result.mindMap!.mindMapId));assert.equal(old.noteVersionId,n.noteVersionId);assert.equal(old.title,'功率和约束条件');assert.ok(old.blocks[0]!.content.includes('固定电压'));
 const [live]=await admin`SELECT current_version_id FROM notes WHERE id=${n.noteId}`;assert.equal(live!.current_version_id,newer);
 const member={workspaceId,userId:memberId};assert.equal((await withWorkspaceTransaction(member,tx=>listNoteMindMaps(tx,member,n.noteId))).items.length,0);
 await assert.rejects(withWorkspaceTransaction(member,tx=>getNoteMindMapSource(tx,member,n.noteId,result.mindMap!.mindMapId)));
 await assert.rejects(withWorkspaceTransaction({...scope,workspaceId:otherWorkspaceId},tx=>getNoteMindMapSource(tx,{...scope,workspaceId:otherWorkspaceId},n.noteId,result.mindMap!.mindMapId)));
 await admin`UPDATE notes SET deleted_at=now() WHERE id=${n.noteId}`;
 await assert.rejects(withWorkspaceTransaction(scope,tx=>getNoteMindMapSource(tx,scope,n.noteId,result.mindMap!.mindMapId)));
});
test('long note resumes completed chunks and merges without dropping the end of the note',async()=>{
 const n=await note(['固定电压功率与电阻成反比。'.repeat(1400),'固定电流功率与电阻成正比。'.repeat(1400),'最后一段明确电源内阻不可忽略时固定电压前提失效。']);
 const task=await startNoteMindMapTask(scope,n.noteId,{noteVersionId:n.noteVersionId,requestId:randomUUID()}),job=await lease(task.taskId),factory=providerFactory({failPartTwo:true});
 await assert.rejects(runNoteMindMapGenerate(job,factory.create),/simulated transport/);
 const [before]=await admin`SELECT count(*)::int n FROM note_mind_map_stages WHERE job_id=${task.taskId}`;assert.equal(before!.n,1);
 await runNoteMindMapGenerate(job,factory.create);
 const [saved]=await admin`SELECT content,coverage FROM note_mind_maps WHERE generation_job_id=${task.taskId}`;
 assert.deepEqual(saved!.coverage.textBlockOrdinals,[0,1,2]);assert.ok(saved!.content.nodes.some((node:{references:{blockOrdinal:number}[]})=>node.references.some(ref=>ref.blockOrdinal===2)));
 const [stages]=await admin`SELECT count(*)::int n FROM note_mind_map_stages WHERE job_id=${task.taskId}`; assert.equal(factory.state.calls,stages!.n+2,'completed chunks are reused after the interrupted call');
});
