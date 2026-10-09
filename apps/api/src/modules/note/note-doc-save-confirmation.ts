import * as Y from "yjs";

export class NoteDocSaveUnconfirmedError extends Error {
  constructor() {
    super("note_doc_save_unconfirmed");
    this.name = "NoteDocSaveUnconfirmedError";
  }
}

/** A persisted CRDT may include later edits, but must include every submitted change and deletion. */
export function noteDocSnapshotIsPersisted(expected: Uint8Array, stored: Uint8Array | undefined): boolean {
  if (!stored) return false;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, stored);
    const before = Y.encodeStateAsUpdate(doc);
    Y.applyUpdate(doc, expected);
    return doc.store.pendingStructs === null && doc.store.pendingDs === null
      && Buffer.compare(Buffer.from(before), Buffer.from(Y.encodeStateAsUpdate(doc))) === 0;
  } finally { doc.destroy(); }
}

/** Hocuspocus swallows store-hook errors. Disconnect alone is never a durable receipt. */
export async function disconnectAndVerifyNoteDocSave(
  connection: { document: Y.Doc | null; disconnect(): Promise<void> },
  loadStoredState: () => Promise<Uint8Array | undefined>,
): Promise<void> {
  const expected = connection.document ? Y.encodeStateAsUpdate(connection.document) : undefined;
  await connection.disconnect();
  if (!expected || !noteDocSnapshotIsPersisted(expected, await loadStoredState())) {
    throw new NoteDocSaveUnconfirmedError();
  }
}
