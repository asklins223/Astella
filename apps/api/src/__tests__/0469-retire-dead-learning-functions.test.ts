import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const migrationsDir = fileURLToPath(new URL("../db/migrations/", import.meta.url));
const journal = readFileSync(join(migrationsDir, "meta/_journal.json"), "utf8");
const migration = readFileSync(
  join(migrationsDir, "0469_retire_dead_learning_procedure_functions.sql"),
  "utf8",
);

/** 退役链路留下的空壳：不删干净就会在有人调用时抛 `relation ... does not exist`。 */
const RETIRED = [
  "astella_card_generation_outbox_notify()",
  "astella_claim_run_processing(text,integer,integer,timestamp with time zone)",
  "astella_mark_run_processing_processed(uuid,text,timestamp with time zone)",
  "astella_release_run_processing(uuid,text,text,timestamp with time zone)",
  "astella_note_rounds_idle_for_pause(integer)",
  "guard_note_learning_round_artifact_failure()",
  "prevent_immutable_v2_row_mutation()",
  "prevent_note_learning_round_artifact_mutation()",
  "prevent_note_learning_round_ownership_mutation()",
  "prevent_note_learning_round_plan_mutation()",
  "prevent_note_learning_round_target_mutation()",
  "prevent_note_learning_round_teaching_mutation()",
  "prevent_objective_revision_mutation()",
  "prevent_publication_revision_mutation()",
];

test("0469 is registered after the diary material migration", () => {
  assert.match(journal, /"idx": 464/);
  assert.match(journal, /"tag": "0469_retire_dead_learning_procedure_functions"/);
  assert.ok(
    journal.indexOf("0469_retire_dead_learning_procedure_functions")
      > journal.indexOf("0468_companion_diary_material_sources"),
  );
});

test("0469 names every retired function by its full signature", () => {
  for (const signature of RETIRED) {
    assert.ok(
      migration.includes(`to_regprocedure('public.${signature}')`),
      `0469 没有登记 ${signature}`,
    );
  }
});

test("0469 never drops an object it is not allowed to drop", () => {
  // 迁移以 astella_migrator 身份执行，而老库里的函数可能仍归超级用户。
  // 无条件 DROP 会让整个部署停在这一步，所以必须先比较 owner。
  assert.doesNotMatch(migration, /^\s*DROP\s+FUNCTION/im);
  assert.match(migration, /pg_get_userbyid\(p\.proowner\)/);
  assert.match(migration, /IF v_owner = current_user THEN/);
  assert.match(migration, /RAISE WARNING/);
});
