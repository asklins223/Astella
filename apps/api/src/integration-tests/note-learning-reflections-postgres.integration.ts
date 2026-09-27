import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { sql } from "drizzle-orm";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import { seedV2Fixture, seedObjectiveNoteEvidence, type V2FixtureSeeded } from "./helpers/v2-card-fixture.ts";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import { noteLearningRoundRoutes } from "../modules/note-learning-rounds/routes.ts";
import { createTeaching } from "../modules/note-learning-rounds/round-service.ts";
import { authRoutes } from "../modules/identity/routes.ts";
import { noteRoutes } from "../modules/note/routes.ts";
import { issueSession } from "../modules/identity/service.ts";
import { createRunV2, getRunPublicView, submitArtifact } from "../modules/learning-runs/run-service.ts";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });
testDatabaseUrl("DATABASE_URL_API");
process.env.LEARNING_RUN_ENABLED = "true";
let fixture: V2FixtureSeeded;
let foreign: V2FixtureSeeded;
const memberId = randomUUID();
let token: string, memberToken: string, roundId: string, teachingId: string, memberTeachingId: string;
const app = Fastify({ logger: false });
const scope = (userId = fixture.userId) => ({ workspaceId: fixture.workspaceId, userId });
const path = () => `/v2/notes/${fixture.noteId}/learning-reflections`;
const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object, auth = token) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${auth}` } });
async function openAndTeach(userId: string, auth: string) {
  const response = await call("POST", "/v2/note-learning-rounds", { noteId: fixture.noteId }, auth);
  assert.equal(response.statusCode, 201, response.body);
  const round = response.json().round;
  const teaching = await withWorkspaceTransaction(scope(userId), tx => createTeaching(tx, scope(userId), {
    roundId: round.roundId, expectedRevision: round.revision, kind: "explanation", content: { explanation: `已核对讲解-${userId}`, example: "例如先回忆，再核对。" },
    sourceBlockOrdinals: [1], snapshotHash: round.sourceContentHash, drivingQuestionRevision: 1, kernelTaskRef: "test-only",
  }));
  return { roundId: round.roundId as string, teachingId: teaching.teachingId };
}
before(async () => {
  fixture = await seedV2Fixture(admin); foreign = await seedV2Fixture(admin);
  await seedObjectiveNoteEvidence(admin, fixture);
  await admin`UPDATE notes SET current_version_id=${fixture.noteVersionId},share_scope='shared' WHERE id=${fixture.noteId}`;
  await admin`INSERT INTO users(id,email,password_hash,role) VALUES(${memberId},${`reflection-${memberId}@example.test`},'h','member')`;
  await admin`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${fixture.workspaceId},${memberId},'member')`;
  await app.register(sensible); await app.register(authRoutes); await app.register(noteRoutes); await app.register(noteLearningRoundRoutes); await app.ready();
  token = (await issueSession(fixture.userId, fixture.workspaceId)).token;
  memberToken = (await issueSession(memberId, fixture.workspaceId)).token;
  ({ roundId, teachingId } = await openAndTeach(fixture.userId, token));
  ({ teachingId: memberTeachingId } = await openAndTeach(memberId, memberToken));
});
after(async () => {
  try { await app.close(); await fixture?.cleanup(); await foreign?.cleanup(); await admin`DELETE FROM users WHERE id=${memberId}`; }
  finally { await closeDatabase(); await admin.end(); }
});

test("bookmark → update annotation → replay → remove keeps original teaching and note frozen", async () => {
  const [beforeNote] = await admin`SELECT current_version_id FROM notes WHERE id=${fixture.noteId}`;
  const create = await call("POST", path(), { source: { kind: "teaching", id: teachingId }, annotation: "我的疑问" });
  assert.equal(create.statusCode, 200, create.body); const saved = create.json();
  assert.equal(saved.source.ref.kind, "teaching"); assert.equal(saved.source.roundId, roundId);
  const update = await call("PATCH", `${path()}/${saved.reflectionId}`, { expectedRevision: 1, annotation: "后来想明白了" });
  assert.equal(update.statusCode, 200, update.body); assert.equal(update.json().revision, 2);
  const replay = await call("POST", path(), { source: { kind: "teaching", id: teachingId }, annotation: "过期请求" });
  assert.equal(replay.json().reflectionId, saved.reflectionId); assert.equal(replay.json().annotation, "后来想明白了");
  const conflict = await call("PATCH", `${path()}/${saved.reflectionId}`, { expectedRevision: 1, annotation: "不能覆盖" });
  assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().error, "reflection_stale_revision");
  const removal = await call("DELETE", `${path()}/${saved.reflectionId}`, { expectedRevision: 2 });
  assert.equal(removal.statusCode, 200); assert.equal(removal.json().removed, true);
  const [afterNote] = await admin`SELECT current_version_id FROM notes WHERE id=${fixture.noteId}`;
  assert.equal(afterNote.current_version_id, beforeNote.current_version_id);
  const [original] = await admin`SELECT content FROM note_learning_round_teachings WHERE id=${teachingId}`;
  assert.equal(original.content.explanation, `已核对讲解-${fixture.userId}`);
});

test("read-only member saves own private bookmark; owner cannot read it or donate own source", async () => {
  const saved = await call("POST", path(), { source: { kind: "teaching", id: memberTeachingId }, annotation: "只有我能读" }, memberToken);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal((await call("GET", path(), undefined, memberToken)).json().items.length, 1);
  assert.equal((await call("GET", path())).json().items.length, 0);
  assert.equal((await call("PATCH", `${path()}/${saved.json().reflectionId}`, { expectedRevision: 1, annotation: "越权" })).statusCode, 404);
  assert.equal((await call("POST", path(), { source: { kind: "teaching", id: teachingId } }, memberToken)).statusCode, 404);
  assert.equal((await call("PATCH", `/v2/notes/${fixture.noteId}`, { version: 1, baseVersionId: fixture.noteVersionId }, memberToken)).statusCode, 403);
});

test("permission withdrawal and soft deletion suppress source text and bookmark content", async () => {
  await admin`UPDATE notes SET share_scope='private' WHERE id=${fixture.noteId}`;
  const denied = await call("GET", `${path()}?roundId=${roundId}`, undefined, memberToken);
  assert.equal(denied.statusCode, 404); assert.ok(!denied.body.includes("已核对讲解"));
  assert.equal((await call("POST", path(), { source: { kind: "teaching", id: memberTeachingId } }, memberToken)).statusCode, 404);
  await admin`UPDATE notes SET share_scope='shared',deleted_at=now() WHERE id=${fixture.noteId}`;
  assert.equal((await call("GET", path())).statusCode, 404);
  await admin`UPDATE notes SET deleted_at=NULL WHERE id=${fixture.noteId}`;
});

test("foreign note, round and forged source text never enter a private bookmark", async () => {
  assert.equal((await call("GET", `/v2/notes/${foreign.noteId}/learning-reflections`)).statusCode, 404);
  assert.equal((await call("GET", `${path()}?roundId=${randomUUID()}`)).statusCode, 404);
  assert.equal((await call("POST", path(), { source: { kind: "teaching", id: randomUUID() }, annotation: "伪造" })).statusCode, 404);
  assert.equal((await call("POST", path(), { source: { kind: "teaching", id: teachingId }, text: "替换 AI 内容" })).statusCode, 400);
});

test("real submitted text answer can be bookmarked without changing the locked artifact", async () => {
  const created = await withWorkspaceTransaction(scope(), tx => createRunV2(tx, { ...scope(), request: {
    originV2: { kind: "note_round", roundId, noteId: fixture.noteId, objectiveId: fixture.objectiveId }, goal: "clarify", responsePreference: "text",
    requestedTimeBudgetSeconds: 120, idempotencyKey: `reflection-run-${randomUUID()}`,
  } }));
  const run = await withWorkspaceTransaction(scope(), tx => getRunPublicView(tx, { ...scope(), runId: created.runId }));
  const task = run.activeTask!, variant = task.activeVariant;
  await withWorkspaceTransaction(scope(), tx => submitArtifact(tx, { ...scope(), runId: created.runId, taskId: task.taskId, request: {
    version: 1, variantId: variant.variantId, variantRevision: variant.revision, taskRevision: task.revision, runRevision: run.revision,
    inputSchemaHash: variant.inputSchemaHash, payload: { kind: "text", text: "本金和之前获得的利息一起继续生息。" }, idempotencyKey: `reflection-answer-${randomUUID()}`,
  } }));
  const [artifact] = await admin`SELECT id,payload FROM learning_artifacts WHERE run_id=${created.runId}`;
  const saved = await call("POST", path(), { source: { kind: "answer", id: artifact.id }, annotation: "我还想补充条件" });
  assert.equal(saved.statusCode, 200, saved.body); assert.equal(saved.json().source.text, artifact.payload.text);
  await call("PATCH", `${path()}/${saved.json().reflectionId}`, { expectedRevision: 1, annotation: "新批注" });
  const [afterArtifact] = await admin`SELECT payload FROM learning_artifacts WHERE id=${artifact.id}`;
  assert.deepEqual(afterArtifact.payload, artifact.payload);
});

test("RLS isolates owners and rejects foreign-source anchors even with direct SQL", async () => {
  const count = await withWorkspaceTransaction(scope(), tx => tx.execute(sql`SELECT count(*)::int AS count FROM note_learning_reflections WHERE user_id=${memberId}::uuid`));
  assert.equal(Number(count[0].count), 0);
  await assert.rejects(withWorkspaceTransaction(scope(), tx => tx.execute(sql`INSERT INTO note_learning_reflections(workspace_id,user_id,note_id,round_id,teaching_id)
    VALUES(${fixture.workspaceId}::uuid,${fixture.userId}::uuid,${fixture.noteId}::uuid,${roundId}::uuid,${memberTeachingId}::uuid)`)), err => String((err as { cause?: Error }).cause?.message).includes("row-level security"));
});

test("bookmark pagination is stable and source anchors cannot be moved", async () => {
  for (let i = 0; i < 21; i++) {
    const id = randomUUID();
    await admin`INSERT INTO note_learning_round_teachings(id,workspace_id,user_id,round_id,ordinal,kind,content,source_block_ordinals,snapshot_hash,driving_question_revision)
      VALUES(${id},${fixture.workspaceId},${fixture.userId},${roundId},${i+2},'explanation',${admin.json({ explanation: `分页夹具${i}` })},'{1}','fixture-hash',1)`;
    assert.equal((await call("POST", path(), { source: { kind: "teaching", id } })).statusCode, 200);
  }
  const first = (await call("GET", path())).json(); assert.equal(first.items.length, 20); assert.ok(first.nextCursor);
  const secondRes = await call("GET", `${path()}?before=${first.nextCursor}`); assert.equal(secondRes.statusCode, 200, secondRes.body); const second = secondRes.json(); assert.equal(second.items.length, 2); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(x => x.reflectionId)).size, 22);
  await assert.rejects(withWorkspaceTransaction(scope(), tx => tx.execute(sql`UPDATE note_learning_reflections SET teaching_id=${teachingId}::uuid,revision=revision+1 WHERE id=${first.items[0].reflectionId}::uuid`)), err => String((err as { cause?: Error }).cause?.message).includes("source is immutable"));
});
