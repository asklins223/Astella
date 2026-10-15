import assert from "node:assert/strict";
import test from "node:test";
import { projectBlocksIntoVersion } from "../document-state.ts";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";

/** `note_blocks` 每行真正带过去几个绑定参数（`id` 与 `created_at` 走 `default`）。 */
const PARAMS_PER_BLOCK_ROW = 7;
/** Postgres 扩展协议一条语句的绑定参数上限。 */
const PG_MAX_PARAMS = 65_536;

type Recorded = { inserts: number[]; upserts: number[]; deletes: number };

const settled = (record: () => void) => ({
  then: (resolve: (value: undefined) => void) => {
    record();
    resolve(undefined);
  },
});

function fakeTx(existingRows: readonly { id: string; ordinal: number; type: string; content: string }[], log: Recorded) {
  return {
    query: { noteBlocks: { findMany: async () => existingRows.map(row => ({ ...row, imageAssetId: null, sourceRef: null })) } },
    insert() {
      return {
        values(rows: unknown[]) {
          // 带 `onConflictDoUpdate` 的那一支改的是已有行，另一支是新增行——分开记。
          let upsert = false;
          const statement = {
            onConflictDoUpdate: () => (upsert = true, statement),
            then: (resolve: (value: undefined) => void) => {
              (upsert ? log.upserts : log.inserts).push(rows.length);
              resolve(undefined);
            },
          };
          return statement;
        },
      };
    },
    delete() {
      return { where: () => settled(() => { log.deletes += 1; }) };
    },
  } as never;
}

const blocks = (count: number) => Array.from({ length: count }, (_, i) => ({
  ordinal: i,
  type: "paragraph",
  content: `第 ${i} 段正文`,
  sourceRef: null,
  imageAssetId: null,
}));

test("整篇长文的块按批写：一次语句不能越过 Postgres 的绑定参数上限", async () => {
  // 实测（2026-10-14）：`/import/markdown` 导入一篇 12,000 段的长文，整批一次性 insert
  // 当场抛错，那一整篇一个字都没落库（12,000 行 × 7 个参数 = 84,000 > 65,536）。
  const log: Recorded = { inserts: [], upserts: [], deletes: 0 };
  await projectBlocksIntoVersion(fakeTx([], log), WORKSPACE_ID, VERSION_ID, blocks(12_000) as never);
  assert.ok(log.inserts.length > 1, `12,000 行必须拆成多条语句，实际 ${log.inserts.length} 条`);
  assert.equal(log.inserts.reduce((a, b) => a + b, 0), 12_000, "拆批不能少写一行");
  const widest = Math.max(...log.inserts);
  assert.ok(widest * PARAMS_PER_BLOCK_ROW < PG_MAX_PARAMS,
    `最宽的一批 ${widest} 行 × ${PARAMS_PER_BLOCK_ROW} 参数已经顶到 ${PG_MAX_PARAMS} 的上限`);
});

test("改一批长块的正文同样按批走", async () => {
  const existing = Array.from({ length: 8_000 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(4, "0")}`,
    ordinal: i,
    type: "paragraph",
    content: `第 ${i} 段旧文`,
  }));
  const log: Recorded = { inserts: [], upserts: [], deletes: 0 };
  await projectBlocksIntoVersion(fakeTx(existing, log), WORKSPACE_ID, VERSION_ID, blocks(8_000) as never);
  assert.ok(log.upserts.length > 1, `8,000 行改动必须拆批，实际 ${log.upserts.length} 条`);
  assert.equal(log.upserts.reduce((a, b) => a + b, 0), 8_000);
  assert.ok(Math.max(...log.upserts) * PARAMS_PER_BLOCK_ROW < PG_MAX_PARAMS);
});
