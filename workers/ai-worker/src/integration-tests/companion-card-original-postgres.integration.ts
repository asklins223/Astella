import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { getCompanionAgentTool, companionContentBlockV1Schema } from "@astella/shared";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { seedFormalAnswerRun } from "./helpers/formal-answer-fixture.ts";
import { executeReadTool } from "../handlers/companion-tool-execution.ts";
import { closeDatabase } from "../db.ts";
import type { ReadContext } from "../handlers/companion-dialogue-store.ts";
import type { AgentEventContext } from "../handlers/companion-read-tools.ts";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });
after(async () => { await admin.end({ timeout: 2 }); await closeDatabase(); });

test("真实卡片工具：完整题面与尾部条件进入模型，富块仍是有上限的展示预览", async () => {
  const taskPrompt = "题面背景".repeat(180) + "最后条件：只比较当前版本，不应用旧版本的结论。";
  const publicSummary = "主题说明".repeat(180) + "最后一个主题限制。";
  const f = await seedFormalAnswerRun(admin, { taskPrompt, publicSummary });
  try {
    const read: ReadContext = { userId: f.userId, runId: randomUUID(), accountEpoch: 0, generation: 1,
      conversationId: randomUUID(), userMessageId: randomUUID(), runStatus: "running", formalAnswerInProgress: false,
      formalAnswerTarget: null, livePageView: null, pageContext: null, groundedTutorContext: null,
      userText: "看看这张卡的题面", recentMessages: [], residentMemories: [], memoryDirectory: [],
      playbookCatalog: [], organizationSurface: null, memoryRefs: [], hereAndNow: null, thisTurnFacts: null,
      factSpans: null, conversationSummary: null, personaProfileRevision: 0, personaExamplesRevision: 0,
      defaultExpressionVersion: "test", petProfile: null, nextMessageSeq: 1, nextEventSeq: 1 };
    const event: AgentEventContext = { read, expiresAt: new Date(Date.now() + 60000).toISOString(),
      constraints: { visionEnabled: false }, ctx: { id: randomUUID(), workspaceId: f.workspaceId,
        requestedBy: f.userId, payload: { runId: read.runId }, leaseToken: "fixture", signal: new AbortController().signal } };
    const result = await executeReadTool(event, getCompanionAgentTool("companion_open_card")!, { cardId: f.cardId });
    const card = result.value.card as { front: string; summary: string };
    assert.ok(card.front === `${publicSummary} — ${taskPrompt}`, "SQL 和模型结果都不能丢尾部");
    assert.equal(card.summary, publicSummary);
    const preview = result.blocks?.find(block => block.type === "card");
    assert.ok(preview && preview.type === "card");
    assert.ok(preview.front.length <= 600);
    assert.ok(companionContentBlockV1Schema.safeParse(preview).success);
    const alias = await executeReadTool(event, getCompanionAgentTool("companion_open_card")!, { cardId: f.objectiveId });
    assert.deepEqual(alias.value.card, result.value.card, "目标别名读取也应保留同一完整题面");
  } finally { await f.cleanup(); }
});
