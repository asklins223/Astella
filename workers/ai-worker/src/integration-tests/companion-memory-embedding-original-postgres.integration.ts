import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";

const temp = mkdtempSync(join(tmpdir(), "companion-embedding-original-"));
const originalConfig = process.env.AI_PLATFORMS_CONFIG;
process.env.AI_PLATFORMS_CONFIG = join(temp, "platforms.json");
writeFileSync(process.env.AI_PLATFORMS_CONFIG, JSON.stringify({
  platforms: { fixture: { type: "mock", models: { embedding: { contextWindowTokens: 32768, maxOutputTokens: 8192 } } } },
  capabilities: { embedding: { platform: "fixture", model: "embedding" } },
}));
const { runCompanionMemoryEmbeddingRebuild } = await import("../handlers/companion-memory-embedding.ts");
const { registerFactory } = await import("../lib/provider-factory.ts");
const { closeDatabase } = await import("../db.ts");
const received: string[] = [];
registerFactory("mock", "embedding", () => ({ id: "mock", embeddingModelId: "original-fixture",
  embed: async (text: string) => { received.push(text); return null; } } as never));
const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 1 });
after(async () => {
  await admin.end(); await closeDatabase();
  if (originalConfig === undefined) delete process.env.AI_PLATFORMS_CONFIG;
  else process.env.AI_PLATFORMS_CONFIG = originalConfig;
  rmSync(temp, { recursive: true });
});

test("真实 embedding 重建保留历史长记忆的尾部条件，不用前 1000 字冒充完整内容", async () => {
  const userId = randomUUID(), workspaceId = randomUUID(), jobId = randomUUID(), memoryId = randomUUID();
  const content = "旧的学习偏好。".repeat(180) + "更正：这条只适用于之前那个项目，如今已经取消。";
  const leaseToken = "original-embedding-fixture";
  await admin.begin(async tx => {
    await tx`INSERT INTO users (id,email,password_hash,role) VALUES (${userId},${`${userId}@test.invalid`},'fixture','owner')`;
    await tx`INSERT INTO workspaces (id,name,owner_id) VALUES (${workspaceId},'旧记忆正文验收',${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (${workspaceId},${userId},'owner')`;
    await tx`INSERT INTO user_ai_settings (user_id,consent_version,consent_at,data_policy)
      VALUES (${userId},'fixture',now(),${tx.json({ sendToExternal: false, sendImageContent: false, piiDetection: false, auditLogging: true })})`;
    await tx`INSERT INTO assistant_memory_items (id,workspace_id,user_id,kind,content,candidate,embedding_status,source_event_id)
      VALUES (${memoryId},${workspaceId},${userId},'preference',${content},false,'pending',${`original:${memoryId}`})`;
    await tx`INSERT INTO jobs (id,type,workspace_id,requested_by,payload,status,lease_token,started_at)
      VALUES (${jobId},'companion_memory_embedding_rebuild',${workspaceId},${userId},${tx.json({ userId })},'running',${leaseToken},now())`;
  });
  try {
    await runCompanionMemoryEmbeddingRebuild({ id: jobId, workspaceId, requestedBy: userId,
      payload: { userId }, leaseToken, signal: new AbortController().signal });
    assert.deepEqual(received, [content]);
    const [row] = await admin`SELECT content,embedding_status FROM assistant_memory_items WHERE id=${memoryId}`;
    assert.equal(row!.content, content);
    assert.equal(row!.embedding_status, "failed", "null 向量不能把原文标成 ready");
  } finally {
    await admin`DELETE FROM jobs WHERE id=${jobId}`;
    await admin`DELETE FROM assistant_memory_items WHERE workspace_id=${workspaceId}`;
    await admin`DELETE FROM workspace_members WHERE workspace_id=${workspaceId}`;
    await admin`DELETE FROM workspaces WHERE id=${workspaceId}`;
    await admin`DELETE FROM users WHERE id=${userId}`;
  }
});
