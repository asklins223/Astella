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
  assert.match(source, /sourceHash: `\$\{context\.sourceHash\(\)/);
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

/**
 * 调用侧那一格：端口的键是对的，但**喂给它的来源版本**如果每轮都变，冷却照样不生效。
 *
 * 这条守卫要挡的正是 2026-10-16 审出来的那处：`companion-dialogue.ts` 把整份请求的
 * hash（`contextReceipts.currentRequestHash()`）放在 `replaySummaryCoverage.sourceSha256`
 * 前面，于是键每轮每步都变、每个键只出现一次，「同一失败输入不能每轮重新触发」成了空话。
 * 端口自己的单测全绿——它只看得见键的形状，看不见喂进来的是什么。
 */
test("44 §5.4：调用侧喂的是摘要覆盖的来源版本，不是整份请求的哈希", () => {
  const source = readFileSync(
    new URL("../companion-dialogue.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("createCompactionCooldownPorts({");
  assert.notEqual(start, -1, "找不到压缩冷却的接线点");
  // 取到这一格参数的收尾为止；只在这一小段里判，免得匹配到别处的同名调用。
  const wiring = source.slice(start, start + 900);
  const sourceHash = wiring.match(/sourceHash:\s*\(\)\s*=>\s*([^,\n]+)/)?.[1]?.trim() ?? "";
  assert.match(sourceHash, /replaySummaryCoverage\?\.sourceSha256/,
    "来源版本必须取自摘要覆盖的 sourceSha256");
  assert.doesNotMatch(sourceHash, /currentRequestHash/,
    "整份请求的哈希每轮每步都变，用它会退化成「每个键只失败一次」");
});

/**
 * 冷却键必须按**折叠的来源**区分（2026-10-16 实库回归）。
 *
 * 一次请求里先后可能折两类来源：先历史摘要覆盖（`history_exchanges`），再工具工作状态
 * （`active_tool_rounds`）。两类的"来源版本"如果共用一把键，后一次折叠会读到前一次
 * 刚记下的 60 秒冷却并直接判 `within_cooldown`，于是**本来折得动的第二轮变成
 * `AIContextOverflowError`**：`latest-history-read` 那条集成用例就是这样红的
 * （`companion-dialogue-postgres.integration.ts`「unsummarized overflowing history
 * recovers on the first answer」）。修法是让折叠侧把来源种类写进键里。
 *
 * 这条守卫钉住三个接线点，缺一个就会退回原样：
 *   ① 端口有 `foldSourceKind` 字段；② 键把它并进去；
 *   ③ 有界发送方在判定之前写入它（种类由"历史折过没有"决定）。
 */
test("44 §5.4：冷却键按折叠的来源区分，历史摘要与工具回合不共键", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  const ports = read("../companion-compaction.ts");
  assert.match(ports, /foldSourceKind\?: "history_exchanges" \| "active_tool_rounds" \| null;/,
    "端口必须带来源种类字段，否则键分不开两类折叠");
  assert.match(ports, /input\.cooldown\.foldSourceKind = input\.sourceKind\?\.\(\) \?\? null;/,
    "有界发送方必须在冷却判定之前写入这一次的来源种类");

  const cooldown = read("../companion-compaction-cooldown.ts");
  assert.match(cooldown, /sourceHash: [^\n]*\$\{ports\.foldSourceKind/,
    "键必须把来源种类并进 sourceHash");

  const step = read("../companion-step-compaction.ts");
  assert.match(step, /sourceKind: \(\) => deps\.getHistoryFoldApplied\(\) \? "active_tool_rounds" : "history_exchanges"/,
    "折叠侧要按『历史折过没有』给出这一次的来源种类");
});
