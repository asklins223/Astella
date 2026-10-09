import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { Hocuspocus } from "@hocuspocus/server";
import { disconnectAndVerifyNoteDocSave, noteDocSnapshotIsPersisted, NoteDocSaveUnconfirmedError } from "../note-doc-save-confirmation.ts";

test("保存核对包含删除和处理标记，不能只检查相同的状态向量", () => {
  const before = new Y.Doc(), edited = new Y.Doc();
  before.getText("body").insert(0, "保留和删除");
  const original = Y.encodeStateAsUpdate(before);
  Y.applyUpdate(edited, original);
  edited.getText("body").delete(2, 3);
  const deletion = Y.encodeStateAsUpdate(edited);
  assert.deepEqual(Y.encodeStateVector(before), Y.encodeStateVector(edited));
  assert.equal(noteDocSnapshotIsPersisted(deletion, original), false);
  edited.getMap("meta").set("companion-edit:call-1", true);
  assert.equal(noteDocSnapshotIsPersisted(Y.encodeStateAsUpdate(edited), deletion), false);
  assert.equal(noteDocSnapshotIsPersisted(Y.encodeStateAsUpdate(edited), Y.encodeStateAsUpdate(edited)), true);
  assert.equal(noteDocSnapshotIsPersisted(deletion, undefined), false);
  before.destroy(); edited.destroy();
});

test("落盘含后续并行输入时仍确认成功，不要求快照字节完全相同", () => {
  const submitted = new Y.Doc(), stored = new Y.Doc();
  submitted.getText("body").insert(0, "修改完成");
  const expected = Y.encodeStateAsUpdate(submitted);
  Y.applyUpdate(stored, expected);
  stored.getText("body").insert(4, "其他段落的新输入");
  assert.equal(noteDocSnapshotIsPersisted(expected, Y.encodeStateAsUpdate(stored)), true);
  submitted.destroy(); stored.destroy();
});

test("真实 Hocuspocus 吞掉 store 异常时不得发出保存成功回执", async () => {
  const seed = new Y.Doc(); seed.getText("body").insert(0, "原文");
  const stored = Y.encodeStateAsUpdate(seed);
  const server = new Hocuspocus({ debounce: 0, onLoadDocument: async ({ document }) => { Y.applyUpdate(document, stored); },
    onStoreDocument: async () => { throw new Error("synthetic_store_failure"); } });
  try {
    const connection = await server.openDirectConnection("note:save-test", {});
    await connection.transact(doc => { doc.getText("body").insert(2, "新内容"); });
    await assert.rejects(disconnectAndVerifyNoteDocSave(connection, async () => stored), NoteDocSaveUnconfirmedError);
  } finally {
    server.closeConnections();
    await Promise.all([...server.documents.values()].map(doc => server.unloadDocument(doc)));
    seed.destroy();
  }
});

test("实际保存路径成功后才读取并核对回执", async () => {
  const doc = new Y.Doc(); doc.getText("body").insert(0, "完整保存");
  let stored: Uint8Array | undefined;
  const connection = { document: doc, disconnect: async () => { stored = Y.encodeStateAsUpdate(doc); } };
  await disconnectAndVerifyNoteDocSave(connection, async () => stored);
  doc.destroy();
});
