import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

/**
 * Plan 57 anti-drift guard.
 *
 * The old chain (objective/card library/review/learning run/note round/validation)
 * is deleted first. New note-learning-card code must not reach back into it while
 * the deletion is being completed. This guard is intentionally name-based: it scans
 * the new card modules and fails on any import or identifier that names an old
 * module family.
 */
const API_SRC = resolve(import.meta.dirname, "..");
const NEW_CARD_MODULE = join(API_SRC, "modules", "note-learning-cards");
const FORBIDDEN = [
  /learning-objectives/,
  /card-generation-v2/,
  /card-generation-desktop/,
  /learning-card-v2/,
  /learning-runs?\//,
  /note-learning-rounds/,
  /modules\/review\//,
  /validation-surface/,
  /review-queue/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !/\.(test|integration)\.ts$/.test(name)) out.push(p);
  }
  return out;
}

test("new note-learning-card modules do not import the retired chain", () => {
  for (const file of walk(NEW_CARD_MODULE)) {
    const src = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN) {
      assert.equal(pattern.test(src), false, `${file} references retired module family ${pattern}`);
    }
  }
});

test("Agent contracts and receipt readers cannot revive retired card engines", () => {
  const root = resolve(API_SRC, "../../..");
  for (const name of ["packages/shared/src/contracts/agent/agent-contracts.ts", "packages/agent-host/src/operation-receipt.ts", "packages/agent-host/src/history.ts",
    "apps/desktop-client/src/renderer/src/components/companion/goals/agent-goal-presentation.ts"]) {
    const source = readFileSync(join(root, name), "utf8");
    for (const retired of ["card_candidates", "card_generation_runs_v2", "card_generation_run_id", "no_cards_recommended"]) assert.equal(source.includes(retired), false, `${name} still accepts ${retired}`);
  }
});

test("retired formal-answer and tutor stubs cannot remain in the active companion path", () => {
  const root = resolve(API_SRC, "../../..");
  for (const name of ["workers/ai-worker/src/handlers/turn/companion-dialogue.ts", "workers/ai-worker/src/handlers/turn/companion-dialogue-store.ts",
    "workers/ai-worker/src/handlers/agent/companion-agent-runtime.ts", "workers/ai-worker/src/handlers/tools/companion-read-tools.ts"]) {
    const source = readFileSync(join(root, name), "utf8");
    for (const retired of ["findFormalAnswerTarget", "formalAnswerTarget", "readGroundedTutorContext", "groundedTutorContext", "taskQueueToolResult", 'kind: "learning_run"']) {
      assert.equal(source.includes(retired), false, `${name} still carries ${retired}`);
    }
  }
});
