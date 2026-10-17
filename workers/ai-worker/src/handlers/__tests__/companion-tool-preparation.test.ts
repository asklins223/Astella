import assert from "node:assert/strict";
import test from "node:test";
import { getCompanionAgentTool } from "@astella/shared";
import { CompanionToolPreparation } from "../tools/companion-tool-preparation.ts";
import { companionToolExecutionTimeout } from "../tools/companion-tool-execution-run.ts";

test("writes appear while arguments are still generating; one call advances one node", async () => {
  const events: string[] = [];
  const prep = new CompanionToolPreparation([getCompanionAgentTool("companion_create_note")!], async (call, _tool, status) => { events.push(`${call.id}:${status}`); });
  prep.observe({ id: "write", name: "companion_create_note", index: 0 });
  await Promise.resolve();
  assert.deepEqual(events, ["write:requested"]);
  prep.observe({ id: "write", name: "companion_create_note", index: 0 });
  await prep.finish([{ id: "write", name: "companion_create_note" }]);
  assert.deepEqual(events, ["write:requested"], "completion belongs to the validated executor");
});

test("incomplete and replaced attempts end as not executed; reads and unknown names have no preview", async () => {
  const events: string[] = [];
  const prep = new CompanionToolPreparation([getCompanionAgentTool("companion_edit_note")!, getCompanionAgentTool("companion_read_note")!], async (call, _tool, status) => { events.push(`${call.id}:${status}`); });
  prep.observe({ id: "read", name: "companion_read_note", index: 0 });
  prep.observe({ id: "unknown", name: "made_up_write", index: 0 });
  prep.observe({ id: "interrupted", name: "companion_edit_note", index: 1 });
  await prep.finish([{ id: "replacement", name: "companion_edit_note" }]);
  assert.deepEqual(events, ["interrupted:requested", "interrupted:not_executed"]);
});

test("tools share the run deadline; nested model calls use the actual provider policy", () => {
  const quick = companionToolExecutionTimeout(getCompanionAgentTool("companion_read_note")!);
  const write = companionToolExecutionTimeout(getCompanionAgentTool("companion_edit_note")!);
  const image = companionToolExecutionTimeout(getCompanionAgentTool("companion_read_image")!);
  assert.equal(quick, write);
  assert.ok(write > 60_000);
  assert.ok(image > 60_000 && image < write);
});
