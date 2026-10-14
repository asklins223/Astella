import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { enqueueCompanionMemoryEmbeddingRebuild } from "../companion-memory-embedding-jobs.ts";

test("vector rebuild enqueue is feature gated and writes an idempotent maintenance job", async () => {
  const previous = process.env.COMPANION_MEMORY_VECTOR_V1;
  const queries: unknown[] = [];
  const tx = { execute: async (query: unknown) => { queries.push(query); return []; } };
  try {
    delete process.env.COMPANION_MEMORY_VECTOR_V1;
    await enqueueCompanionMemoryEmbeddingRebuild(tx, {
      workspaceId: "workspace-1", userId: "user-1", idempotencyKey: "memory-embedding:write-1",
    });
    assert.equal(queries.length, 0);

    process.env.COMPANION_MEMORY_VECTOR_V1 = "true";
    await enqueueCompanionMemoryEmbeddingRebuild(tx, {
      workspaceId: "workspace-1", userId: "user-1", idempotencyKey: "memory-embedding:write-1",
    });
    assert.equal(queries.length, 1);
  } finally {
    if (previous === undefined) delete process.env.COMPANION_MEMORY_VECTOR_V1;
    else process.env.COMPANION_MEMORY_VECTOR_V1 = previous;
  }
});

test("automatic memory writers queue embedding work in the write transaction", () => {
  const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const extractor = read("../companion-memory-extractor.ts");
  const tools = read("../companion-memory-tools.ts");
  const reflection = read("../companion-reflection.ts");

  assert.match(extractor, /INSERT INTO assistant_memory_items[\s\S]*?RETURNING id[\s\S]*?enqueueCompanionMemoryEmbeddingRebuild\(tx/);
  assert.ok((tools.match(/enqueueCompanionMemoryEmbeddingRebuild\(tx/g) ?? []).length >= 3);
  assert.match(reflection, /if \(wroteMemory\)[\s\S]*?enqueueCompanionMemoryEmbeddingRebuild\(tx/);
});

test("rebuild selects ready rows that lack a vector for the current model revision", () => {
  const source = readFileSync(new URL("../companion-memory-embedding.ts", import.meta.url), "utf8");
  assert.match(source, /embedding_status = 'ready' AND NOT EXISTS/);
  assert.match(source, /e\.model_revision = \$\{provider\.embeddingModelId\}/);
  assert.match(source, /dv\.model_revision = \([\s\S]*?SELECT current_embedding\.model_revision/);
});
