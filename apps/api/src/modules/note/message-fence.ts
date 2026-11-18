import type { ApiTransaction } from "../../db/client.ts";
import { fenceNoteCollaborationWrite } from "./collaboration-leader.ts";

// beforeSync may itself need a database connection. Holding every connection
// in the API's 25-connection pool here could deadlock message processing.
const MAX_IN_FLIGHT = 4;
let active = 0;
const waiting: Array<() => void> = [];

async function takeSlot(): Promise<() => void> {
  if (active >= MAX_IN_FLIGHT) await new Promise<void>(resolve => waiting.push(resolve));
  else active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
}

/** Hold a shared handover barrier through the Hocuspocus message handler.
 * This protects ordinary leadership handover; a forcibly terminated database
 * session or arbitrarily paused process can still invalidate the transaction,
 * so this is not a multi-replica protocol. */
export async function holdNoteMessageFence(
  authorize: (hold: (tx: ApiTransaction) => Promise<void>) => Promise<void>,
  onLost: () => void,
): Promise<() => Promise<void>> {
  const releaseSlot = await takeSlot();
  let ready!: () => void;
  let fail!: (error: unknown) => void;
  let release!: () => void;
  const acquired = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
  const finished = new Promise<void>(resolve => { release = resolve; });
  let wasAcquired = false;
  const transaction = authorize(async tx => {
    await fenceNoteCollaborationWrite(tx);
    wasAcquired = true;
    ready();
    await finished;
  });
  // A failed transaction must not permanently consume a message slot. The
  // connection is no longer safe to use after its handover barrier is lost.
  void transaction.then(() => {
    if (!wasAcquired) fail(new Error("unauthorized"));
  }, error => {
    if (!wasAcquired) fail(error);
    else {
      release();
      releaseSlot();
      onLost();
    }
  });
  try {
    await acquired;
  } catch (error) {
    releaseSlot();
    throw error;
  }
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    release();
    try { await transaction; } finally { releaseSlot(); }
  };
}
