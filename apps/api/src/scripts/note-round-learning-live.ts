/** Opt-in real-model smoke. Synthetic material, disposable database, restricted API role, cleanup in finally. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import postgres from "postgres";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { seedNotesOnlyWorkspace } from "../integration-tests/helpers/pure-v2-workspace-fixture.ts";
import { authRoutes } from "../modules/identity/routes.ts";
import { issueSession } from "../modules/identity/service.ts";
import { noteLearningRoundRoutes } from "../modules/note-learning-rounds/routes.ts";
import { resolveTeachingModelConfig } from "../modules/note-learning-rounds/teaching/teaching-llm.ts";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import { createRunV2 } from "../modules/learning-runs/run-service.ts";
import { roundTeachingViewV1Schema } from "@astella/shared/note-learning-round-contracts";

assert.equal(process.env.NOTE_ROUND_LIVE, "1", "set NOTE_ROUND_LIVE=1 to opt into a real model call");
const adminUrl = process.env.DATABASE_URL_MIGRATOR;
const apiUrl = process.env.DATABASE_URL_API;
assert.ok(adminUrl && apiUrl, "explicit migrator and restricted API database URLs are required");
const adminDb = new URL(adminUrl); const apiDb = new URL(apiUrl);
assert.match(adminDb.pathname, /^\/astella_note39_[a-zA-Z0-9_]+$/, "only the dedicated disposable test database is allowed");
assert.equal(apiDb.pathname, adminDb.pathname); assert.equal(apiDb.username, "astella_api");
const config = resolveTeachingModelConfig(); assert.ok(config, "real teaching model must be configured");
const admin = postgres(adminUrl, { max: 2 });
const app = Fastify({ logger: false });
let fixture: Awaited<ReturnType<typeof seedNotesOnlyWorkspace>> | null = null;
const started = Date.now();
try {
  fixture = await seedNotesOnlyWorkspace(admin, { noteCount: 1 });
  const blocks = [
    { type: "heading", content: "## 间隔重复与主动提取" },
    { type: "paragraph", content: "间隔重复把学习分散在不同时间，在接近遗忘时再次练习。主动提取指先尝试从记忆中说出内容，再查阅材料校对。" },
    { type: "paragraph", content: "例如，学习一个新词后，在第1、3、7天先合上书回忆词义，再打开笔记确认。重读是在眼前看着材料；能看懂不等于能从记忆中提取。" },
  ];
  await admin`UPDATE note_versions SET content_json=${admin.json({ blocks })} WHERE id=${fixture.versionIds[0]}`;
  for (let index = 0; index < blocks.length; index++) await admin`INSERT INTO note_blocks
    (id,workspace_id,version_id,ordinal,type,content) VALUES (${randomUUID()},${fixture.workspaceId},${fixture.versionIds[0]},
      ${index + 1},${blocks[index].type},${blocks[index].content})`;
  await app.register(sensible); await app.register(authRoutes); await app.register(noteLearningRoundRoutes); await app.ready();
  const token = (await issueSession(fixture.userId, fixture.workspaceId)).token;
  const call = (url: string, payload: object) => app.inject({ method: "POST", url, payload, headers: { authorization: `Bearer ${token}` } });
  const opened = await call("/v2/note-learning-rounds", { noteId: fixture.noteIds[0] });
  assert.equal(opened.statusCode, 201, opened.body); const round = opened.json().round;
  const denied = await call(`/v2/note-learning-rounds/${round.roundId}/teaching`, { expectedRevision: round.revision });
  assert.equal(denied.statusCode, 403, "a fixture without consent must not reach the external model");
  // Explicit live opt-in is consent for synthetic test material only. No real account is changed.
  await admin`INSERT INTO user_ai_settings (user_id,consent_version,consent_at)
    VALUES (${fixture.userId},'synthetic-note-round-live-v1',now())
    ON CONFLICT (user_id) DO UPDATE SET consent_version=excluded.consent_version,consent_at=excluded.consent_at`;
  const generated = await call(`/v2/note-learning-rounds/${round.roundId}/teaching`, { expectedRevision: round.revision });
  assert.equal(generated.statusCode, 201, generated.body);
  const view = roundTeachingViewV1Schema.parse(generated.json());
  assert.ok(view.teaching, "real explanation must be persisted"); assert.ok(view.practiceStart, "grounded target must produce a practice start");
  const run = await withWorkspaceTransaction({ workspaceId: fixture.workspaceId, userId: fixture.userId }, (tx) => createRunV2(tx, {
    workspaceId: fixture!.workspaceId, userId: fixture!.userId,
    request: { ...view.practiceStart!.start, idempotencyKey: `live-note:${round.roundId}` },
  }));
  assert.equal(run.frozen.snapshot.target.cardId, null);
  assert.equal(run.frozen.snapshot.planningExposure.sameCueRecentlyRevealed, true);
  if (process.env.NOTE_ROUND_LIVE_OUTPUT) {
    const checks = await admin`SELECT s.report FROM semantic_support_reports_v2 s
      JOIN note_learning_round_targets t ON t.objective_revision_id=s.objective_revision_id
      WHERE t.round_id=${round.roundId}`;
    await mkdir(dirname(process.env.NOTE_ROUND_LIVE_OUTPUT), { recursive: true });
    await writeFile(process.env.NOTE_ROUND_LIVE_OUTPUT, JSON.stringify({ synthetic: true, material: blocks,
      drivingQuestion: round.drivingQuestion, teaching: view.teaching.content,
      sourceBlockOrdinals: view.teaching.sourceBlockOrdinals, plan: view.plans[0].plan, checks }, null, 2));
  }
  const attempts = await admin`SELECT model_calls,status FROM note_learning_round_model_attempts WHERE round_id=${round.roundId}`;
  process.stdout.write(JSON.stringify({ passed: true, model: config.model, elapsedMs: Date.now() - started,
    modelCalls: attempts.reduce((sum, row) => sum + Number(row.model_calls), 0),
    explanationCharacters: view.teaching.content.explanation.length, sourceBlocks: view.teaching.sourceBlockOrdinals,
    plans: view.plans.length, cardlessRun: true, practiceOnly: true }) + "\n");
} finally {
  try { await app.close(); if (fixture) await fixture.cleanup(); }
  finally { await closeDatabase(); await admin.end(); }
}
