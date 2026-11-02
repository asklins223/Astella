import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { acceptCompanionToolReview } from "../companion-tool-review-action.ts";
import type { ApiTransaction } from "../../../db/client.ts";

const id = "11111111-1111-4111-8111-111111111111";
const scope = { workspaceId: id, userId: id };
const proposal = { id, agent_run_id: id, agent_tool_call_id: "resolved-forget" };

test("a frozen forget query resolved to one memory keeps its exact ledger identity at confirmation", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const dialect = new PgDialect();
  const tx = { async execute(statement) {
    const query = dialect.sqlToQuery(statement as SQL); queries.push(query);
    return query.sql.includes("SELECT c.id") ? [{ id }] : [];
  } } as ApiTransaction;
  const args = { query: "晚上九点以后不想被打扰", memoryId: id };
  const payload = { kind: "agent_tool_review", toolName: "memory.write.forget", arguments: args,
    expectedTarget: { content: "晚上九点之后不打扰", revision: 1 }, confirmationStage: "before_execute",
    preview: { title: "删除这条记忆", markdown: "晚上九点之后不打扰" } };
  assert.equal(await acceptCompanionToolReview(tx, scope, proposal, payload, "hash"), true);
  assert.ok(queries.some(q => q.sql.includes("c.arguments=") && q.params.includes(JSON.stringify(args))),
    "validation must not mutate the frozen target used for the database compare");
  await assert.rejects(acceptCompanionToolReview(tx, scope, proposal,
    { ...payload, arguments: { query: args.query } }, "hash"), /no longer valid/);
});
