/**
 * `similarity()` 这一族 SQL 判据只准用**具名共享常量**，不许在 SQL 里写数。
 *
 * 为什么：同一个数被两边各写一遍，两边就会悄悄分叉，而 typecheck 与单测都不会红。
 * 现在有两族互不相同的相似度用途，各有自己的常量：
 *
 * - `MEMORY_CONTENT_SIMILARITY_THRESHOLD`（0.85）：冲突分组（api 侧）与"忽略过的候选
 *   别再抽出来"（worker 抽取器）读的是同一个数，分属两个进程、两份 import。
 * - `COMPANION_SPEECH_REPEAT_CANDIDATE_SIMILARITY`（0.18）：主动发言发布前挑选
 *   「相近旧话」待核对材料，检索相似不等于重复，复核在模型侧完成（方案 56/58）。
 *
 * 两族判的不是同一件事，不能合并；但每个 `similarity(` 调用都必须引用自己那族的
 * 常量，别在 SQL 里再写一个数。
 *
 * 只管 SQL 的 `similarity(`。向量嵌入的相似度判据属于另一套度量，数值相同纯属巧合，不要为了"统一"把它们并成一个常量。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const MEMORY_CONSTANT = "MEMORY_CONTENT_SIMILARITY_THRESHOLD";
const SPEECH_RETRIEVAL_CONSTANT = "COMPANION_SPEECH_REPEAT_CANDIDATE_SIMILARITY";
const SIMILARITY_CONSTANTS = [MEMORY_CONSTANT, SPEECH_RETRIEVAL_CONSTANT] as const;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "integration-tests") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const scanned = [
  ...sourceFiles(join(REPO_ROOT, "apps", "api", "src")),
  ...sourceFiles(join(REPO_ROOT, "workers", "ai-worker", "src")),
];

const sites = scanned
  .map((file) => ({ file: relative(REPO_ROOT, file), source: readFileSync(file, "utf8") }))
  .filter((entry) => /\bsimilarity\(/.test(entry.source));

test("扫描确实读到了东西（读不到时这条门禁就是假绿）", () => {
  assert.ok(sites.length >= 2, `只找到 ${sites.length} 处 similarity() 调用，判据可能已经搬家`);
  assert.ok(
    sites.every((entry) => SIMILARITY_CONSTANTS.some((name) => entry.source.includes(name))),
    `这些文件调用了 similarity() 却没引用共用常量（${SIMILARITY_CONSTANTS.join(" / ")}）：${sites
      .filter((entry) => !SIMILARITY_CONSTANTS.some((name) => entry.source.includes(name)))
      .map((entry) => entry.file)
      .join(", ")}`,
  );
});

test("每一族 similarity() 都用自己那族的常量，不串用", () => {
  const speechReview = sites.find((entry) => entry.file.endsWith("companion-initiative-speech-review.ts"));
  assert.ok(speechReview, "主动发言核对文件应当仍是相似度检索的一处调用点");
  assert.ok(speechReview.source.includes(SPEECH_RETRIEVAL_CONSTANT), "主动发言核对必须引用自己的检索阈值常量");
  const memorySites = sites.filter((entry) => !entry.file.endsWith("companion-initiative-speech-review.ts"));
  assert.ok(memorySites.length >= 2, `记忆冲突判据的调用点少于 2 处：${memorySites.length}`);
  assert.ok(
    memorySites.every((entry) => entry.source.includes(MEMORY_CONSTANT)),
    `记忆冲突判据没有引用 ${MEMORY_CONSTANT}：${memorySites
      .filter((entry) => !entry.source.includes(MEMORY_CONSTANT))
      .map((entry) => entry.file)
      .join(", ")}`,
  );
});

test("阈值不许在 SQL 里被重写成第二个数", () => {
  for (const entry of sites) {
    const hardcoded = entry.source.match(/similarity\([^)]*\)\s*[><]=?\s*\d+(\.\d+)?/g) ?? [];
    assert.deepEqual(hardcoded, [], `${entry.file} 里写了字面量阈值：${hardcoded.join(" / ")}`);
  }
});

// ─── 语义（向量余弦）那一族：同一个仓库里只准有一处把 `<=>` 和阈值拼起来 ───

const vectorSites = scanned
  .map((file) => ({ file: relative(REPO_ROOT, file), source: readFileSync(file, "utf8") }))
  .filter((entry) => /<=>/.test(entry.source));
const sharedBuilder = join(REPO_ROOT, "packages", "shared", "src", "db-schema", "assistant-memory.ts");
const rawThresholdSites = vectorSites.filter(
  (entry) =>
    !/semanticTwinPredicateSql\(|MEMORY_SEMANTIC_SIMILARITY_THRESHOLD/.test(entry.source)
    && /(>\s*0\.\d+|MEMORY_SEMANTIC_SIMILARITY_THRESHOLD)/.test(entry.source),
);

test("共享表达式真的有两个进程在用（只剩一个用就等于没去重）", () => {
  const users = scanned
    .map((file) => relative(REPO_ROOT, file))
    .filter((name) => readFileSync(join(REPO_ROOT, name), "utf8").match(/semanticTwinPredicateSql\(|MEMORY_SEMANTIC_SIMILARITY_THRESHOLD/));
  assert.deepEqual(
    users.filter((name) => name.startsWith("packages/")),
    [],
    "shared 自己不该出现在这份清单里",
  );
  const inWorker = users.some((name) => name.startsWith("workers/"));
  const inApi = users.some((name) => name.startsWith("apps/api/"));
  assert.ok(
    inWorker && inApi,
    `两侧都要引用共享判据（常量或表达式），实际：${users.join(", ") || "0 处"}`,
  );
});

test("所有 <=> 比较都走共享的 semanticTwinPredicateSql，不许自己写阈值", () => {
  assert.deepEqual(
    rawThresholdSites.map((entry) => entry.file),
    [],
    `这些文件自带了语义阈值：${rawThresholdSites.map((entry) => entry.file).join(", ")}。` +
      "阈值只准出现在 MEMORY_SEMANTIC_SIMILARITY_THRESHOLD 一处。",
  );
});

test("共享表达式真的带着那个常量（不是退化成空字符串）", async () => {
  const source = readFileSync(sharedBuilder, "utf8");
  const { semanticTwinPredicateSql, MEMORY_SEMANTIC_SIMILARITY_THRESHOLD } = await import(
    "@astella/shared/db-schema/assistant-memory"
  );
  const built = semanticTwinPredicateSql("a.embedding", "b.embedding::vector");
  assert.match(built, /a\.embedding <=> b\.embedding::vector/);
  assert.ok(built.includes(String(MEMORY_SEMANTIC_SIMILARITY_THRESHOLD)), built);
  assert.ok(source.includes("MEMORY_SEMANTIC_SIMILARITY_THRESHOLD"));
});
