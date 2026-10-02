import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0341_companion_account_persona.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };
const roleGrants = readFileSync(
  new URL("../../../../infra/postgres/roles.sql", import.meta.url),
  "utf8",
);

test("0341 moves persona to the account scope and retains each prior workspace profile", () => {
  assert.ok(journal.entries.some((entry) => entry.idx === 340 && entry.tag === "0341_companion_account_persona"));
  assert.match(migration, /CREATE TABLE public\.companion_persona_profiles/);
  assert.match(migration, /CREATE UNIQUE INDEX companion_persona_profiles_user_unique[\s\S]*?ON public\.companion_persona_profiles \(user_id\)/);
  assert.match(migration, /CREATE TABLE public\.companion_persona_profile_versions/);
  assert.match(migration, /row_number\(\) OVER \(PARTITION BY p\.user_id ORDER BY p\.updated_at, p\.workspace_id\)/);
  assert.match(migration, /ORDER BY p\.user_id, p\.updated_at DESC, p\.workspace_id ASC/);
  assert.match(migration, /source_workspace_id, profile, created_at/);
  for (const legacyField of ["preset_id", "name", "personality_tags", "speaking_style", "examples", "activeness", "boundaries"]) {
    assert.match(migration, new RegExp(`'${legacyField === "preset_id" ? "presetId" : legacyField === "personality_tags" ? "personalityTags" : legacyField === "speaking_style" ? "speakingStyle" : legacyField}', p\\.${legacyField}`));
  }
  assert.match(migration, /DROP COLUMN IF EXISTS preset_id[\s\S]*?DROP COLUMN IF EXISTS revision/);
});

test("0341 isolates shared persona by user and keeps relationship state workspace-local", () => {
  assert.match(migration, /companion_persona_profiles_user_isolation[\s\S]*?user_id = NULLIF\(current_setting\('app\.user_id', true\), ''\)::uuid/);
  assert.match(migration, /companion_persona_profile_versions_user_isolation[\s\S]*?user_id = NULLIF\(current_setting\('app\.user_id', true\), ''\)::uuid/);
  assert.match(migration, /DROP POLICY IF EXISTS pet_profiles_workspace_user_isolation/);
  assert.match(migration, /workspace_id = NULLIF\(current_setting\('app\.workspace_id', true\), ''\)::uuid[\s\S]*?AND user_id = NULLIF\(current_setting\('app\.user_id', true\), ''\)::uuid/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.companion_persona_profiles TO ailearn_api/);
  assert.match(migration, /GRANT SELECT, INSERT ON public\.companion_persona_profile_versions TO ailearn_api/);
  assert.match(migration, /GRANT SELECT, INSERT ON public\.companion_persona_profile_versions TO ailearn_worker/);
});

test("0341 records the persona versions pinned to dialogue and diary generation", () => {
  for (const table of ["companion_turn_runs", "companion_diary_generation_checkpoints", "companion_daily_summaries", "assistant_thoughts"]) {
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table}[\\s\\S]*?ADD COLUMN persona_profile_revision integer,[\\s\\S]*?ADD COLUMN persona_examples_revision integer,[\\s\\S]*?ADD COLUMN default_expression_version text`));
  }
});

test("runtime role bootstrap preserves persona access and append-only history", () => {
  assert.match(roleGrants, /'companion_persona_profiles'[\s\S]*?'companion_persona_profile_versions'/);
  assert.match(roleGrants, /GRANT SELECT, INSERT, UPDATE ON TABLE public\.companion_persona_profiles TO ailearn_worker/);
  assert.match(roleGrants, /GRANT SELECT, INSERT ON TABLE public\.companion_persona_profile_versions TO ailearn_api, ailearn_worker/);
  assert.match(roleGrants, /\('companion_persona_profiles', true, true, true, false\)/);
  assert.match(roleGrants, /\('companion_persona_profile_versions', true, true, false, false\)/);
  assert.match(roleGrants, /companion persona profile versions must be append-only for API and worker/);
});
