import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createCompactionCooldownPorts } from "../companion-compaction-cooldown.ts";

/**
 * 方案 44 §5.4 后半：冷却是**跨轮次**的记忆，所以它必须活在数据库里。
 *
 * 这里不碰真库（迁移 0385 还没在实库上跑过），但把「键由什么构成」「没有压力读数时
 * 不写状态」这两条钉住——它们错的时候，单测里全都能过，等到线上才发现每一轮都在
 * 覆盖同一份冷却。
 */


test("44 §5.4：没有压力读数时既不判定也不写状态（不凭空造一份冷却）", async () => {
  const ports = createCompactionCooldownPorts({
    workspaceId: "ws-1", userId: "user-1", conversationId: "conv-1",
    sourceHash: () => "a".repeat(64),
    latestPressure: () => null,
  });
  // 还没有真实调用发生过 → 判定为「没记录过」，允许尝试；写状态则什么都不做。
  assert.equal((await ports.decide()).allowed, true);
  assert.equal((await ports.decide()).reason, "not_recorded");
  await ports.record({ at: new Date() });
});

test("44 §5.4：记录用的是重发之后的读数，不是调用方猜的数字", async () => {
  const source = readFileSync(
    new URL("../companion-compaction-cooldown.ts", import.meta.url),
    "utf8",
  );
  // 「有没有进展」按重发之后还剩多少判；让调用方传一个数字进来，就会有人在折前取值，
  // 于是每次都记「没变小」，冷却被推成 no_progress。
  assert.match(source, /inputTokens: pressure\.inputTokens/);
  assert.doesNotMatch(source, /record\(\{ inputTokens/);
});

test("44 §5.4：键由会话、来源版本与模型路由共同构成", async () => {
  const source = readFileSync(
    new URL("../companion-compaction-cooldown.ts", import.meta.url),
    "utf8",
  );
  // 三样缺一不可：换会话、来源重算、换模型都让上一次失败不再适用。
  assert.match(source, /conversationId: context\.conversationId/);
  assert.match(source, /sourceHash: context\.sourceHash\(\)/);
  assert.match(source, /providerId: pressure\.providerId/);
  assert.match(source, /modelId: pressure\.modelId/);
  // 没有摘要时退化成粒度粗一档的键，而不是放弃判别。
  assert.match(source, /sourceHash\(\) \?\? `pressure:/);
});

test("44 §5.4：读与写都走工作区事务（RLS 作用域由事务设置）", async () => {
  const source = readFileSync(
    new URL("../companion-compaction-cooldown.ts", import.meta.url),
    "utf8",
  );
  const transactions = source.match(/withWorkerWorkspaceTransaction\(/g) ?? [];
  assert.equal(transactions.length, 2, "判定与记录各自开一个带 actor 的事务");
  assert.match(source, /workspaceId: context\.workspaceId, userId: context\.userId/);
});
