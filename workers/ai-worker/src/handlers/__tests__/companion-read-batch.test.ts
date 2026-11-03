import assert from "node:assert/strict";
import test from "node:test";
import { CompanionReadBatch, companionParallelReadOperation } from "../tools/companion-read-batch.ts";

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

test("independent note, history and search reads start together, with ordered consumption", async () => {
  const gates = [gate<string>(), gate<string>(), gate<string>()], started: number[] = [];
  const batch = new CompanionReadBatch({ count: 3, signal: new AbortController().signal,
    operation: i => ["notes.read.read", "memory.read.past_conversation", "web.search"][i]!,
    prepare: async i => i, key: String,
    execute: async i => { started.push(i); return gates[i]!.promise; } });
  const first = await batch.at(0);
  await batch.at(2);
  assert.deepEqual(started, [0, 1, 2]);
  gates[2]!.resolve("search"); gates[1]!.resolve("history"); gates[0]!.resolve("note");
  const values = [];
  for (let i = 0; i < 3; i++) values.push(await (await batch.at(i))!.result);
  assert.deepEqual(values, ["note", "history", "search"]);
  assert.equal(await first!.result, "note"); await batch.close();
});

test("writes and a search-dependent web read delimit batches", async () => {
  const started: number[] = [];
  const ops = ["web.search", "notes.read.search", "web.read_document", "web.read_document", null, "notes.read.read"];
  const batch = new CompanionReadBatch({ count: ops.length, signal: new AbortController().signal,
    operation: i => ops[i] ?? null, prepare: async i => i, key: String,
    execute: async i => { started.push(i); return i; } });
  await (await batch.at(0))!.result;
  await (await batch.at(1))!.result;
  assert.deepEqual(started, [0, 1]);
  await (await batch.at(2))!.result;
  await (await batch.at(3))!.result;
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.equal(await batch.at(4), undefined); assert.equal(await batch.at(5), undefined);
  await batch.close();
});

test("concurrency bounds do not truncate a larger read batch; duplicate receipts execute once", async () => {
  const release = gate(), started: number[] = [];
  const batch = new CompanionReadBatch({ count: 7, signal: new AbortController().signal,
    operation: () => "notes.read.read", prepare: async i => i, key: i => String(i === 1 ? 0 : i),
    execute: async i => { started.push(i); await release.promise; return i; } });
  await batch.at(0);
  assert.ok(started.length <= 4); assert.ok(!started.includes(4));
  release.resolve();
  for (let i = 0; i < 7; i++) await (await batch.at(i))!.result;
  assert.deepEqual(started, [0, 2, 3, 4, 5, 6]); await batch.close();
});

test("one failed read preserves siblings, and cancellation does not register queued reads", async () => {
  const parent = new AbortController(), prepared: number[] = [];
  const batch = new CompanionReadBatch({ count: 6, signal: parent.signal,
    operation: () => "notes.read.read", prepare: async i => { prepared.push(i); return i; }, key: String,
    execute: async (i, _value, signal) => {
      if (i === 0) throw new Error("read failed");
      if (signal.aborted) return i;
      return new Promise<number>(resolve => signal.addEventListener("abort", () => resolve(i), { once: true }));
    } });
  const first = await batch.at(0); await assert.rejects(first!.result, /read failed/);
  parent.abort(); await batch.close();
  assert.ok(!prepared.includes(5));
  assert.equal(await (await batch.at(1))!.result, 1);
  assert.equal(await batch.at(5), undefined);
});

test("only registered read operations are eligible, never writes, controls, navigation or artifacts", () => {
  for (const operation of ["notes.read.search", "memory.read.read", "observe.stats", "web.search", "web.read_document"])
    assert.equal(companionParallelReadOperation(operation, "read"), true);
  for (const operation of ["notes.write.create", "say.publish", "companion_load_tools", "visual.diagram", "navigation.open"])
    assert.equal(companionParallelReadOperation(operation, "read"), false);
  assert.equal(companionParallelReadOperation("notes.read.read", "write"), false);
});

test("asynchronous registration reserves a shared budget before the next read can register", async () => {
  const release = gate(); let reservations = 0;
  const batch = new CompanionReadBatch({ count: 4, signal: new AbortController().signal,
    operation: () => "web.search", prepare: async i => {
      if (reservations >= 1) return null;
      await release.promise; reservations++; return i;
    }, key: String, execute: async i => i });
  const first = batch.at(0); release.resolve();
  assert.equal(await (await first)!.result, 0);
  for (let i = 1; i < 4; i++) assert.equal(await batch.at(i), undefined);
  assert.equal(reservations, 1); await batch.close();
});
