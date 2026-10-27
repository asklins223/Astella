import assert from "node:assert/strict";
import test from "node:test";
import { isChatObjectKey, isPersistentObjectKey } from "../../../lib/storage/policy.ts";
import { maintainChatUploads, type ChatRetentionTasks } from "../chat-maintenance.ts";

test('chat keys, immutable note media and short-lived export/import payloads have distinct policies', () => {
 for (const key of ['room/companion/photo.png','room/companion-files/user/file.pdf']) {
  assert.equal(isChatObjectKey(key),true); assert.equal(isPersistentObjectKey(key),false);
 }
 for (const key of ['room/notes/note/photo.png','room/sources/source/photo.webp','room/files/user/source.txt','avatars/user/picture.png','room/imports/user/photo.jpg']) {
  assert.equal(isPersistentObjectKey(key),true); assert.equal(isChatObjectKey(key),false);
 }
 for (const key of ['temporary/uploads/room/user/id','room/imports/user/payload.json','room/exports/user/backup.zip','unknown/path']) assert.equal(isPersistentObjectKey(key),false);
});

test('cleanup only acknowledges deletions and promotions after the durable action succeeds', async () => {
 const calls: string[] = [];
 const tasks: ChatRetentionTasks = {
  promoted: async()=>[{ object_key:'retained' }],
  enqueuePromotion: async key=>{ calls.push('queue:'+key); },
  ackPromotion: async key=>{ calls.push('ack:'+key); },
  expired: async()=>[{ object_key:'expired' }],
  remove: async key=>{ calls.push('remove:'+key); throw Error('storage unavailable'); },
  finish: async key=>{ calls.push('finish:'+key); },
 };
 await assert.rejects(maintainChatUploads(tasks),/storage unavailable/);
 assert.deepEqual(calls,['queue:retained','ack:retained','remove:expired']);
 calls.length=0; tasks.promoted=async()=>[];
 tasks.remove=async key=>{calls.push('remove:'+key);};
 await maintainChatUploads(tasks);
 assert.deepEqual(calls,['remove:expired','finish:expired']);
});
