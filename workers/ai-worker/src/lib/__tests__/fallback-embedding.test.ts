import assert from "node:assert/strict";
import { test } from "node:test";
import { FallbackEmbeddingProvider, type EmbeddingProviderLike } from "../ai-provider.ts";

function provider(id: string, model: string, embed: EmbeddingProviderLike["embed"]): EmbeddingProviderLike {
  return { id, embeddingModelId: model, embed };
}

const vector = (value: number): number[] => [value, value + 1];

test("primary 正常时不走本地兜底", async () => {
  let fallbackCalls = 0;
  const fallback = provider("local", "BAAI/bge-m3", async () => {
    fallbackCalls += 1;
    return vector(9);
  });
  const primary = provider("siliconflow", "BAAI/bge-m3", async () => vector(1));
  const composite = new FallbackEmbeddingProvider(primary, fallback, {});
  assert.deepEqual(await composite.embed("hello"), vector(1));
  assert.equal(fallbackCalls, 0);
  assert.equal(composite.id, "siliconflow");
  assert.equal(composite.embeddingModelId, "BAAI/bge-m3");
});

test("primary 返回 null 或抛错时切到本地兜底", async () => {
  let fallbackCalls = 0;
  const fallback = provider("local", "BAAI/bge-m3", async () => {
    fallbackCalls += 1;
    return vector(9);
  });
  const nullPrimary = provider("siliconflow", "BAAI/bge-m3", async () => null);
  const throwPrimary = provider("siliconflow", "BAAI/bge-m3", async () => {
    throw new Error("403");
  });
  assert.deepEqual(await new FallbackEmbeddingProvider(nullPrimary, fallback, {}).embed("hello"), vector(9));
  assert.deepEqual(await new FallbackEmbeddingProvider(throwPrimary, fallback, {}).embed("hello"), vector(9));
  assert.equal(fallbackCalls, 2);
});

test("primary 连续失败后熔断，冷却期内直接走本地", async () => {
  let primaryCalls = 0;
  const primary = provider("siliconflow", "BAAI/bge-m3", async () => {
    primaryCalls += 1;
    return null;
  });
  const fallback = provider("local", "BAAI/bge-m3", async () => vector(9));
  const composite = new FallbackEmbeddingProvider(primary, fallback, {
    EMBEDDING_CIRCUIT_FAILURES: "2",
    EMBEDDING_CIRCUIT_COOLDOWN_MS: "60_000",
  });
  await composite.embed("one");
  await composite.embed("two");
  assert.equal(primaryCalls, 2);
  await composite.embed("three");
  assert.equal(primaryCalls, 2, "熔断打开后不再打主槽");
});

test("primary 并发打满时这一次直接走本地", async () => {
  let primaryCalls = 0;
  let release!: (value: number[] | null) => void;
  const primary = provider("siliconflow", "BAAI/bge-m3", async () => {
    primaryCalls += 1;
    return new Promise<number[] | null>((resolve) => { release = resolve; });
  });
  const fallback = provider("local", "BAAI/bge-m3", async () => vector(9));
  const composite = new FallbackEmbeddingProvider(primary, fallback, { EMBEDDING_PRIMARY_MAX_INFLIGHT: "1" });
  const first = composite.embed("first");
  assert.deepEqual(await composite.embed("second"), vector(9));
  assert.equal(primaryCalls, 1, "第二发没有再去排队打主槽");
  release(vector(1));
  assert.deepEqual(await first, vector(1));
});

test("primary 超时后切到本地，且不把超时当成功", async () => {
  let fallbackCalls = 0;
  const primary = provider("siliconflow", "BAAI/bge-m3", async () => new Promise<number[] | null>(() => undefined));
  const fallback = provider("local", "BAAI/bge-m3", async () => {
    fallbackCalls += 1;
    return vector(9);
  });
  const composite = new FallbackEmbeddingProvider(primary, fallback, {
    EMBEDDING_PRIMARY_TIMEOUT_MS: "20",
    EMBEDDING_CIRCUIT_FAILURES: "10",
  });
  assert.deepEqual(await composite.embed("hello"), vector(9));
  assert.equal(fallbackCalls, 1);
});
