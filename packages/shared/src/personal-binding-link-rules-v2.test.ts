/**
 * 「本人确认的目标关联」判据的单测（39d W5-6 刀六；39 §4.2）。
 *
 * 这一份判据存在的主要理由是一句**否定**：不按指纹自动关联。
 * `computeSemanticTargetFingerprintV2`（`card-generation-v2-hashing.ts:29`）的输入含
 * `objectiveId`，而本人绑定建立那一刻没有 `objectiveId`——所以"指纹相等"在数据面上
 * 根本不可能成立。钉这条是为了让下一个改它的人知道：**这不是"还没做"，是"做不了"**，
 * 要换成自动关联必须先换判据本身（那就得改 0234 那套口径，不是这里能顺手加的）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bindingLinkEvidenceV2,
  bindingLinkWritesOnlyLinkV2,
  decideBindingLinkV2,
  type BindingLinkCandidateV2,
} from "./personal-binding-link-rules-v2.ts";

const NOTE = "3b0f1a52-0000-4000-8000-0000000000aa";
const VERSION = "3b0f1a52-0000-4000-8000-0000000000bb";
const OTHER_NOTE = "3b0f1a52-0000-4000-8000-0000000000cc";
const OTHER_VERSION = "3b0f1a52-0000-4000-8000-0000000000dd";
const OBJ = "3b0f1a52-0000-4000-8000-0000000000ee";

const candidate: BindingLinkCandidateV2 = {
  objectiveId: OBJ,
  objectiveRevisionId: "3b0f1a52-0000-4000-8000-0000000000ff",
  objectiveRevision: 1,
  objectiveStatement: "能说清为什么加了索引查询仍然可能慢",
  conceptLabel: "索引与顺序扫描",
};

function decide(overrides: Partial<Parameters<typeof decideBindingLinkV2>[0]> = {}) {
  return decideBindingLinkV2({
    bindingLive: true,
    alreadyLinkedObjectiveId: null,
    candidate,
    bindingNoteId: NOTE,
    bindingNoteVersionId: VERSION,
    candidateNoteId: NOTE,
    candidateNoteVersionId: VERSION,
    confirmedByUser: true,
    ...overrides,
  });
}

test("同篇同版 + 本人确认 ⇒ 可以关联", () => {
  assert.deepEqual(decide(), { allowed: true });
});

test("没有本人这一下就不成立（§4.2「不按标题相似自动继承」）", () => {
  assert.deepEqual(
    decide({ confirmedByUser: false }),
    { allowed: false, reasonCode: "needs_confirmation" },
  );
});

test("换一篇或换一版都不成立：那是伪造血缘，不是关联", () => {
  assert.deepEqual(
    decide({ candidateNoteId: OTHER_NOTE }),
    { allowed: false, reasonCode: "not_same_note_version" },
  );
  assert.deepEqual(
    decide({ candidateNoteVersionId: OTHER_VERSION }),
    { allowed: false, reasonCode: "not_same_note_version" },
  );
});

test("一条绑定至多链一个目标；重复调用交回既有那个，不是改指", () => {
  assert.deepEqual(
    decide({ alreadyLinkedObjectiveId: "3b0f1a52-0000-4000-8000-0000000000a1" }),
    { allowed: false, reasonCode: "already_linked" },
  );
});

test("已撤下的绑定不参与关联（历史留着，但不再生效）", () => {
  assert.deepEqual(
    decide({ bindingLive: false }),
    { allowed: false, reasonCode: "binding_not_live" },
  );
});

test("闸的顺序：先看数据事实，最后才看人的动作", () => {
  // 撤下 + 未确认 ⇒ 报"已撤下"，不是"需要确认"——对界面要说不同的话，
  // 而且"先问事实再问人"让日志里出现的第一个原因总是可复现的那一个。
  assert.deepEqual(
    decide({ bindingLive: false, confirmedByUser: false }),
    { allowed: false, reasonCode: "binding_not_live" },
  );
  // 已链 + 未确认 ⇒ 报"已链"。
  assert.deepEqual(
    decide({ alreadyLinkedObjectiveId: "3b0f1a52-0000-4000-8000-0000000000a1", confirmedByUser: false }),
    { allowed: false, reasonCode: "already_linked" },
  );
});

test("关联只写那两列：不复制、不迁入任何学习表现（§4.2）", () => {
  const writes = bindingLinkWritesOnlyLinkV2();
  assert.equal(writes.writesLinkedObjectiveId, true);
  assert.equal(writes.writesLinkEvidence, true);
  // 这三条是常量判据，不是判断：哪天它们能返回 true，§4.2 就破了，
  // 而那种破损在集成测试里很难看出来，所以让它在单测里一眼可见。
  assert.equal(writes.copiesPerformanceRecords, false);
  assert.equal(writes.writesReviewSchedules, false);
  assert.equal(writes.writesEvidenceTable, false);
});

test("判据快照记的是「同篇同版 + 本人确认」，不是指纹相等", () => {
  const { objectiveId, evidence } = bindingLinkEvidenceV2({
    objectiveId: OBJ,
    objectiveRevisionId: candidate.objectiveRevisionId,
    objectiveRevision: 1,
    noteId: NOTE,
    noteVersionId: VERSION,
    confirmedByUser: true,
  });
  assert.equal(objectiveId, OBJ);
  const e = evidence as Record<string, unknown>;
  // 显式写清判据是哪一种：日后有人看到这一行以为"当时指纹对上了"，就理解错了。
  assert.equal(e.basis, "same_note_version_plus_user_confirmation");
  assert.equal(e.confirmedByUser, true);
  assert.equal(e.noteVersionId, VERSION);
  assert.equal(e.objectiveRevision, 1);
});
