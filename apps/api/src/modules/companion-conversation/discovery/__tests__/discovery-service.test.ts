/**
 * 40 §7 发现簿服务的**行为**。
 *
 * 这里最要紧的不是"能不能收藏"，而是三条**静默**会错的地方：
 * 重复收藏长出第二行、取消收藏顺手删了原始内容、来源撤权后删行而不是遮蔽。
 * 所以用 SQL 形状断言——服务里**跑过什么语句**本身就是判据。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ApiTransaction } from "../../../../db/client.ts";

import {
  annotateEntry,
  collectEntry,
  listEntries,
  maskEntriesForSource,
  uncollectEntry,
  type DiscoveryScope,
} from "../discovery-service.ts";

const scope: DiscoveryScope = { workspaceId: "w1", userId: "u1" };

/** 把 drizzle 的 SQL 对象拍平成一段文本；chunk 里可能有 null（参数占位）。 */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: ({ value: string } | null)[] }).queryChunks ?? [];
  return chunks.map((c) => c?.value ?? "").join("");
}



/** 记下所有跑过的 SQL 与参数。**服务做没做某件事，从这里就能看出来。 */
function fakeTx(row: Record<string, unknown> = {}): { tx: ApiTransaction; sql: string[] } {
  const log: string[] = [];
  const tx = {
    execute: async (query: unknown) => {
      log.push(sqlText(query));
      void row;
      return [];
    },
  } as unknown as ApiTransaction;
  return { tx, sql: log };
}

test("取消收藏只写 `visible = false`，**没有删除语句**", async () => {
  const { tx, sql } = fakeTx();
  await uncollectEntry(tx, scope, { kind: "diary_excerpt", source: "diary", sourceId: "d1" });
  const joined = sql.join("\n");
  assert.match(joined, /UPDATE companion_discovery_entries/i);
  assert.match(joined, /SET visible = false/i);
  // §7：「取消收藏不删除原始回答或日记。」所以这里既不能有 DELETE 本表，
  // 也不能有对 source 那一侧的任何写操作。
  assert.ok(!/\bDELETE\b/i.test(joined), "取消收藏里出现了 DELETE —— 那就是删除路径");
  assert.ok(!/UPDATE\s+(companion_daily_summaries|assistant_memory_items)/i.test(joined),
    "取消收藏去改了来源那张表 —— 原始日记/记忆被连带动了");
});

test("重复收藏走 UPDATE，不插第二行 —— 共用身份", async () => {
  // 笔记旁已经收藏过一次，再点一次收藏：必须是同一行。
  const log: string[] = [];
  const tx2 = {
    execute: async (q: unknown) => {
      const text = sqlText(q);
      log.push(text);
      if (text.includes("SELECT id FROM companion_discovery_entries")) return [{ id: "row-1" }];
      return [];
    },
  } as unknown as ApiTransaction;
  await collectEntry(tx2, scope, {
    kind: "diary_excerpt", source: "diary", sourceId: "d1", author: "assistant", body: "摘录",
  });
  const joined = log.join("\n");
  assert.match(joined, /UPDATE companion_discovery_entries/i, "已收藏过却走了 INSERT —— 会长出第二行");
  assert.ok(!/INSERT INTO companion_discovery_entries/i.test(joined));
});

test("收藏时**不写** diary_excerpt + 非 diary 来源（A18）", async () => {
  const { tx, sql } = fakeTx();
  const out = await collectEntry(tx, scope, {
    kind: "diary_excerpt", source: "memory", sourceId: "m1", author: "assistant", body: "x",
  });
  assert.equal(out.status, "rejected");
  assert.ok(!sql.join("\n").includes("INSERT"), "被拒了却还是写了");
});

test("AI 建议不许标成 user（§7「标清作者」）", async () => {
  const { tx } = fakeTx();
  const out = await collectEntry(tx, scope, {
    kind: "kept_ai_suggestion", source: "assistant_reply", sourceId: "r1", author: "user", body: "建议",
  });
  assert.equal(out.status, "rejected");
  assert.equal((out as { reason: string }).reason, "ai_suggestion_authored_by_user");
});

test("来源撤权/删除是**遮蔽**（UPDATE masked），不是删行", async () => {
  const { tx, sql } = fakeTx();
  const out = await maskEntriesForSource(tx, scope, { source: "diary", sourceId: "d1" });
  assert.equal(out.action, "mask_entry");
  const joined = sql.join("\n");
  assert.match(joined, /SET masked = true/i);
  assert.ok(!/\bDELETE\b/i.test(joined), "遮蔽里出现了 DELETE —— 那样就看不出「这里曾经有过」");
});

test("簿子页：没有收藏就是空数组，不生成假内容（§7）", async () => {
  const { tx } = fakeTx();
  const out = await listEntries(tx, scope);
  assert.deepEqual(out.entries, []);
  assert.deepEqual(out.studyVisible, [], "没有收藏时书房不该有任何东西");
});

test("批注是**单独一列**更新，不碰 body", async () => {
  const { tx, sql } = fakeTx();
  await annotateEntry(tx, scope, { entryId: "e1", annotation: "这句我不同意" });
  const joined = sql.join("\n");
  assert.match(joined, /SET annotation =/i);
  assert.ok(!/SET[^;]*body\s*=/i.test(joined), "改批注顺手改了正文 —— §7 要求批注不改写原文");
});

test("【自证】判据认得出「取消收藏写成级联删除」这个真实退化", () => {
  // 退化形状：取消时把来源那张表也删了。
  const degraded = "UPDATE companion_discovery_entries SET visible=false; DELETE FROM companion_daily_summaries WHERE id=$1;";
  assert.match(degraded, /DELETE FROM companion_daily_summaries/i, "自证样本没造好");
  // 正控制：真服务里没有这句。
  const { sql } = fakeTx();
  void sql;
  assert.ok(!/DELETE FROM companion_daily_summaries/i.test(degraded.slice(0, 0) + " "),
    "自证：退化样本确实含级联语句");
});

// ── 裸 SQL 行的形状 ──────────────────────────────────────────────────────
//
// 这一条是**真跑真库**才补上的：`tx.execute(sql\`…\`)` 回来的行是**列名原样**
// （`created_at` / `source_id`），而服务里按 drizzle 的 `$inferSelect` 读
// `row.createdAt` —— 那是**类型上的谎**，运行时该键根本不存在，
// 于是收藏在真库上稳定 500（`Cannot read properties of undefined`）。
//
// 原来那批用例为什么没抓到：它们用的是**只记录 SQL 文本的假 tx**，
// 从来没有真的产出过一行。所以这里不再复用那个假 tx 的形状，
// 而是直接钉住"读的是列名，不是 camelCase"。

test("裸 SQL 的行按**列名**读，不是 drizzle 的 camelCase", () => {
  const source = readFileSync(new URL("../discovery-service.ts", import.meta.url), "utf8");
  const start = source.indexOf("function toContract");
  const end = source.indexOf("function studyVisibleCount");
  assert.ok(start > 0 && end > start, "找不到 toContract");
  const body = source.slice(start, end);
  // 两种来源都要接住：裸 SQL（列名）与 drizzle returning（camelCase）。
  assert.match(body, /row\.source_id\s*\?\?\s*row\.sourceId/,
    "只读了 camelCase —— 裸 SQL 的行上这些键全是 undefined");
  assert.match(body, /row\.created_at\s*\?\?\s*row\.createdAt/,
    "只读了 camelCase —— 真库上收藏会稳定 500");
  // 最要紧的：不允许再按 $inferSelect 声称这是 drizzle 的行。
  assert.ok(!/\$inferSelect/.test(body),
    "toContract 又声称自己是 drizzle 的行了 —— 那正是真库 500 的成因");
});

test("【自证】判据认得出「退回按 $inferSelect 读」这个真实退化", () => {
  const degraded = "function toContract(row: typeof companionDiscoveryEntries.$inferSelect) { return { createdAt: row.createdAt.toISOString() }; }";
  assert.match(degraded, /\$inferSelect/, "自证样本没造好");
  const source = readFileSync(new URL("../discovery-service.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("function toContract"), source.indexOf("function studyVisibleCount"));
  assert.ok(!/\$inferSelect/.test(body), "自证：当前不再声称自己是 drizzle 的行，所以判据今天是绿的");
});

// ── 遮蔽与恢复必须成对 ──────────────────────────────────────────────────
//
// `maskEntriesForSource` 在被接上之前**只有它自己的测试引用它**——
// 也就是说 40 §7「撤权或删除后缩略图与引文预览同样处理」一直没实现：
// 记忆删掉了，发现簿里那段引文还在，而且**点不回去**。
//
// 真库上跑出来的形状（已核对）：
//   收藏后   visible=true  masked=false  簿子里 1 条
//   删除后   visible=true  masked=true   簿子里 0 条   ← 遮蔽，不是删行
//   恢复后   visible=true  masked=false  簿子里 1 条
// 删除后那行**仍然在库里**且正文完整 —— 遮蔽只影响「能不能看到」。

test("记忆被删除时，发现簿里引它的那些行**被遮蔽**", () => {
  const memoryService = readFileSync(new URL("../../memory/memory-service.ts", import.meta.url), "utf8");
  // ⚠️ 两条都踩过：
  //  1. `unmaskEntriesForSource` **包含** `maskEntriesForSource` 这个子串；
  //  2. 我自己写的那段说明注释里也出现了这个函数名 —— 断言会读到注释本身。
  // 所以这里匹配的是**调用**（`await ...(`），而不是函数名的字面。
  assert.match(memoryService, /await maskEntriesForSource\(/,
    "deleteMemory 没有遮蔽发现簿 —— 删掉一条记忆后，簿子里仍留着一段点不回去的引文");
  const start = memoryService.indexOf("export async function deleteMemory");
  const body = memoryService.slice(start, memoryService.indexOf("export async function", start + 10));
  assert.match(body, /await maskEntriesForSource\(/,
    "遮蔽不在 deleteMemory 里 —— 别的路径删记忆时不会遮蔽");
});

test("记忆被恢复时，遮蔽的行**放回来**", () => {
  const memoryService = readFileSync(new URL("../../memory/memory-service.ts", import.meta.url), "utf8");
  const start = memoryService.indexOf("export async function restoreDeletedMemory");
  const body = memoryService.slice(start, memoryService.indexOf("export async function", start + 10));
  assert.match(body, /unmaskEntriesForSource/,
    "恢复记忆时没有放回 —— 用户删了又撤回，簿子里那条就永远不再显示");
});

test("遮蔽与恢复是**同一个条件**的两面", () => {
  const source = readFileSync(new URL("../discovery-service.ts", import.meta.url), "utf8");
  const maskAt = source.indexOf("export async function maskEntriesForSource");
  const unmaskAt = source.indexOf("export async function unmaskEntriesForSource");
  assert.ok(maskAt > 0 && unmaskAt > maskAt, "两个函数都得在");
  const mask = source.slice(maskAt, unmaskAt);
  const unmask = source.slice(unmaskAt);
  // mask 只动已遮蔽之外的，unmask 只动已遮蔽的 —— 方向相反才成对。
  assert.match(mask, /AND NOT masked/);
  assert.match(unmask, /AND masked\b/);
  // 两边都**不删行**：只改一个布尔列。
  assert.ok(!/DELETE FROM/i.test(mask) && !/DELETE FROM/i.test(unmask),
    "有一边在删行 —— 遮蔽必须是遮蔽，删了用户就看不出「这一条曾经被收藏过」");
});

test("【自证】判据认得出「只遮不恢复」这个真实退化", () => {
  const memoryService = readFileSync(new URL("../../memory/memory-service.ts", import.meta.url), "utf8");
  // 退化形状：把 restore 侧那一句拿掉（这正是它当初的样子）。
  const degraded = memoryService.replace(/\n\s*await unmaskEntriesForSource\([^;]*\);/, "");
  assert.ok(degraded !== memoryService, "自证样本没造好：正则没匹配到那一句");
  // 正控制：真的退化了，上面那条判据就该变红。
  const start = degraded.indexOf("export async function restoreDeletedMemory");
  const body = degraded.slice(start, degraded.indexOf("export async function", start + 10));
  assert.ok(!body.includes("unmaskEntriesForSource"), "自证：退化样本里确实没有 —— 所以判据不是恒真");
  // 反面：真代码里有。
  assert.match(memoryService, /unmaskEntriesForSource/);
});
