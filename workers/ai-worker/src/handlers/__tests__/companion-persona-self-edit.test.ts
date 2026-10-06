import { test } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import type { WorkerTransaction } from "../../db.ts";
import { getDefaultPersonaPreset } from "@astella/shared/pet-persona-presets";
import { personaFromDefaultPreset } from "@astella/shared/pet-persona-merge";
import { applyAssistantPersonaEdit } from "../companion-persona-self-edit.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const base = personaFromDefaultPreset(getDefaultPersonaPreset());
const value = base.activeness === "quiet" ? "active" : "quiet";

test("首次自改从默认人格起稿，只改指定字段并留下 assistant 来源和版本", async () => {
  const statements: { sql: string; params: unknown[] }[] = [];
  let saved: typeof base | undefined;
  const tx = { execute: async (statement: any) => {
    const query = new PgDialect().sqlToQuery(statement);
    statements.push(query);
    if (statements.length === 1) return [];
    if (statements.length === 2) {
      saved = JSON.parse(query.params.find((param) => typeof param === "string" && param.startsWith("{")) as string);
      return [{ revision: 1, profile: saved }];
    }
    return [];
  } } as unknown as WorkerTransaction;
  const result = await applyAssistantPersonaEdit(tx, userId, "activeness", value, "测试表达分量");
  assert.equal(result.kind, "changed");
  if (result.kind !== "changed") return;
  assert.equal(result.revision, 1);
  assert.equal(result.profile.name, base.name);
  assert.equal(result.profile.speakingStyle, base.speakingStyle);
  assert.equal(result.profile.activeness, value);
  assert.equal(result.profile.fieldOrigin?.activeness, "assistant");
  assert.equal(statements.length, 3);
  assert.match(statements[2].sql, /companion_persona_profile_versions/);
  assert.ok(statements[2].params.includes(JSON.stringify(saved)));
});

test("没有实质改动时不新增版本；并发未保存时不写版本历史", async () => {
  let count = 0;
  const existing = { ...base, activeness: value, fieldOrigin: { ...base.fieldOrigin, activeness: "assistant" as const } };
  const tx = { execute: async () => { count++; return [{ revision: 3, pending_revision: 10, profile: existing }]; } } as unknown as WorkerTransaction;
  assert.equal((await applyAssistantPersonaEdit(tx, userId, "activeness", value, "相同表达" )).kind, "unchanged");
  assert.equal(count, 1);
  count = 0;
  const queries: { sql: string; params: unknown[] }[] = [];
  const conflicted = { execute: async (statement: any) => {
    count++; queries.push(new PgDialect().sqlToQuery(statement));
    return count === 1 ? [{ revision: 3, pending_revision: 10, profile: base }] : [];
  } } as unknown as WorkerTransaction;
  assert.equal((await applyAssistantPersonaEdit(conflicted, userId, "activeness", value, "并发写入")).kind, "conflict");
  assert.equal(count, 2);
  assert.ok(queries[1].params.includes(11));
});
