import assert from "node:assert/strict";
import { test } from "node:test";
import { readOperationResultReceipt } from "../operation-receipt.ts";
import type { AgentSqlExecutor } from "../store.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const request = { capability: "note_overview_generate", execution: { kind: "job" as const, id: id(1) }, scope: { workspaceId: id(2), userId: id(3) }, inputs: [{ kind: "note_version" as const, noteId: id(4), noteVersionId: id(5) }] };
const artifact = { kind: "note_overview", id: id(6), jobId: id(1), noteId: id(4), noteVersionId: id(5) };
const tx = (value: unknown): AgentSqlExecutor => ({ execute: async () => [{ artifact: value }] });
test("current operation receipts require a saved artifact with the exact job and frozen material", async () => {
  assert.equal((await readOperationResultReceipt(tx(artifact), request)).kind, "result");
  for (const value of [null, { ...artifact, jobId: id(7) }, { ...artifact, noteId: id(7) }, { ...artifact, noteVersionId: id(7) }]) assert.equal((await readOperationResultReceipt(tx(value), request)).kind, "pending");
});
test("an unregistered capability has no query or compatibility receipt", async () => {
  let queries = 0;
  assert.equal((await readOperationResultReceipt({ execute: async () => { queries++; return []; } }, { ...request, capability: "unregistered" })).kind, "pending");
  assert.equal(queries, 0);
});
