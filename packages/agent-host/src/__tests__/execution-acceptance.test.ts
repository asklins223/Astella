import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { createAgentStore, type AgentSqlExecutor } from "../store.ts";

const dialect = new PgDialect();
test("denied AI acceptance cannot create a run, operation or queued job", async () => {
  const queries: string[] = [];
  const tx: AgentSqlExecutor = { execute: async query => {
    const text = dialect.sqlToQuery(query).sql;
    queries.push(text);
    if (text.includes("user_companion_account_state")) return [{ id: "identity", epoch: 1, global_enabled: true, agent_settings: {} }];
    return [];
  } };
  const rejection = new Error("AI permission required");
  const store = createAgentStore({ transaction: async (_scope, action) => action(tx), id: () => "fixture",
    assertExecutionAllowed: async () => { throw rejection; } });
  await assert.rejects(store.create({ workspaceId: "workspace", userId: "user" }, { requestId: "request", goal: "整理笔记", inputs: [] }), error => error === rejection);
  assert.ok(queries.length > 0);
  assert.equal(queries.some(query => /\b(?:INSERT|UPDATE|DELETE)\b/.test(query)), false);
});
