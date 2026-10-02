import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import { seedV2Fixture, type V2FixtureSeeded } from "./helpers/v2-card-fixture.ts";
import { closeDatabase } from "../db/client.ts";
import { authRoutes } from "../modules/identity/routes.ts";
import { issueSession } from "../modules/identity/service.ts";
import { noteAnnotationRoutes } from "../modules/note-annotations/routes.ts";
import { noteExpansionRoutes } from "../modules/note-expansions/routes.ts";
import { noteOverviewRoutes } from "../modules/note-overviews/routes.ts";
import { noteRecallRoutes } from "../modules/note-recalls/routes.ts";
import { noteLearningArtifactRoutes } from "../modules/note-learning-artifacts/routes.ts";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });
testDatabaseUrl("DATABASE_URL_API");

type Fixture = V2FixtureSeeded;
type AssistantReplyInput = {
  workspaceId: string;
  userId: string;
  noteId: string;
  noteVersionId: string;
  selectionText?: string;
  answer?: string;
};
type AssistantReply = { conversationId: string; messageId: string };

let fixture: Fixture;
let foreign: Fixture;
let memberId: string;
let memberToken: string;
const app = Fastify({ logger: false });
const path = (noteId = fixture.noteId) => `/v2/notes/${noteId}`;
const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object, token = fixture.token) => app.inject({
  method,
  url,
  payload,
  headers: { authorization: `Bearer ${token}` },
});

async function seedNoteText(note: Fixture) {
  const blocks = [
    { ordinal: 1, type: "heading", content: "复利是什么" },
    { ordinal: 2, type: "paragraph", content: "利息加入本金后，下一次也会继续产生利息。" },
    { ordinal: 3, type: "heading", content: "为什么会增长" },
    { ordinal: 4, type: "paragraph", content: "每一轮新增的利息都会参与下一轮计算。" },
  ];
  const content = { blocks: blocks.map(({ type, content }) => ({ type, content })) };
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${note.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${note.userId}, true)`;
    await tx`UPDATE notes SET current_version_id=${note.noteVersionId},share_scope='shared' WHERE id=${note.noteId}`;
    await tx`UPDATE note_versions SET content_json=${tx.json(content)} WHERE id=${note.noteVersionId}`;
    await tx`DELETE FROM note_blocks WHERE workspace_id=${note.workspaceId} AND version_id=${note.noteVersionId}`;
    for (const block of blocks) {
      await tx`INSERT INTO note_blocks(workspace_id,version_id,ordinal,type,content)
        VALUES(${note.workspaceId},${note.noteVersionId},${block.ordinal},${block.type},${block.content})`;
    }
  });
}

async function seedAssistantReply(input: AssistantReplyInput): Promise<AssistantReply> {
  const conversationId = randomUUID();
  const userMessageId = randomUUID();
  const runId = randomUUID();
  const assistantMessageId = randomUUID();
  const prompt = "请围绕我选中的原句解释。";
  const answer = input.answer ?? "这句话表示新增利息会进入下一轮的本金计算。";
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const pageContext = {
    version: 1,
    context: {
      pageKind: "note",
      sharing: "page_registered",
      noteId: input.noteId,
      noteVersionId: input.noteVersionId,
    },
    ...(input.selectionText ? { selection: { text: input.selectionText, sharing: "user_selected" } } : {}),
  };
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${input.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${input.userId}, true)`;
    await tx`INSERT INTO companion_conversations
      (id,workspace_id,user_id,kind,title,title_source,status)
      VALUES(${conversationId},${input.workspaceId},${input.userId},'dialogue','笔记学习','system','active')`;
    await tx`INSERT INTO companion_messages
      (id,conversation_id,workspace_id,user_id,seq,role,kind,blocks,client_message_id,content_sha256)
      VALUES(${userMessageId},${conversationId},${input.workspaceId},${input.userId},1,'user','text',
        ${tx.json([{ type: "text", text: prompt }])},${randomUUID()},${hash(prompt)})`;
    await tx`INSERT INTO companion_turn_runs
      (id,conversation_id,workspace_id,user_id,user_message_id,generation,status,idempotency_key_hash,
       request_body_hash,page_context,started_at,finished_at)
      VALUES(${runId},${conversationId},${input.workspaceId},${input.userId},${userMessageId},1,'succeeded',
        ${hash(runId)},${hash(`${runId}:body`)},${tx.json(pageContext)},now(),now())`;
    await tx`INSERT INTO companion_messages
      (id,conversation_id,workspace_id,user_id,seq,role,kind,blocks,run_id,content_sha256)
      VALUES(${assistantMessageId},${conversationId},${input.workspaceId},${input.userId},2,'assistant','text',
        ${tx.json([{ type: "text", text: answer }])},${runId},${hash(answer)})`;
    await tx`UPDATE companion_turn_runs SET assistant_message_id=${assistantMessageId} WHERE id=${runId}`;
  });
  return { conversationId, messageId: assistantMessageId };
}

async function seedCompletedExpansionTask(input: {
  workspaceId: string;
  userId: string;
  noteId: string;
  noteVersionId: string;
  taskId: string;
  requestId: string;
  source: AssistantReply;
  drafts: Array<{
    candidateId: string;
    requestId: string;
    title: string;
    relationship: string;
    sourceReferences: Array<{ blockOrdinal: number; quote: string }>;
    blocks: Array<{ type: "paragraph" | "heading" | "code" | "list" | "quote"; content: string }>;
    selected: boolean;
  }>;
}) {
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${input.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${input.userId}, true)`;
    await tx`UPDATE jobs SET status='succeeded',started_at=COALESCE(started_at,now()),finished_at=now()
      WHERE id=${input.taskId} AND workspace_id=${input.workspaceId}`;
    await tx`INSERT INTO note_expansion_tasks
      (id,workspace_id,user_id,note_id,note_version_id,request_id,source_message_id,conversation_id,drafts)
      VALUES(${input.taskId},${input.workspaceId},${input.userId},${input.noteId},${input.noteVersionId},${input.requestId},
        ${input.source.messageId},${input.source.conversationId},${tx.json(input.drafts)})`;
  });
}

async function seedCompletedOverviewTask(input: {
  workspaceId: string;
  userId: string;
  noteId: string;
  noteVersionId: string;
  taskId: string;
}) {
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${input.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${input.userId}, true)`;
    await tx`UPDATE jobs SET status='succeeded',started_at=COALESCE(started_at,now()),finished_at=now()
      WHERE id=${input.taskId} AND workspace_id=${input.workspaceId}`;
    await tx`INSERT INTO note_overviews
      (workspace_id,user_id,note_id,note_version_id,body,source_references,coverage,generation_job_id)
      VALUES(${input.workspaceId},${input.userId},${input.noteId},${input.noteVersionId},
        '复利会把新利息放回本金，让它在下一轮继续产生利息。',
        ${tx.json([{ blockOrdinal: 2, quote: "利息加入本金后，下一次也会继续产生利息。" }])},
        ${tx.json({ totalBlocks: 4, textBlocksRead: 4, imageBlocksNotRead: 0 })},${input.taskId})`;
  });
}

before(async () => {
  fixture = await seedV2Fixture(admin);
  foreign = await seedV2Fixture(admin);
  await seedNoteText(fixture);
  await seedNoteText(foreign);

  memberId = randomUUID();
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${fixture.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${fixture.userId}, true)`;
    await tx`INSERT INTO users(id,email,password_hash,role)
      VALUES(${memberId},${`note-companion-${memberId}@example.test`},'test-hash','member')`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role)
      VALUES(${fixture.workspaceId},${memberId},'member')`;
  });
  memberToken = (await issueSession(memberId, fixture.workspaceId)).token;

  await app.register(sensible);
  await app.register(authRoutes);
  await app.register(noteAnnotationRoutes);
  await app.register(noteExpansionRoutes);
  await app.register(noteOverviewRoutes);
  await app.register(noteRecallRoutes);
  await app.register(noteLearningArtifactRoutes);
  await app.ready();
});

after(async () => {
  try {
    await app.close();
    await fixture?.cleanup();
    await foreign?.cleanup();
    if (memberId) await admin`DELETE FROM users WHERE id=${memberId}`;
  } finally {
    await closeDatabase();
    await admin.end();
  }
});

test("速看独立走后台任务；任务完成后可按原文依据重开", async () => {
  const requestId = randomUUID();
  const request = { noteVersionId: fixture.noteVersionId, requestId };
  const created = await call("POST", `${path()}/overview-tasks`, request);
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().status, "queued");
  assert.equal(created.json().overview, null);

  const replay = await call("POST", `${path()}/overview-tasks`, request);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().taskId, created.json().taskId);

  const foreignVersion = await call("POST", `${path()}/overview-tasks`, {
    noteVersionId: foreign.noteVersionId,
    requestId: randomUUID(),
  });
  assert.equal(foreignVersion.statusCode, 409);
  assert.equal(foreignVersion.json().error, "note_version_not_found");

  await seedCompletedOverviewTask({
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    noteId: fixture.noteId,
    noteVersionId: fixture.noteVersionId,
    taskId: created.json().taskId,
  });

  const ready = await call("GET", `${path()}/overview-tasks/${created.json().taskId}`);
  assert.equal(ready.statusCode, 200, ready.body);
  assert.equal(ready.json().status, "ready");
  assert.equal(ready.json().overview.sourceMessageId, null);
  assert.deepEqual(ready.json().overview.references, [{ blockOrdinal: 2, quote: "利息加入本金后，下一次也会继续产生利息。" }]);

  const history = await call("GET", `${path()}/overviews`);
  assert.equal(history.statusCode, 200, history.body);
  assert.equal(history.json().items[0].overviewId, ready.json().overview.overviewId);
  assert.equal(history.json().items[0].body, ready.json().overview.body);

  const hidden = await call("GET", `${path()}/overview-tasks/${created.json().taskId}`, undefined, memberToken);
  assert.equal(hidden.statusCode, 404);
});

test("整篇互动演示走持久后台任务；请求重放读取同一任务", async () => {
  const requestId = randomUUID();
  const request = { noteVersionId: fixture.noteVersionId, requestId, sourceKind: "overview" };
  const created = await call("POST", `${path()}/learning-artifact-tasks`, request);
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().status, "queued");
  assert.equal(created.json().sourceKind, "overview");
  assert.equal(created.json().artifact, null);

  const replay = await call("POST", `${path()}/learning-artifact-tasks`, request);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().taskId, created.json().taskId);

  const tasks = await call("GET", `${path()}/learning-artifact-tasks?noteVersionId=${fixture.noteVersionId}`);
  assert.equal(tasks.statusCode, 200, tasks.body);
  assert.equal(tasks.json().items[0].taskId, created.json().taskId);
  assert.equal(tasks.json().items[0].status, "queued");

  const artifacts = await call("GET", `${path()}/learning-artifacts`);
  assert.equal(artifacts.statusCode, 200, artifacts.body);
  assert.deepEqual(artifacts.json().items, []);

  const hidden = await call("GET", `${path()}/learning-artifact-tasks/${created.json().taskId}`, undefined, memberToken);
  assert.equal(hidden.statusCode, 404);
});

test("互动演示任务不能跨笔记挂接另一版正文", async () => {
  const forged = await call("POST", `${path()}/learning-artifact-tasks`, {
    noteVersionId: foreign.noteVersionId,
    requestId: randomUUID(),
    sourceKind: "overview",
  });
  assert.equal(forged.statusCode, 409);
  assert.equal(forged.json().error, "note_version_not_found");
});

test("局部互动演示在入队前核对精确选区，并把选区写进任务记录", async () => {
  const excerpt = "利息加入本金后";
  const selectionAnchor = {
    noteVersionId: fixture.noteVersionId,
    startBlockOrdinal: 2,
    startOffset: 0,
    endBlockOrdinal: 2,
    endOffset: excerpt.length,
    excerpt,
    prefix: "",
    suffix: "，下一次也会继续产生利息。",
  };
  const created = await call("POST", `${path()}/learning-artifact-tasks`, {
    noteVersionId: fixture.noteVersionId,
    requestId: randomUUID(),
    sourceKind: "annotation",
    selectionAnchor,
  });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().status, "queued");
  assert.deepEqual(created.json().selectionAnchor, selectionAnchor);

  const wrongOffset = await call("POST", `${path()}/learning-artifact-tasks`, {
    noteVersionId: fixture.noteVersionId,
    requestId: randomUUID(),
    sourceKind: "annotation",
    selectionAnchor: { ...selectionAnchor, startOffset: 1, endOffset: excerpt.length + 1 },
  });
  assert.equal(wrongOffset.statusCode, 409);
  assert.equal(wrongOffset.json().error, "selection_anchor_mismatch");
});

test("跨段批注保存完整范围，解释任务使用同一选区，错误的中间段不能入队", async () => {
  const first = "利息加入本金后，下一次也会继续产生利息。", last = "每一轮新增的利息都会参与下一轮计算。";
  const anchor = { noteVersionId: fixture.noteVersionId, startBlockOrdinal: 2, endBlockOrdinal: 4, startOffset: 4, endOffset: 8,
    excerpt: [first.slice(4), "为什么会增长", last.slice(0, 8)].join("\n\n"), prefix: first.slice(0, 4), suffix: last.slice(8) };
  const created = await call("POST", `${path()}/annotations`, { anchor, explanation: "前段说明利息并入本金，后段说明下一轮以新的本金计算。" });
  assert.equal(created.statusCode, 200, created.body); assert.deepEqual(created.json().anchor, anchor);
  const reopened = await call("GET", `${path()}/annotations`);
  assert.ok(reopened.json().items.some((item: { annotationId: string }) => item.annotationId === created.json().annotationId));
  const started = await call("POST", `${path()}/annotation-tasks`, { anchor, requestId: randomUUID() });
  assert.equal(started.statusCode, 200, started.body); assert.deepEqual(started.json().anchor, anchor);
  const wrong = await call("POST", `${path()}/annotation-tasks`, { anchor: { ...anchor, excerpt: anchor.excerpt.replace("为什么会增长", "另一个标题") }, requestId: randomUUID() });
  assert.equal(wrong.statusCode, 409, wrong.body); assert.equal(wrong.json().error, "note_anchor_mismatch");
});

test("选区批注锚定精确原句、按修订更新，且不能伪造选区来源", async () => {
  const excerpt = "利息加入本金后";
  const reply = await seedAssistantReply({
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    noteId: fixture.noteId,
    noteVersionId: fixture.noteVersionId,
    selectionText: excerpt,
  });
  const anchor = {
    noteVersionId: fixture.noteVersionId,
    startBlockOrdinal: 2,
    startOffset: 0,
    endBlockOrdinal: 2,
    endOffset: excerpt.length,
    excerpt,
    prefix: "",
    suffix: "，下一次也会继续产生利息。",
  };
  const created = await call("POST", `${path()}/annotations`, {
    anchor,
    explanation: "新增的利息也会成为下一轮计算的本金。",
    sourceMessageId: reply.messageId,
  });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().anchor.excerpt, excerpt);
  assert.equal(created.json().revision, 1);

  const wrongAnchor = await call("POST", `${path()}/annotations`, {
    anchor: { ...anchor, startOffset: 1, endOffset: excerpt.length + 1 },
    explanation: "不能把这条解释挂到相邻的字上。",
    sourceMessageId: reply.messageId,
  });
  assert.equal(wrongAnchor.statusCode, 409);
  assert.equal(wrongAnchor.json().error, "note_anchor_mismatch");

  const updated = await call("PATCH", `${path()}/annotations/${created.json().annotationId}`, {
    expectedRevision: 1,
    explanation: "把利息放回本金里，再继续计算。",
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().revision, 2);
  const stale = await call("PATCH", `${path()}/annotations/${created.json().annotationId}`, {
    expectedRevision: 1,
    explanation: "过期页面不能覆盖新内容。",
  });
  assert.equal(stale.statusCode, 409);

  const badSelectionReply = await seedAssistantReply({
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    noteId: fixture.noteId,
    noteVersionId: fixture.noteVersionId,
    selectionText: "另一句原文",
  });
  const forged = await call("POST", `${path()}/annotations`, {
    anchor,
    explanation: "不能挂到未提供给伴星的句子上。",
    sourceMessageId: badSelectionReply.messageId,
  });
  assert.equal(forged.statusCode, 409);
  assert.equal(forged.json().error, "source_message_not_found");
});

test("回想不用伴星也能从原文开始，线索、揭示和自述会留存", async () => {
  const started = await call("POST", `${path()}/recalls`, {
    requestId: randomUUID(),
    noteVersionId: fixture.noteVersionId,
  });
  assert.equal(started.statusCode, 200, started.body);
  assert.match(started.json().question, /利息加入＿＿＿后/);
  assert.equal(started.json().sectionOrdinal, 3);
  assert.equal(started.json().sourceMessageId, null);
  assert.equal("answer" in started.json(), false);

  const hinted = await call("POST", `${path()}/recalls/${started.json().recallId}/actions`, { kind: "hint" });
  assert.equal(hinted.statusCode, 200, hinted.body);
  assert.match(hinted.json().hint, /下一次也会继续产生利息/);
  assert.doesNotMatch(hinted.json().hint, /本金/);
  assert.equal(hinted.json().hintSourceMessageId, null);
  assert.equal("answer" in hinted.json(), false);

  const revealed = await call("POST", `${path()}/recalls/${started.json().recallId}/actions`, { kind: "reveal" });
  assert.equal(revealed.statusCode, 200, revealed.body);
  assert.equal(revealed.json().answer, "利息加入本金后，下一次也会继续产生利息。");
  const reported = await call("POST", `${path()}/recalls/${started.json().recallId}/actions`, {
    kind: "self_report", value: "partly",
  });
  assert.equal(reported.statusCode, 200, reported.body);
  assert.equal(reported.json().state, "reported");
  const history = await call("GET", `${path()}/recalls`);
  assert.equal(history.statusCode, 200, history.body);
  assert.ok(history.json().items.some((item: { recallId: string; selfReport: string }) =>
    item.recallId === started.json().recallId && item.selfReport === "partly"));
});

test("回想先藏线索和原文；翻开后才允许记自述，重试不会新造记录", async () => {
  const questionReply = await seedAssistantReply({
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    noteId: fixture.noteId,
    noteVersionId: fixture.noteVersionId,
    answer: "复利下一轮计算时，为什么要把新增的利息也算进去？",
  });
  const hintReply = await seedAssistantReply({
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    noteId: fixture.noteId,
    noteVersionId: fixture.noteVersionId,
    answer: "想一想新增利息已经回到了哪里，再看它怎样参与下一轮计算。",
  });
  const requestId = randomUUID();
  const started = await call("POST", `${path()}/recalls`, {
    requestId,
    noteVersionId: fixture.noteVersionId,
    sourceMessageId: questionReply.messageId,
    conversationId: questionReply.conversationId,
  });
  assert.equal(started.statusCode, 200, started.body);
  assert.equal(started.json().state, "waiting");
  assert.equal(started.json().question, "复利下一轮计算时，为什么要把新增的利息也算进去？");
  assert.equal(started.json().sourceMessageId, questionReply.messageId);
  assert.equal(started.json().conversationId, questionReply.conversationId);
  assert.equal(started.json().sectionOrdinal, 5);
  assert.equal("hint" in started.json(), false);
  assert.equal("answer" in started.json(), false);

  const replay = await call("POST", `${path()}/recalls`, {
    requestId,
    noteVersionId: fixture.noteVersionId,
    sourceMessageId: questionReply.messageId,
    conversationId: questionReply.conversationId,
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().recallId, started.json().recallId);

  const beforeReveal = await call("POST", `${path()}/recalls/${started.json().recallId}/actions`, {
    kind: "self_report", value: "remembered",
  });
  assert.equal(beforeReveal.statusCode, 409);
  assert.equal(beforeReveal.json().error, "not_revealed");

  const hinted = await call("POST", `${path()}/recalls/${started.json().recallId}/actions`, {
    kind: "hint",
    sourceMessageId: hintReply.messageId,
    conversationId: hintReply.conversationId,
  });
  assert.equal(hinted.statusCode, 200, hinted.body);
  assert.equal(hinted.json().hint, "想一想新增利息已经回到了哪里，再看它怎样参与下一轮计算。");
  assert.equal(hinted.json().hintSourceMessageId, hintReply.messageId);
  assert.equal(hinted.json().hintConversationId, hintReply.conversationId);
  assert.equal("answer" in hinted.json(), false);

  const revealed = await call("POST", `${path()}/recalls/${started.json().recallId}/actions`, { kind: "reveal" });
  assert.equal(revealed.statusCode, 200, revealed.body);
  assert.equal(revealed.json().answer, "每一轮新增的利息都会参与下一轮计算。");
  const reported = await call("POST", `${path()}/recalls/${started.json().recallId}/actions`, {
    kind: "self_report", value: "partly", reflection: "记起了利息会继续生息。",
  });
  assert.equal(reported.statusCode, 200, reported.body);
  assert.equal(reported.json().state, "reported");

  const history = await call("GET", `${path()}/recalls`);
  assert.equal(history.statusCode, 200, history.body);
  assert.equal(history.json().items[0].recallId, started.json().recallId);
  assert.equal(history.json().items[0].selfReport, "partly");
});

test("拓展笔记由后台任务整理；审核、确认和失败回滚都留有可追溯记录", async () => {
  const reply = await seedAssistantReply({
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    noteId: fixture.noteId,
    noteVersionId: fixture.noteVersionId,
  });
  const requestId = randomUUID();
  const taskRequest = {
    noteVersionId: fixture.noteVersionId,
    requestId,
    sourceMessageId: reply.messageId,
    conversationId: reply.conversationId,
  };
  const started = await call("POST", `${path()}/expansion-tasks`, taskRequest);
  assert.equal(started.statusCode, 200, started.body);
  assert.equal(started.json().status, "queued");
  const taskId = started.json().taskId as string;
  const startReplay = await call("POST", `${path()}/expansion-tasks`, taskRequest);
  assert.equal(startReplay.statusCode, 200, startReplay.body);
  assert.equal(startReplay.json().taskId, taskId, "相同请求编号应继续指向同一条后台任务");
  const drafts = [{
    candidateId: randomUUID(),
    requestId: randomUUID(),
    title: "利息如何继续生息",
    relationship: "这篇拓展说明新增利息怎样进入下一轮计算。",
    sourceReferences: [{ blockOrdinal: 2, quote: "利息加入本金后，下一次也会继续产生利息。" }],
    blocks: [
      { type: "heading" as const, content: "从一轮到下一轮" },
      { type: "paragraph" as const, content: "把新增的利息加入本金后，下一轮会根据新的总额计算利息。" },
    ],
    selected: false,
  }, {
    candidateId: randomUUID(),
    requestId: randomUUID(),
    title: "利息和本金",
    relationship: "这篇拓展补充本金与利息之间的关系。",
    sourceReferences: [{ blockOrdinal: 2, quote: "利息加入本金后，下一次也会继续产生利息。" }],
    blocks: [
      { type: "paragraph" as const, content: "本金是计算利息的起点。" },
      { type: "paragraph" as const, content: "利息加入后会形成新的总额。" },
    ],
    selected: false,
  }];
  await seedCompletedExpansionTask({
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    noteId: fixture.noteId,
    noteVersionId: fixture.noteVersionId,
    taskId,
    requestId,
    source: reply,
    drafts,
  });

  const review = await call("PUT", `${path()}/expansion-tasks/${taskId}/drafts`, {
    drafts: drafts.map(({ candidateId, title, blocks }) => ({ candidateId, title, blocks, selected: true })),
  });
  assert.equal(review.statusCode, 200, review.body);
  assert.equal(review.json().status, "ready");
  const candidateIds = drafts.map((draft) => draft.candidateId);
  const created = await call("POST", `${path()}/expansion-tasks/${taskId}/confirm`, { candidateIds });
  assert.equal(created.statusCode, 200, created.body);
  const createdExpansions = created.json() as Array<{ expansionId: string; expandedNoteId: string; direction: string; sourceNoteId: string }>;
  assert.equal(createdExpansions.length, 2);
  assert.equal(createdExpansions[0]?.direction, "expanded_from_here");
  assert.equal(createdExpansions[0]?.sourceNoteId, fixture.noteId);

  const sourceHistory = await call("GET", `${path()}/expansions`);
  assert.equal(sourceHistory.statusCode, 200, sourceHistory.body);
  assert.equal(sourceHistory.json().items.length, 2);
  assert.deepEqual(
    new Set(sourceHistory.json().items.map((item: { expandedNoteId: string }) => item.expandedNoteId)),
    new Set(createdExpansions.map((item) => item.expandedNoteId)),
  );

  const expandedHistory = await call("GET", `${path(createdExpansions[0]!.expandedNoteId)}/expansions`);
  assert.equal(expandedHistory.statusCode, 200, expandedHistory.body);
  assert.equal(expandedHistory.json().items[0].direction, "source_note");
  assert.equal(expandedHistory.json().items[0].sourceNoteId, fixture.noteId);

  const replay = await call("POST", `${path()}/expansion-tasks/${taskId}/confirm`, { candidateIds });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(
    (replay.json() as typeof createdExpansions).map((item) => item.expansionId),
    createdExpansions.map((item) => item.expansionId),
  );
  assert.deepEqual(
    (replay.json() as typeof createdExpansions).map((item) => item.expandedNoteId),
    createdExpansions.map((item) => item.expandedNoteId),
  );

  const conflictRequestId = randomUUID();
  const conflictTask = await call("POST", `${path()}/expansion-tasks`, {
    noteVersionId: fixture.noteVersionId,
    requestId: conflictRequestId,
    sourceMessageId: reply.messageId,
    conversationId: reply.conversationId,
  });
  assert.equal(conflictTask.statusCode, 200, conflictTask.body);
  const conflictTaskId = conflictTask.json().taskId as string;
  const conflictingDrafts = [{
    ...drafts[0]!,
    candidateId: randomUUID(),
    requestId: randomUUID(),
    title: "这篇必须随事务一起回滚",
    selected: false,
  }, {
    ...drafts[1]!,
    candidateId: randomUUID(),
    requestId: drafts[0]!.requestId,
    selected: false,
  }];
  await seedCompletedExpansionTask({
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    noteId: fixture.noteId,
    noteVersionId: fixture.noteVersionId,
    taskId: conflictTaskId,
    requestId: conflictRequestId,
    source: reply,
    drafts: conflictingDrafts,
  });
  const conflictReview = await call("PUT", `${path()}/expansion-tasks/${conflictTaskId}/drafts`, {
    drafts: conflictingDrafts.map(({ candidateId, title, blocks }) => ({ candidateId, title, blocks, selected: true })),
  });
  assert.equal(conflictReview.statusCode, 200, conflictReview.body);
  const conflict = await call("POST", `${path()}/expansion-tasks/${conflictTaskId}/confirm`, {
    candidateIds: conflictingDrafts.map((draft) => draft.candidateId),
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, "idempotency_conflict");
  const afterConflict = await call("GET", `${path()}/expansions`);
  assert.equal(afterConflict.json().items.length, 2, "确认中途冲突时整批新笔记和关联都应回滚");
});

test("共享笔记上的学习记录按创建者私有，撤销共享后不可继续读取", async () => {
  const reply = await seedAssistantReply({
    workspaceId: fixture.workspaceId,
    userId: memberId,
    noteId: fixture.noteId,
    noteVersionId: fixture.noteVersionId,
    selectionText: "利息加入本金后",
  });
  const created = await call("POST", `${path()}/annotations`, {
    anchor: {
      noteVersionId: fixture.noteVersionId,
      startBlockOrdinal: 2,
      startOffset: 0,
      endBlockOrdinal: 2,
      endOffset: "利息加入本金后".length,
      excerpt: "利息加入本金后",
      prefix: "",
      suffix: "，下一次也会继续产生利息。",
    },
    explanation: "只留给这位成员自己的批注。",
    sourceMessageId: reply.messageId,
  }, memberToken);
  assert.equal(created.statusCode, 200, created.body);
  const ownerItems = (await call("GET", `${path()}/annotations`)).json().items as Array<{ explanation: string }>;
  assert.ok(!ownerItems.some((item) => item.explanation === "只留给这位成员自己的批注。"));
  const memberItems = (await call("GET", `${path()}/annotations`, undefined, memberToken)).json().items as Array<{ explanation: string }>;
  assert.deepEqual(memberItems.map((item) => item.explanation), ["只留给这位成员自己的批注。"]);

  await admin`UPDATE notes SET share_scope='private' WHERE id=${fixture.noteId}`;
  const denied = await call("GET", `${path()}/annotations`, undefined, memberToken);
  assert.equal(denied.statusCode, 404);
  assert.ok(!denied.body.includes("只留给这位成员自己的批注"));
  await admin`UPDATE notes SET share_scope='shared' WHERE id=${fixture.noteId}`;
});

test("收下一篇后其余草稿仍可编辑并分次确认；每篇重试只返回原回执", async () => {
  const source = await seedAssistantReply({ workspaceId: fixture.workspaceId, userId: fixture.userId,
    noteId: fixture.noteId, noteVersionId: fixture.noteVersionId });
  const requestId = randomUUID();
  const started = await call("POST", `${path()}/expansion-tasks`, {
    noteVersionId: fixture.noteVersionId, requestId, sourceMessageId: source.messageId, conversationId: source.conversationId,
  });
  assert.equal(started.statusCode, 200, started.body);
  const taskId = started.json().taskId as string;
  const drafts = [1, 2, 3].map(n => ({ candidateId: randomUUID(), requestId: randomUUID(), title: `分次收下 ${n}`,
    relationship: "从利息加入本金后的计算方式继续学习。",
    sourceReferences: [{ blockOrdinal: 2, quote: "利息加入本金后，下一次也会继续产生利息。" }],
    blocks: [{ type: "paragraph" as const, content: `第 ${n} 篇独立保留的草稿。` }], selected: false }));
  await seedCompletedExpansionTask({ workspaceId: fixture.workspaceId, userId: fixture.userId, noteId: fixture.noteId,
    noteVersionId: fixture.noteVersionId, taskId, requestId, source, drafts });

  const receipts: Array<{ expansionId: string; expandedNoteId: string }> = [];
  for (let index = 0; index < drafts.length; index++) {
    const draft = drafts[index]!;
    draft.title += "，已认真编辑";
    draft.blocks = [{ type: "paragraph", content: `改好后再收下的第 ${index + 1} 篇。` }];
    draft.selected = true;
    const review = await call("PUT", `${path()}/expansion-tasks/${taskId}/drafts`, {
      drafts: drafts.map(({ candidateId, title, blocks, selected }) => ({ candidateId, title, blocks, selected })),
    });
    assert.equal(review.statusCode, 200, review.body);
    assert.equal(review.json().status, "ready", "上一篇确认不能锁死剩余草稿");
    const confirmed = await call("POST", `${path()}/expansion-tasks/${taskId}/confirm`, { candidateIds: [draft.candidateId] });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(confirmed.json().length, 1);
    receipts.push(confirmed.json()[0]);
    const reloaded = await call("GET", `${path()}/expansion-tasks/${taskId}`);
    assert.equal(reloaded.statusCode, 200, reloaded.body);
    assert.equal(reloaded.json().status, index === 2 ? "confirmed" : "ready");
    assert.deepEqual(new Set(reloaded.json().confirmedCandidateIds), new Set(drafts.slice(0, index + 1).map(item => item.candidateId)));
    assert.equal(reloaded.json().drafts[index].title, draft.title);

    const replay = await call("POST", `${path()}/expansion-tasks/${taskId}/confirm`, { candidateIds: [drafts[0]!.candidateId] });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json()[0].expansionId, receipts[0]!.expansionId);
    assert.equal(replay.json()[0].expandedNoteId, receipts[0]!.expandedNoteId);
  }
  assert.equal(new Set(receipts.map(item => item.expandedNoteId)).size, 3);
  const history = await call("GET", `${path()}/expansions`);
  const created = history.json().items.filter((item: { sourceTaskId: string }) => item.sourceTaskId === taskId);
  assert.equal(created.length, 3, "分次确认和重试不能重复创建笔记");
  const overwritten = await call("PUT", `${path()}/expansion-tasks/${taskId}/drafts`, {
    drafts: drafts.map(({ candidateId, title, blocks, selected }, index) => ({ candidateId, title: index ? title : "覆盖已收下正文", blocks, selected })),
  });
  assert.equal(overwritten.statusCode, 409);
  assert.equal(overwritten.json().error, "task_already_confirmed");
});
