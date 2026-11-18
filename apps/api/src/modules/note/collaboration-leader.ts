import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";

// Two-key advisory locks are scoped to the current PostgreSQL database.
// The exclusive barrier serializes ownership handover with in-flight writes.
const LOCK_NAMESPACE = 1_096_600_321;
const LEADER_KEY = 1;
const BARRIER_KEY = 2;

export interface NoteCollaborationLeader {
  fence(tx: ApiTransaction): Promise<void>;
  close(): Promise<void>;
}

/** Acquire a singleton API leader on a dedicated database session.
 * An old process may still have working pool connections after this session is
 * lost, so every document write also takes the shared barrier and verifies both
 * session locks in its own transaction before touching persistent state. */
export async function acquireNoteCollaborationLeader(
  connectionString: string,
  onLost: () => void,
  options: { heartbeatIntervalMs?: number; heartbeatTimeoutMs?: number } = {},
): Promise<NoteCollaborationLeader> {
  let acquired = false;
  let stopping = false;
  let valid = true;
  let heartbeat: NodeJS.Timeout | undefined;
  const markLost = () => {
    if (!valid) return;
    valid = false;
    if (heartbeat) clearInterval(heartbeat);
    if (acquired && !stopping) onLost();
  };
  const nonce = randomBytes(8);
  let nonceNamespace = (nonce.readUInt32BE(0) & 0x7fffffff) || 1;
  if (nonceNamespace === LOCK_NAMESPACE) nonceNamespace = LOCK_NAMESPACE + 1;
  const nonceKey = (nonce.readUInt32BE(4) & 0x7fffffff) || 1;
  const connection = postgres(connectionString, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: 0,
    connection: { application_name: "astella_note_leader", statement_timeout: 60_000, lock_timeout: 5_000 },
    onclose: markLost,
  });
  try {
    const pid = await connection.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${LOCK_NAMESPACE}, ${BARRIER_KEY})`;
      const [row] = await tx<{ leader: boolean; pid: number }[]>`
        select pg_try_advisory_lock(${LOCK_NAMESPACE}, ${LEADER_KEY}) as leader, pg_backend_pid() as pid`;
      if (!row?.leader) throw new Error("Another API process owns the note collaboration leader lock");
      await tx`select pg_advisory_lock(${nonceNamespace}, ${nonceKey})`;
      return row.pid;
    });
    if (!valid) throw new Error("Note collaboration leader session closed during startup");
    acquired = true;
    // A broken TCP path need not emit close promptly. Probe the dedicated
    // session and fail closed on a bounded deadline instead of indefinitely
    // serving its in-memory documents while another instance takes over.
    let checking = false;
    heartbeat = setInterval(() => {
      if (checking || !valid || stopping) return;
      checking = true;
      const deadline = setTimeout(markLost, options.heartbeatTimeoutMs ?? 5_000);
      deadline.unref();
      void connection`select 1`.then(() => {
        clearTimeout(deadline);
      }, () => {
        clearTimeout(deadline);
        markLost();
      }).finally(() => { checking = false; });
    }, options.heartbeatIntervalMs ?? 5_000);
    heartbeat.unref();
    return {
      async fence(tx) {
        if (!valid || stopping) throw new Error("Note collaboration leadership was lost");
        // Fail fast during handover. Some messages already hold a shared lock
        // while pruning rewrite locks using another transaction.
        const result = await tx.execute<{ valid: boolean }>(sql`
          with barrier as materialized (
            select pg_try_advisory_xact_lock_shared(${LOCK_NAMESPACE}, ${BARRIER_KEY}) as held
          )
          select barrier.held and exists (
            select 1 from pg_locks g join pg_locks n on n.pid = g.pid
            where g.locktype = 'advisory' and g.granted and g.pid = ${pid}
              and g.classid = ${LOCK_NAMESPACE}::oid and g.objid = ${LEADER_KEY}::oid and g.objsubid = 2
              and n.locktype = 'advisory' and n.granted
              and n.classid = ${nonceNamespace}::oid and n.objid = ${nonceKey}::oid and n.objsubid = 2
          ) as valid from barrier`);
        if (!valid || !result[0]?.valid) throw new Error("Note collaboration leadership was lost");
      },
      async close() {
        stopping = true;
        valid = false;
        if (heartbeat) clearInterval(heartbeat);
        await connection.end({ timeout: 5 });
      },
    };
  } catch (error) {
    stopping = true;
    await connection.end({ timeout: 5 }).catch(() => undefined);
    throw error;
  }
}

// Unit and isolated service integration tests do not start the HTTP server;
// only server startup installs this guard, before it begins accepting traffic.
let current: NoteCollaborationLeader | null = null;
export function installNoteCollaborationLeader(leader: NoteCollaborationLeader | null): void { current = leader; }
export async function fenceNoteCollaborationWrite(tx: ApiTransaction): Promise<void> { await current?.fence(tx); }
