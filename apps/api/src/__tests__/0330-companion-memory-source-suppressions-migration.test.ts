import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../db/migrations/0330_companion_memory_source_suppressions.sql", import.meta.url),
  "utf8",
);
const journal = readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
);

test("0330 journals durable, user-scoped source suppression tombstones", () => {
  assert.match(journal, /"idx": 329,[\s\S]*?"tag": "0330_companion_memory_source_suppressions"/);
  assert.match(migration, /CREATE TABLE public\.assistant_memory_source_suppressions/);
  assert.match(migration, /user_id uuid NOT NULL REFERENCES public\.users\(id\) ON DELETE CASCADE/);
  assert.match(
    migration,
    /PRIMARY KEY \(user_id, kind, source_event_id\)/,
  );
  assert.match(migration, /ALTER TABLE public\.assistant_memory_source_suppressions FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /CURRENT_USER = 'ailearn_worker'/);
  assert.match(migration, /current_setting\('app\.user_id', true\)/);
  assert.match(migration, /GRANT SELECT, INSERT ON public\.assistant_memory_source_suppressions TO ailearn_api/);
  assert.match(migration, /GRANT SELECT, INSERT ON public\.assistant_memory_source_suppressions TO ailearn_worker/);
});

test("0330 backfills deleted sources and suppresses workspace retirement atomically", () => {
  assert.match(migration, /FROM public\.assistant_memory_items[\s\S]*?WHERE deleted_at IS NOT NULL[\s\S]*?source_event_id IS NOT NULL[\s\S]*?ON CONFLICT \(user_id, kind, source_event_id\) DO NOTHING/);
  assert.match(migration, /hashtextextended\('companion-memory-write:' \|\| p_user_id::text, 0\)/);

  const suppressionWrite = migration.indexOf("INSERT INTO public.assistant_memory_source_suppressions", migration.indexOf("CREATE OR REPLACE FUNCTION"));
  const softDelete = migration.indexOf("UPDATE public.assistant_memory_items", suppressionWrite);
  assert.ok(suppressionWrite >= 0, "departure must write source suppressions");
  assert.ok(softDelete > suppressionWrite, "departure writes tombstones before soft-deleting memories");
  assert.match(migration.slice(suppressionWrite, softDelete), /scope = 'workspace'/);
  assert.match(migration.slice(suppressionWrite, softDelete), /source_event_id IS NOT NULL/);
});
