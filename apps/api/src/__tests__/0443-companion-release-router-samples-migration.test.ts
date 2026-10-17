import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0443_companion_release_router_samples.sql", import.meta.url),
  "utf8",
);
const roleGrants = readFileSync(
  new URL("../../../../infra/postgres/roles.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

// 2026-10-17：L1 放行路由的样本原来只活在 worker 进程内存里，重启即冷启动。
// 落库之后重启零 embedding 读回；只存原话摘要、标签与向量，不存正文。
test("0443 stores durable L1 release-router samples without the utterance text", () => {
  assert.ok(journal.entries.some((entry) => entry.idx === 439 && entry.tag === "0443_companion_release_router_samples"));
  assert.match(migration, /CREATE TABLE public\.companion_release_router_samples/);
  assert.match(migration, /text_sha256 char\(64\) NOT NULL CHECK \(text_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(migration, /embedding jsonb NOT NULL CHECK \(jsonb_typeof\(embedding\) = 'array'\)/);
  assert.match(migration, /CREATE UNIQUE INDEX companion_release_router_samples_key_idx/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /FOR ALL TO astella_worker/);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON public\.companion_release_router_samples FROM PUBLIC, astella_api/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.companion_release_router_samples TO astella_worker/);
});

test("roles.sql keeps the sample store worker-only after the bootstrap REVOKE ALL", () => {
  assert.match(roleGrants, /'companion_release_router_samples'/);
  assert.match(roleGrants, /GRANT INSERT, UPDATE, DELETE ON TABLE public\.companion_release_router_samples TO astella_worker/);
  assert.match(roleGrants, /\('companion_release_router_samples', true, true, true, true\)/);
  // API deliberately has no access: it must stay in the worker-only exempt list,
  // otherwise the bootstrap privilege assertion fails.
  assert.match(roleGrants, /'companion_release_router_samples',\n      'companion_run_failure_spans'/);
});
