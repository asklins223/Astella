/**
 * 「这条目标的来源更新了吗」那份比较只准存在一份（39d D3 §5.1 末段：判定不许各写一份）。
 *
 * 它此前被抄在三地上：目标表面的详情一格（`computeFreshness`）、同一文件列表装配里
 * 又内联一份、星图仓储再一份。三地输入形状不同、规则相同，而"规则相同的东西有三份"
 * 就是同一颗目标在首页与星图上各说一句话的预备状态——那正是 §5.1 不许发生的事。
 *
 * 判据取的是**最外层的字面量**：这两份文件里不许再出现那两个档名，出现即说明有人
 * 又开始自己算。为什么不用"比较式"当判据：`card-generation-v2/helpers.ts` 里那句
 * `currentVersionId !== row.noteVersionId` 是**运行级**的过时判定（它还要重算 source 哈希），
 * 与本判据不是同一件事，按比较式扫会误伤。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SCANNED = [
  "../modules/learning-objectives/surface-service.ts",
  "../modules/note-deepening/topology-repository.ts",
];
/** 三档的字面量名（`fresh` 太通用，不作为判据）。 */
const FORBIDDEN = ['"source_outdated"', '"legacy_unreviewed"'];
const CALL = "objectiveSurfaceFreshnessV1(";

function source(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/** 抹掉注释再判：注释里复述一句档名不算自己算。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""))
    .replace(/\/\/[^\n]*/g, "");
}

test("两份文件都真的调了那一份判据（守卫自己先要读到东西）", () => {
  for (const rel of SCANNED) {
    const text = stripComments(source(rel));
    assert.ok(text.length > 1000, `${rel} 读到了内容（否则下面的断言都是空的）`);
    assert.ok(text.includes(CALL), `${rel} 必须调 ${CALL}，不许自己算`);
  }
  // 阳性对照：那两个档名确实住在唯一那一份实现里，不是"哪里都没有"。
  const contract = stripComments(source(
    "../../../../packages/shared/src/contracts/learning-objective-surface-contracts.ts",
  ));
  for (const literal of FORBIDDEN) {
    assert.ok(contract.includes(literal), `唯一那份实现里应当有 ${literal}`);
  }
});

test("两份文件里都不再**产出**那两个档名（读它可以，再算一次就红）", () => {
  for (const rel of SCANNED) {
    // `x === "source_outdated"` 是**消费者**把档位映射成界面状态（surface 的 personal state、
    // 星图的节点状态两处），那是这条判据存在的目的，不算抄一份。抹掉比较用法之后还剩下来的，
    // 只能是"有人又开始自己算这一档"。
    const producing = stripComments(source(rel))
      .replace(/(?:===|!==|==|!=)\s*"(?:source_outdated|legacy_unreviewed)"/g, "");
    for (const literal of FORBIDDEN) {
      assert.doesNotMatch(
        producing,
        new RegExp(literal.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${rel} 又自己算了一次 ${literal}——把它接回 objectiveSurfaceFreshnessV1`,
      );
    }
  }
});
