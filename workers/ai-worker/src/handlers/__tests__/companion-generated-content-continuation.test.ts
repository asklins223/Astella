import assert from "node:assert/strict";
import test from "node:test";
import { getCompanionAgentTool, companionContentBlockV1Schema } from "@astella/shared";
import { diaryBlockDraftSchema } from "../journal/companion-diary-content.ts";
import { companionDiaryRevisionCheckpointV1Schema, diaryRevisionDraft } from "../journal/companion-diary-revision.ts";
import { prepareCompanionToolReview } from "../tools/companion-tool-review.ts";
import { reviewedTargetMatches } from "../agent/companion-reviewed-target.ts";
import { executeReadTool } from "../tools/companion-tool-execution.ts";
import { PgDialect } from "drizzle-orm/pg-core";

test("长日记的成稿、校订输入与检查点保留所有段落和末尾", () => {
  const blocks = Array.from({ length: 45 }, (_, index) => ({ type: "text" as const,
    text: `第 ${index + 1} 段：${"今天的具体记录。".repeat(160)}尾部感想` }));
  const draft = { blocks, digest: "今天的日记" };
  assert.equal(diaryBlockDraftSchema.safeParse(draft).success, false, "草稿合同仍不接收 digest");
  assert.equal(diaryBlockDraftSchema.parse({ blocks }).blocks.length, 45);
  assert.deepEqual(companionDiaryRevisionCheckpointV1Schema.parse(draft), draft);
  assert.deepEqual(diaryRevisionDraft(draft, { embeds: [] } as never), { blocks });
});

test("长流程的参数、工具结果与对话块都保留全部步骤", async () => {
  const definition = getCompanionAgentTool("companion_render_diagram")!;
  const steps = Array.from({ length: 35 }, (_, index) => ({ label: `第 ${index + 1} 步`, detail: "完整条件与操作。".repeat(30) }));
  const result = await executeReadTool({} as never, definition, { title: "完整过程", steps });
  assert.deepEqual(result.value.steps, steps);
  assert.deepEqual(companionContentBlockV1Schema.parse(result.blocks![0]), { type: "diagram", title: "完整过程", steps });
});

test("确认预览保留参数；笔记已经离开时不准备错误目标的改动", async () => {
  const definition = getCompanionAgentTool("companion_set_activeness")!;
  const args = { activeness: "quiet" };
  const review = await prepareCompanionToolReview({ read: { pageContext: null } } as never, definition, args);
  assert.equal(review.arguments, args);
  assert.match(review.preview.markdown!, /安静|quiet/);
  await assert.rejects(prepareCompanionToolReview({ read: { pageContext: null } } as never,
    getCompanionAgentTool("companion_edit_note")!, {
      noteId: "5f0c1a44-1111-4000-8000-000000000001", noteVersionId: "5f0c1a44-1111-4000-8000-000000000002",
      operation: "append", markdown: "完整补充内容",
    }), /请先打开/);
});

test("没有对应调用的已审核目标不能匹配，避免删除后来改过的内容", () => {
  const predicate = reviewedTargetMatches({} as never, undefined, {} as never);
  assert.equal(new PgDialect().sqlToQuery(predicate).sql, "false");
});
