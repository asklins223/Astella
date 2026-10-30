import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { acquireRewriteLock, assertUnlockedUpdate, releaseRewriteLock, activeRewriteLocks, NoteEditLockedError } from '../edit-locks.ts';
function base(){const doc=new Y.Doc();const fragment=doc.getXmlFragment('content');for(const value of ['第一段','第二段','第三段']){const node=new Y.XmlElement('paragraph'),text=new Y.XmlText();text.insert(0,value);node.insert(0,[text]);fragment.push([node]);}return doc;}
function delta(doc:Y.Doc,change:(next:Y.Doc)=>void){const next=new Y.Doc();Y.applyUpdate(next,Y.encodeStateAsUpdate(doc));const vector=Y.encodeStateVector(next);change(next);const update=Y.encodeStateAsUpdate(next,vector);next.destroy();return update;}
function locked(doc:Y.Doc){const noteId=randomUUID(),id=randomUUID(),userId=randomUUID();const lock=acquireRewriteLock({noteId,id,userId,workspaceId:randomUUID(),startBlock:1,endBlock:1},doc);return {noteId,id,userId,lock};}
test('server rejects text, style, and deletion changes to a locked paragraph',()=>{
 const doc=base(),held=locked(doc);
 for(const change of [
  (next:Y.Doc)=>((next.getXmlFragment('content').get(1) as Y.XmlElement).get(0) as Y.XmlText).insert(0,'冲突'),
  (next:Y.Doc)=>next.getXmlFragment('content').get(1).setAttribute('noteStyle',{textAlign:'center'}),
  (next:Y.Doc)=>next.getXmlFragment('content').delete(1,1),
 ])assert.throws(()=>assertUnlockedUpdate(held.noteId,doc,delta(doc,change)),NoteEditLockedError);
 releaseRewriteLock(held.noteId,held.id,held.userId);doc.destroy();
});
test('editing another paragraph and inserting above the lock remain allowed',()=>{
 const doc=base(),held=locked(doc);
 const update=delta(doc,next=>{const fragment=next.getXmlFragment('content');const node=new Y.XmlElement('paragraph'),text=new Y.XmlText();text.insert(0,'新段');node.push([text]);fragment.insert(0,[node]);((fragment.get(1) as Y.XmlElement).get(0) as Y.XmlText).insert(0,'可编辑');});
 assert.doesNotThrow(()=>assertUnlockedUpdate(held.noteId,doc,update));Y.applyUpdate(doc,update);
 assert.throws(()=>assertUnlockedUpdate(held.noteId,doc,delta(doc,next=>((next.getXmlFragment('content').get(2) as Y.XmlElement).get(0) as Y.XmlText).insert(0,'仍锁住'))),NoteEditLockedError);
 releaseRewriteLock(held.noteId,held.id,held.userId);doc.destroy();
});
test('conflicting requests are refused and only the lock owner can release',()=>{
 const doc=base(),held=locked(doc);
 assert.throws(()=>acquireRewriteLock({noteId:held.noteId,id:randomUUID(),userId:randomUUID(),workspaceId:held.lock.workspaceId,startBlock:1,endBlock:1},doc),NoteEditLockedError);
 releaseRewriteLock(held.noteId,held.id,randomUUID());assert.equal(activeRewriteLocks(held.noteId).length,1);
 releaseRewriteLock(held.noteId,held.id,held.userId);assert.equal(activeRewriteLocks(held.noteId).length,0);
 assert.doesNotThrow(()=>assertUnlockedUpdate(held.noteId,doc,delta(doc,next=>((next.getXmlFragment('content').get(1) as Y.XmlElement).get(0) as Y.XmlText).insert(0,'解锁后'))));doc.destroy();
});
test('an unbound failed submission expires without leaving a permanent paragraph lock',()=>{
 const doc=base(),held=locked(doc);held.lock.expiresAt=Date.now()-1;assert.equal(activeRewriteLocks(held.noteId).length,0);doc.destroy();
});
