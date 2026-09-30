import { test } from "node:test";
import assert from "node:assert/strict";
import { taskEntityFromPersistedPageContext } from "../companion-task-memory.ts";

const UUID_A = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";
const UUID_B = "1f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";

test("learning_run 页 → 绑定 learning_run:runId（39b C8）", () => {
  assert.deepEqual(
    taskEntityFromPersistedPageContext({ context: { pageKind: "learning_run", runId: UUID_A, taskId: UUID_B } }),
    { entityType: "learning_run", entityId: UUID_A },
  );
});

test("card/review 页 → 绑定 card:cardId", () => {
  assert.deepEqual(
    taskEntityFromPersistedPageContext({ context: { pageKind: "card", cardId: UUID_A } }),
    { entityType: "card", entityId: UUID_A },
  );
  assert.deepEqual(
    taskEntityFromPersistedPageContext({ context: { pageKind: "review", cardId: UUID_B, keyPointId: UUID_A } }),
    { entityType: "card", entityId: UUID_B },
  );
});

test("推不出身份的场景一律 null：非任务页 / 缺 id / id 不是 uuid / 形状不对", () => {
  assert.equal(taskEntityFromPersistedPageContext({ context: { pageKind: "today" } }), null);
  assert.equal(taskEntityFromPersistedPageContext({ context: { pageKind: "note" } }), null);
  assert.equal(taskEntityFromPersistedPageContext({ context: { pageKind: "learning_run" } }), null);
  assert.equal(taskEntityFromPersistedPageContext({ context: { pageKind: "card", cardId: "not-a-uuid" } }), null);
  assert.equal(taskEntityFromPersistedPageContext({ context: null }), null);
  assert.equal(taskEntityFromPersistedPageContext(null), null);
  assert.equal(taskEntityFromPersistedPageContext("not-an-object"), null);
  assert.equal(taskEntityFromPersistedPageContext(undefined), null);
});
