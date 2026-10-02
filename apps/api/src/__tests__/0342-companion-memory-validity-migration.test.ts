import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0342_companion_memory_validity.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

test("0342 stores applicability and validity on current and revision rows", () => {
  assert.ok(journal.entries.some((entry) => entry.idx === 341 && entry.tag === "0342_companion_memory_validity"));
  for (const table of ["assistant_memory_items", "assistant_memory_item_revisions"]) {
    const block = migration.match(new RegExp(`ALTER TABLE public\\.${table}[\\s\\S]*?;`))?.[0] ?? "";
    for (const column of ["source_speaker", "source_basis", "applies_when", "valid_from", "valid_until"]) {
      assert.match(block, new RegExp(`ADD COLUMN ${column}\\b`), `${table} must store ${column}`);
    }
  }
  assert.match(migration, /valid_until > valid_from/);
  assert.match(migration, /char_length\(applies_when\) <= 200/);
  assert.match(migration, /RETURN NEW;\s*END;\s*\$\$/);
  const finalBlock = migration.slice(migration.lastIndexOf("DO $$"));
  assert.match(finalBlock, /END;\s*\$\$;/);
});

test("0342 snapshots metadata changes and carries them through global memory sync", () => {
  for (const column of ["source_speaker", "source_basis", "applies_when", "valid_from", "valid_until"]) {
    assert.match(migration, new RegExp(`NEW\\.${column}[\\s\\S]*?OLD\\.${column}`));
    assert.match(migration, new RegExp(`UPDATE public\\.assistant_memory_items[\\s\\S]*?${column} = NEW\\.${column}`));
    assert.match(migration, new RegExp(`${column},`));
  }
  assert.match(migration, /assistant_memory_items_valid_until_idx/);
});
