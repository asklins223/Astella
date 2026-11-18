import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createConnection, createServer, type Socket } from "node:net";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { acquireNoteCollaborationLeader } from "../modules/note/collaboration-leader.ts";

const url = testDatabaseUrl("NOTE_LEADER_TEST_DATABASE_URL");
// Admin may terminate the leader session; runtime can be a restricted API
// role so pg_locks visibility and advisory-lock privileges match production.
const runtimeUrl = testDatabaseUrl("NOTE_LEADER_TEST_RUNTIME_DATABASE_URL");
const adminTarget = new URL(url);
const runtimeTarget = new URL(runtimeUrl);
const dbName = adminTarget.pathname.slice(1);
if (!/^astella_(?:it|test|search)[a-zA-Z0-9_]*$/.test(dbName)
    || runtimeTarget.pathname !== adminTarget.pathname
    || runtimeTarget.hostname !== adminTarget.hostname
    || (runtimeTarget.port || "5432") !== (adminTarget.port || "5432")) {
  throw new Error("Leader test requires admin and runtime connections to the same disposable astella_it*, astella_test* or astella_search* database");
}

test("leader loss fences stale writes and a successor waits for in-flight transactions", async () => {
  const admin = postgres(url, { max: 2 });
  const work = postgres(runtimeUrl, { max: 2 });
  const db = drizzle(work);
  let lost = false;
  const leader = await acquireNoteCollaborationLeader(runtimeUrl, () => { lost = true; });
  let successor: Awaited<ReturnType<typeof acquireNoteCollaborationLeader>> | undefined;
  try {
    await assert.rejects(acquireNoteCollaborationLeader(runtimeUrl, () => {}), /Another API process/);
    const [row] = await admin<{ pid: number }[]>`
      select activity.pid from pg_stat_activity activity
      join pg_locks lock on lock.pid = activity.pid
      where activity.datname = current_database() and activity.application_name = 'astella_note_leader'
        and lock.locktype = 'advisory' and lock.granted and lock.objsubid = 2
        and lock.classid = 1096600321::oid and lock.objid = 1::oid`;
    assert.ok(row?.pid);

    let release!: () => void;
    let fenced!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { fenced = resolve; });
    const transaction = db.transaction(async tx => {
      await leader.fence(tx as never);
      fenced();
      await hold;
    });
    await locked;
    const [terminated] = await admin<{ ok: boolean }[]>`select pg_terminate_backend(${row.pid}) as ok`;
    assert.equal(terminated?.ok, true);
    let connected = false;
    const next = acquireNoteCollaborationLeader(runtimeUrl, () => {}).then(value => { connected = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(connected, false, "handover must wait for the fenced transaction to finish");
    release();
    await transaction;
    successor = await next;
    await assert.rejects(db.transaction(tx => leader.fence(tx as never)), /leadership was lost/);
    await db.transaction(tx => successor!.fence(tx as never));
    assert.equal(lost, true);
  } finally {
    await leader.close();
    await successor?.close();
    await work.end();
    await admin.end();
  }
});

test("a silent network partition causes a bounded fail-closed leader loss", async () => {
  const destination = new URL(runtimeUrl);
  const target = { host: destination.hostname, port: Number(destination.port || 5432) };
  const sockets = new Set<Socket>();
  let blackhole = false;
  const proxy = createServer(client => {
    const remote = createConnection(target);
    sockets.add(client); sockets.add(remote);
    const close = () => { client.destroy(); remote.destroy(); sockets.delete(client); sockets.delete(remote); };
    client.on("error", close); remote.on("error", close);
    client.on("close", close); remote.on("close", close);
    client.on("data", data => { if (!blackhole) remote.write(data); });
    remote.on("data", data => { if (!blackhole) client.write(data); });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => resolve());
  });
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  destination.hostname = "127.0.0.1";
  destination.port = String(address.port);
  const work = postgres(runtimeUrl, { max: 1 });
  const db = drizzle(work);
  let lost = 0;
  let leader: Awaited<ReturnType<typeof acquireNoteCollaborationLeader>> | undefined;
  try {
    leader = await acquireNoteCollaborationLeader(destination.toString(), () => { lost++; }, {
      heartbeatIntervalMs: 50, heartbeatTimeoutMs: 100,
    });
    await db.transaction(tx => leader!.fence(tx as never));
    blackhole = true;
    const deadline = Date.now() + 2_000;
    while (!lost && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(lost, 1, "a silent partition must invalidate the leader");
    await assert.rejects(db.transaction(tx => leader!.fence(tx as never)), /leadership was lost/);
  } finally {
    for (const socket of sockets) socket.destroy();
    await leader?.close();
    await work.end();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});
