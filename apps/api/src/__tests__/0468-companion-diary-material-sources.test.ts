import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const migrationsDir = fileURLToPath(new URL("../db/migrations/", import.meta.url));
const journal = readFileSync(join(migrationsDir, "meta/_journal.json"), "utf8");
const DIARY_TICK = "FUNCTION public.astella_enqueue_companion_daily_summaries()";

/** The tick is replaced in place, so the guard must read the newest definition, not 0333. */
function effectiveDiaryMigration(): { file: string; sql: string } {
  const file = readdirSync(migrationsDir)
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .filter((name) => readFileSync(join(migrationsDir, name), "utf8").includes(DIARY_TICK))
    .pop();
  assert.ok(file, "no migration defines the diary tick");
  return { file, sql: readFileSync(join(migrationsDir, file), "utf8") };
}

test("0468 is registered after the review-confirmation migration", () => {
  assert.match(journal, /"idx": 463/);
  assert.match(journal, /"tag": "0468_companion_diary_material_sources"/);
  assert.ok(journal.indexOf("0468_companion_diary_material_sources") > journal.indexOf("0467_companion_review_confirmation_window"));
});

test("the effective diary tick only probes material tables that still exist", () => {
  const { file, sql } = effectiveDiaryMigration();
  // Comments may name the retired tables to explain the break; executable SQL must not.
  const body = sql.replace(/--[^\n]*/g, "");
  for (const retired of ["learning_runs", "learning_cards_v2", "note_learning_rounds"]) {
    assert.doesNotMatch(body, new RegExp(`\\b${retired}\\b`), `${file} still queries retired ${retired}`);
  }
  for (const material of ["companion_messages", "notes", "sources", "note_learning_card_attempts", "note_learning_cards", "learning_metric_events"]) {
    assert.match(body, new RegExp(`\\b${material}\\b`), `${file} lost the ${material} activity probe`);
  }
});

test("the effective diary tick keeps its scheduling contract", () => {
  const { file, sql } = effectiveDiaryMigration();
  assert.match(sql, /diary_enabled_since IS NOT NULL/, `${file} must skip accounts without a diary window`);
  assert.match(sql, /material_start := GREATEST\(day_start, v_pair\.diary_enabled_since\)/, `${file} must floor material at the enable time`);
  assert.match(sql, /local_date::date::timestamp AT TIME ZONE tz/, `${file} must build day boundaries from local midnight`);
  assert.doesNotMatch(sql, /local_date::date AT TIME ZONE tz/, `${file} must not convert DATE through the session timezone`);
  assert.match(sql, /type <> 'companion_daily_summary'/, `${file} must not feed itself`);
  assert.match(sql, /SET search_path = pg_catalog, public/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /OWNER TO astella_migrator/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.astella_enqueue_companion_daily_summaries\(\)\s+TO astella_worker/);
});

test("0468 gives enabled accounts without a diary window one", () => {
  const sql = readFileSync(join(migrationsDir, "0468_companion_diary_material_sources.sql"), "utf8");
  assert.match(sql, /SET diary_enabled_since = date_trunc\('milliseconds', now\(\)\)/);
  assert.match(sql, /WHERE global_enabled = true\s+AND diary_enabled = true\s+AND diary_enabled_since IS NULL/);
});
