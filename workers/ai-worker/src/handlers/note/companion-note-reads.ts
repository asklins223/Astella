/**
 * 笔记级的两个读数，供**环境块**（《X》那一行）与**事实块**（裸标题/这一屏那一项）共用：
 *
 *   1. `findNearestNoteTitle` —— "最接近的一篇"（39b §9.3 第二行）；
 *   2. `findNoteRuns` —— "这篇有 N 轮在暂停／进行中"（`start`/`resume` 的服务端回填，
 *      39b §9.8 的 C1）。
 *
 * 为什么是叶子模块：两个消费者在依赖上互不相识（环境块在本文件之外、事实块 import 它），
 * 谁能 import 谁不能，取决于这里放什么；放在叶子上一劳永逸。
 *
 * 标题相似度（"最接近的一篇"那一行的判据，39b §9.3 第二行）。
 *
 * 为什么不用 pg_trgm 的相似度函数或编辑距离：这一行只是"给她一个更接近的真对象"的提示，
 * 不是判决；两字滑窗在中文标题上够用，且完全确定性、可复算、不发额外查询。
 * （那段函数名刻意不写出来：`apps/api/src/__tests__/memory-similarity-threshold.test.ts`
 * 按函数名扫描 api + worker 的源码，写在注释里也会被当成第二个调用点。）
 *
 * 独立成一个叶子模块是为了让 `companion-here-and-now`（《X》未命中那行）与
 * `companion-this-turn-facts`（裸标题未命中那行）共用同一份判据——两处各写一份，
 * 同一句"最接近的是《Y》"迟早有两个答案。
 */

import { sql } from "drizzle-orm";
import { noteVisibleSqlText } from "@astella/shared/note-visibility";
import type { WorkerTransaction } from "../../db.ts";

/** 候选池：最近更新的 N 篇可见笔记。够用且恒定，不为它开窗口函数。 */
const NEAREST_CANDIDATE_LIMIT = 60;

function bigrams(text: string): string[] {
  const chars = Array.from(text.replace(/\s+/g, ""));
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i] + chars[i + 1]);
  return chars.length === 1 ? chars : out;
}

/** 指称文字与标题的两字窗重合度（0–1）。 */
export function titleSimilarity(referent: string, title: string): number {
  const ref = new Set(bigrams(referent));
  if (ref.size === 0) return 0;
  const candidate = new Set(bigrams(title));
  let hit = 0;
  for (const gram of ref) if (candidate.has(gram)) hit += 1;
  return hit / ref.size;
}

export async function findNearestNoteTitle(
  tx: WorkerTransaction,
  scope: { workspaceId: string; userId: string },
  referent: string,
): Promise<{ title: string; score: number } | null> {
  const rows = await tx.execute<{ title: string }>(sql`
    SELECT n.title FROM notes n
    WHERE n.workspace_id = ${scope.workspaceId} AND n.deleted_at IS NULL
      AND ${sql.raw(noteVisibleSqlText("n", `'${scope.userId}'::uuid`))}
    ORDER BY n.updated_at DESC LIMIT ${NEAREST_CANDIDATE_LIMIT}
  `);
  let best: { title: string; score: number } | null = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const score = titleSimilarity(referent, row.title);
    if (score > 0 && (!best || score > best.score)) best = { title: row.title, score };
  }
  return best;
}
