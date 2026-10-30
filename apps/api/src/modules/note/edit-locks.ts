import * as Y from "yjs";
import { and, eq, inArray } from "drizzle-orm";
import { DomainError } from "@astella/shared";
import { companionTurnRuns } from "@astella/shared/db-schema/companion-conversations";
import { noteDocumentStates } from "@astella/shared/db-schema/note";
import { withWorkspaceTransaction } from "../../db/client.ts";

// Relative positions keep the same paragraphs protected when text is inserted
// above them. Persisted locks are rehydrated before accepting any manual write.
type LockedItem = { position: Y.RelativePosition; source: string };
export type RewriteLock = {
  id: string; noteId: string; workspaceId: string; userId: string;
  startBlock: number; endBlock: number; runId: string | null; expiresAt: number;
  items: LockedItem[];
};
const locks = new Map<string, RewriteLock>();
const hydrated = new Map<string, Promise<void>>();
const writes = new Map<string, Promise<void>>();
type StoredRewriteLock = Omit<RewriteLock, "items"> & { items: { position: string; source: string }[] };

async function hydrateRewriteLocks(workspaceId: string, noteId: string, userId: string) {
  let pending = hydrated.get(noteId);
  if (!pending) {
    pending = withWorkspaceTransaction({ workspaceId, userId }, async tx => {
      const stored = await tx.query.noteDocumentStates.findFirst({
        where: and(eq(noteDocumentStates.noteId, noteId), eq(noteDocumentStates.workspaceId, workspaceId)),
        columns: { rewriteLocks: true },
      });
      for (const value of (stored?.rewriteLocks ?? []) as StoredRewriteLock[]) {
        if (value.noteId !== noteId || value.workspaceId !== workspaceId) throw new Error("Invalid persisted note lock scope");
        const lock: RewriteLock = { ...value, items: value.items.map(item => ({
          source: item.source, position: Y.decodeRelativePosition(Buffer.from(item.position, "base64")),
        })) };
        locks.set(noteId + ":" + lock.id, lock);
      }
    }).catch(error => { hydrated.delete(noteId); throw error; });
    hydrated.set(noteId, pending);
  }
  await pending;
}

export async function persistRewriteLocks(workspaceId: string, noteId: string, userId: string) {
  // Serialize writes per document, taking the snapshot when the queued write
  // starts so an older request cannot overwrite a newer lock state.
  const previous = writes.get(noteId) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const stored: StoredRewriteLock[] = activeRewriteLocks(noteId).map(lock => ({ ...lock,
      items: lock.items.map(item => ({ source: item.source, position: Buffer.from(Y.encodeRelativePosition(item.position)).toString("base64") })),
    }));
    await withWorkspaceTransaction({ workspaceId, userId }, tx => tx.update(noteDocumentStates)
      .set({ rewriteLocks: stored }).where(and(eq(noteDocumentStates.noteId, noteId), eq(noteDocumentStates.workspaceId, workspaceId))));
  });
  writes.set(noteId, pending);
  try { await pending; } finally { if (writes.get(noteId) === pending) writes.delete(noteId); }
}
const terminal = new Set(["succeeded", "failed", "cancelled", "superseded", "stopped", "completed"]);
export class NoteEditLockedError extends DomainError {
  constructor() {
    super({ name: "NoteEditLockedError", code: "note_range_locked", statusCode: 423,
      message: "这段正文正在由伴星改写，完成后即可继续编辑。其他段落仍可编辑。" });
  }
}
/** The requested range no longer exists in the current document. */
export class NoteRangeStaleError extends DomainError {
  constructor() {
    super({ name: "NoteRangeStaleError", code: "note_range_stale", statusCode: 409,
      message: "原文位置已变化，请重新选择。" });
  }
}
export function activeRewriteLocks(noteId: string): RewriteLock[] {
  const now = Date.now();
  for (const [id, lock] of locks) if (lock.expiresAt <= now) locks.delete(id);
  return [...locks.values()].filter(lock => lock.noteId === noteId);
}
export function lockProjection(lock: RewriteLock, doc?: Y.Doc) {
  const positions = doc ? lock.items.map(item => Y.createAbsolutePositionFromRelativePosition(item.position, doc)?.index).filter((n): n is number => n !== undefined) : [];
  return { id: lock.id, startBlock: positions[0] ?? lock.startBlock, endBlock: positions.at(-1) ?? lock.endBlock, runId: lock.runId,
    positions: lock.items.map(item => Buffer.from(Y.encodeRelativePosition(item.position)).toString("base64")) };
}
export function acquireRewriteLock(input: Omit<RewriteLock, "items" | "expiresAt" | "runId">, doc: Y.Doc): RewriteLock {
  const existing = activeRewriteLocks(input.noteId);
  const retry = existing.find(lock => lock.id === input.id && lock.userId === input.userId);
  if (retry) return retry;
  const fragment = doc.getXmlFragment("content");
  if (input.startBlock < 0 || input.endBlock < input.startBlock || input.endBlock >= fragment.length) throw new NoteRangeStaleError();
  if (existing.some(lock => {
    const range = lockProjection(lock, doc);
    return range.startBlock <= input.endBlock && range.endBlock >= input.startBlock;
  })) throw new NoteEditLockedError();
  const items: LockedItem[] = [];
  for (let index = input.startBlock; index <= input.endBlock; index++) items.push({
    position: Y.createRelativePositionFromTypeIndex(fragment, index), source: fragment.get(index).toString(),
  });
  const lock = { ...input, items, runId: null, expiresAt: Date.now() + 120_000 };
  locks.set(input.noteId + ":" + input.id, lock);
  return lock;
}
export function bindRewriteLock(noteId: string, id: string, userId: string, runId: string) {
  const lock = activeRewriteLocks(noteId).find(item => item.id === id && item.userId === userId);
  if (!lock) return false;
  lock.runId = runId; lock.expiresAt = Number.MAX_SAFE_INTEGER;
  return true;
}
export function releaseRewriteLock(noteId: string, id: string, userId: string) {
  const key = noteId + ":" + id;
  const lock = locks.get(key);
  if (lock?.noteId === noteId && lock.userId === userId) locks.delete(key);
}
export async function pruneCompletedRewriteLocks(workspaceId: string, noteId: string, userId: string) {
  await hydrateRewriteLocks(workspaceId, noteId, userId);
  const before = [...locks.values()].filter(lock => lock.noteId === noteId).length;
  const running = activeRewriteLocks(noteId).filter(lock => lock.workspaceId === workspaceId && lock.runId);
  const rows = running.length ? await withWorkspaceTransaction({ workspaceId, userId: running[0].userId }, tx => tx.select({ id: companionTurnRuns.id, status: companionTurnRuns.status })
    .from(companionTurnRuns).where(and(eq(companionTurnRuns.workspaceId, workspaceId), inArray(companionTurnRuns.id, running.map(lock => lock.runId!)))))
    : [];
  for (const lock of running) {
    const row = rows.find(row => row.id === lock.runId);
    if (!row || terminal.has(row.status)) locks.delete(lock.noteId + ":" + lock.id);
  }
  if (activeRewriteLocks(noteId).length !== before) await persistRewriteLocks(workspaceId, noteId, userId);
}
export function assertUnlockedUpdate(noteId: string, doc: Y.Doc, update: Uint8Array) {
  const held = activeRewriteLocks(noteId);
  if (!held.length) return;
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(candidate, update);
    const fragment = candidate.getXmlFragment("content");
    for (const lock of held) for (const item of lock.items) {
      const at = Y.createAbsolutePositionFromRelativePosition(item.position, candidate);
      if (!at || at.type !== fragment || at.index >= fragment.length) throw new NoteEditLockedError();
      const actual = Y.createRelativePositionFromTypeIndex(fragment, at.index);
      if (actual.item?.client !== item.position.item?.client || actual.item?.clock !== item.position.item?.clock || fragment.get(at.index).toString() !== item.source) throw new NoteEditLockedError();
    }
  } finally { candidate.destroy(); }
}
