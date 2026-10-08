import assert from "node:assert/strict";
import { test } from "node:test";
import { companionDialoguePurposePolicy } from "../diagnostics/companion-dialogue-frame.ts";
import { resolveDiagnosticCompanionTurn } from "../diagnostics/companion-dialogue-source-binding.ts";

test("记录的用途仍可用于离线比较，完整证据不裁正文，也不进入生产调用", () => {
  const content = "背景🫧\r\n".repeat(400) + "还没交呢，写完而已";
  const result = resolveDiagnosticCompanionTurn({
    intent: "conversation", toolUse: "none", subjects: [], goalRelation: "unrelated",
    candidateOperations: [], ambiguities: [],
    dialogueFrame: { purpose: "correction", evidence: { messageIndex: 0, quote: "还没交呢" },
      userState: [{ topic: "报告", aspect: "progress", relation: "correction", messageIndex: 0, quote: "还没交呢，写完而已" }] },
  }, { requestHash: "a".repeat(64), objects: [], capabilities: [],
    dialogueSources: [{ index: 0, role: "user", content }], currentMessageIndex: 0 });
  assert.equal(result.dialogueFrame?.purpose, "correction");
  assert.equal(result.dialogueFrame?.userState[0]?.quote, "还没交呢，写完而已");
  assert.notEqual(companionDialoguePurposePolicy(result.dialogueFrame),
    companionDialoguePurposePolicy({ ...result.dialogueFrame!, purpose: "seeking_help" }));
});
