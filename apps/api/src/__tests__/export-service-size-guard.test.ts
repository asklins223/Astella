/**
 * 导出体积守卫的查询形状（2026-10-21）。
 *
 * 为什么要有这一条：`checkExportSize` 里对子表的计数原先写成
 * `.from(noteLearningCardQuestions).where(eq(noteLearningCards.workspaceId, ...))`，
 * 父表没进 FROM，Postgres 直接报 `missing FROM-clause entry for table
 * "note_learning_cards"`。类型检查和单测都不会发现，只有真实导出才炸；移动端
 * 点「导出」得到的是一条 500。这里把「查询里引用的表必须来自 FROM 或 JOIN」
 * 变成静态判据，后续新增计数查询照抄错误写法会直接红。
 *
 * 只扫 `checkExportSize`：`exportWorkspace` 的查询由 visibility 棘轮与集成测试负责。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SERVICE = new URL("../modules/export/service.ts", import.meta.url);
const source = readFileSync(SERVICE, "utf8");

function sizeGuardBody(): string {
  const start = source.indexOf("async function checkExportSize");
  assert.ok(start >= 0, "checkExportSize 不见了：更新导出体积守卫时必须同步本测试");
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, "无法截取 checkExportSize 函数体");
  return source.slice(start, end);
}

test("checkExportSize 的每条计数查询只引用 FROM/JOIN 里的表", () => {
  const queries = sizeGuardBody().split("tx.select({ cnt: count() })").slice(1);
  assert.ok(queries.length >= 12, `体积守卫查询数量减少了（${queries.length}），确认没有漏掉导出集合`);

  for (const [index, query] of queries.entries()) {
    const from = query.match(/^\s*\.from\((\w+)\)/)?.[1];
    assert.ok(from, `第 ${index + 1} 条计数查询没有可识别的 .from()`);

    // 前缀 `tx.` 已被 split 吃掉；引用表名的位置只有 eq(<table>.<column>)。
    const referenced = new Set(
      [...query.matchAll(/\beq\((\w+)\./g)].map((match) => match[1]!),
    );
    const joined = new Set(
      [...query.matchAll(/\.(?:inner|left)Join\((\w+),/g)].map((match) => match[1]!),
    );
    for (const table of referenced) {
      if (table === from) continue;
      assert.ok(
        joined.has(table),
        `第 ${index + 1} 条计数查询从 ${from} 出发，却在 where 里引用了未入 FROM/JOIN 的 ${table}`,
      );
    }
  }
});

/**
 * 私有笔记的正文、历史版本与派生产物都不能只按 workspace_id 导出。
 *
 * 2026-11-16 审查发现：`notes` 那一支带 `visibleNotesCondition(userId)`，而
 * `note_versions` / `note_blocks` / `ai_artifacts` 只按 workspace_id 取，导致协作空间
 * owner 导出时能拿到其他成员 `share_scope='private'` 的正文与历史。这条守卫把
 * “必须回连 notes 并套同一可见性谓词”钉在查询形状上。
 */
test("导出的版本、块与产物都回连 notes 可见性", () => {
  const start = source.indexOf("export async function exportWorkspace");
  assert.ok(start >= 0, "exportWorkspace 不见了：更新导出可见性守卫时必须同步本测试");
  const body = source.slice(start);

  for (const [table, label] of [
    ["noteVersions", "note_versions"],
    ["noteBlocks", "note_blocks"],
    ["aiArtifacts", "ai_artifacts"],
  ] as const) {
    const index = body.indexOf(`from(${table})`);
    assert.ok(index >= 0, `${label} 导出查询不见了`);
    const query = body.slice(index, index + 2000);
    assert.match(query, /visibleNotesCondition\(userId\)/,
      `${label} 导出没有套笔记可见性：私有笔记会跟着 workspace_id 一起被导出`);
    assert.match(query, /\.(?:inner|left)Join\(notes/,
      `${label} 导出没有回连 notes，无法判断它属于哪篇笔记`);
  }
});
