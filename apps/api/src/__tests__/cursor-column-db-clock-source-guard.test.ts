import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * P2-12：**被当作翻页游标用的时间列，写入时必须用 DB 时钟。**
 *
 * ## 为什么游标列特别
 *
 * 一般的时间戳用应用时钟问题不大：它只用于展示与"最近多久"这类判断，
 * 差几十毫秒没有后果。
 *
 * 游标列不一样。它参与的是 `(<ts>, <id>) < (<cursorTs>, <cursorId>)` 这个
 * **元组比较**，翻页的正确性直接建立在"排在前面的行时间戳一定更小"上。
 *
 * ## 应用时钟在这里会怎样漏项
 *
 * 同一个请求可能落在**不同副本**上，各副本的系统时钟有偏差。设副本 A 快 2 秒：
 * A 写的一条记录 `updatedAt` 落在"未来"，客户端翻过这一页之后，
 * 那条记录仍然排在游标之后——**下次再来时又会被看到一次**；
 * 反过来副本 B 慢 2 秒，新写的记录时间戳落在游标**之前**，
 * 客户端翻过去就**永远看不到它**。
 *
 * 两种症状都不报错，只是"有一篇笔记要么多出现一次、要么一次都不出现"。
 *
 * ## 为什么不干脆全仓都用 DB 时钟
 *
 * 全仓有 60 多处 `updatedAt: new Date()`，绝大多数只是审计时间戳。
 * 把它们一并改掉会牵动几十个模块的单元测试（mock 的是 JS 值）。
 * 这里只钉**游标列**——正确性真正依赖它的那些。
 */

/** 参与游标元组比较的列（表格名 → 列名）。 */
const CURSOR_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["notes", "updatedAt"],
  ["noteExpansionTasks", "updatedAt"],
  ["noteRecallRecords", "createdAt"],
  ["noteOverviews", "createdAt"],
  ["noteAnnotations", "createdAt"],
  ["noteLearningArtifacts", "createdAt"],
  ["noteLearningRounds", "createdAt"],
];

/** 只有 insert 时写入的列——DB 侧 `defaultNow()` 已经保证了时钟来源。 */
const INSERT_ONLY = new Set([
  "noteRecallRecords.createdAt",
  "noteOverviews.createdAt",
  "noteAnnotations.createdAt",
  "noteLearningArtifacts.createdAt",
  "noteLearningRounds.createdAt",
]);

const API_ROOT = new URL("..", import.meta.url).pathname;
const WRITE_SITES = [
  "modules/note/service.ts",
  "modules/note/document-state.ts",
  "modules/note-expansions/service.ts",
] as const;

test("游标列的写入不用应用时钟", () => {
  const offenders: string[] = [];
  for (const rel of WRITE_SITES) {
    const source = readFileSync(join(API_ROOT, rel), "utf8");
    for (const [table, column] of CURSOR_COLUMNS) {
      if (INSERT_ONLY.has(`${table}.${column}`)) continue;
      // `updatedAt: new Date()` 与 `updated_at: new Date()` 两种写法都要抓
      const appClock = new RegExp(`${column}\\s*:\\s*new Date\\(\\)`);
      if (appClock.test(source)) {
        offenders.push(`${rel}: ${table}.${column} 仍在用应用时钟`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "这些游标列还在用应用时钟写入：\n" + offenders.join("\n")
    + "\n副本之间有系统时钟偏差时，翻页会漏项（慢的副本新写的记录排到游标之前，"
    + "客户端翻过去就再也看不到）或重复（快的副本把记录写到游标之后）。"
    + "\n改法：写成 `updatedAt: sql` + '`now()`' + '`'，让时间戳由 DB 出。",
  );
});

test("【自证】判据会红：放一个应用时钟写入进去必须被抓", () => {
  const source = readFileSync(join(API_ROOT, WRITE_SITES[0]), "utf8");
  const polluted = source + "\nconst _probe = { updatedAt: new Date() };\n";
  assert.ok(
    /updatedAt\s*:\s*new Date\(\)/.test(polluted),
    "自证样本没造好：判据必须认得出 `updatedAt: new Date()`",
  );
  // 自证不该改动磁盘上的文件
  assert.ok(
    !/updatedAt\s*:\s*new Date\(\)/.test(source),
    "自证：真实文件里不该还有应用时钟的游标列写入",
  );
});

/**
 * 抽出 `.update(<table>...)` 这一次调用的**完整**文本。
 *
 * 原来用的是「往后看 200 个字符」的窗口——那是这条判据自己的盲区：
 * `.set()` 里多两行就滑出去了，而它滑出去的方向正是"新增了一条此前不存在的 update"。
 */
/** modules/ 下全部非测试源码。 */
function allModuleSources(dir = join(API_ROOT, "modules"), out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) allModuleSources(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
      out.push(p.replace(`${API_ROOT}`, ""));
    }
  }
  return out;
}

function updateCallsOn(source: string, table: string): string[] {
  const marker = `.update(${table})`;
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const i = source.indexOf(marker, from);
    if (i === -1) break;
    // 从 marker 起做括号平衡，把整次调用切出来
    let depth = 0;
    let j = i + marker.length - 1;
    for (; j < source.length; j += 1) {
      const ch = source[j]!;
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    // `.update(x).set({...})` 的 `.set(...)` 还要再吃一段
    let k = j + 1;
    const setMarker = ".set(";
    if (source.startsWith(setMarker, k)) {
      let d = 0;
      for (let m = k + setMarker.length - 1; m < source.length; m += 1) {
        const ch = source[m]!;
        if (ch === "(") d += 1;
        else if (ch === ")") {
          d -= 1;
          if (d === 0) { k = m + 1; break; }
        }
      }
    }
    out.push(source.slice(i, k));
    from = k;
  }
  return out;
}

test("insert-only 的游标列由 DB defaultNow() 保证时钟来源", () => {
  // 这些列没有 update 路径，只在 insert 时写入，值来自 schema 的 `.defaultNow()`。
  // 钉住"确实没有 update 路径"，免得将来加一个 update 却用应用时钟。
  for (const key of INSERT_ONLY) {
    const [table, column] = key.split(".");
    // ⚠️ 这里扫的是**整个 modules/**，不是 WRITE_SITES 那三个文件。
    //    原来只扫三个，而 noteAnnotations 写在第四个文件里——
    //    于是"新增了一条 update"这件事判据根本看不到（突变 2 当时就因此全绿）。
    for (const rel of allModuleSources()) {
      const source = readFileSync(join(API_ROOT, rel), "utf8");
      for (const call of updateCallsOn(source, table)) {
        assert.ok(
          !new RegExp(`${column}\\s*:\\s*new Date\\(\\)`).test(call),
          `${rel} 出现了对 ${key} 的应用时钟 update——`
          + "它原本是 insert-only（DB defaultNow），加了 update 就必须一起换时钟。\n"
          + "这一发改的是：" + call.replace(/\\s+/g, " ").slice(0, 160),
        );
      }
    }
  }
});
