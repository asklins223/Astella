/** Local synthetic integration support. Runs the canonical API writer against
 * the same disposable database as the worker probe; it never substitutes a
 * second note-edit implementation or bypasses its permissions. */
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { db, closeDatabase } from '../src/db/client.ts';
import { processCompanionNoteEdit } from '../src/modules/note/companion-edit-dispatch.ts';
import { closeNoteCollaboration } from '../src/modules/note/collaboration.ts';

if (process.env.ENTRY_SYNTHETIC_API !== '1'
  || !/^\/astella_hybrid_[A-Za-z0-9_]+$/.test(new URL(process.env.DATABASE_URL_API ?? '').pathname)) {
  throw new Error('Explicit ENTRY_SYNTHETIC_API=1 and a disposable astella_hybrid_* API database are required.');
}
const limit = Number(process.env.ENTRY_DISPATCH_LIMIT_MS ?? '180000');
if (!Number.isFinite(limit) || limit < 1 || limit > 180000) throw new Error('Invalid dispatcher deadline.');
let stopped = false;
process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });
const deadline = Date.now() + limit;
try {
  while (!stopped && Date.now() < deadline) {
    const rows = await db.execute<{ workspace_id: string; user_id: string; call_id: string }>(sql`
      SELECT * FROM astella_pending_companion_note_edits_v1()`);
    for (const row of rows) await processCompanionNoteEdit({ workspaceId: row.workspace_id, userId: row.user_id }, row.call_id);
    await delay(200);
  }
} finally {
  await closeNoteCollaboration();
  await closeDatabase();
}
