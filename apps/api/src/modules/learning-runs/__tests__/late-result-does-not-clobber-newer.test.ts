/**
 * W7-8 刀四：「迟到的评分不覆盖**较新表现**」——两处机制今天**已经在**，但没有判据钉住。
 *
 * 39d W7-8 的判据是「迟到的评分不覆盖用户改期/停订/较新表现」，三半分给了三刀：
 *  - **改期** → 刀二：结算写下一档时过一遍手动日期约束（此前会悄悄提前）。
 *  - **停用** → 刀三：边界问来源级停用（此前那颗按钮拨了等于没拨）。
 *  - **较新表现** → **这一档**：两处机制今天就在，但**没有任何判据钉住**。
 *
 * ## 两处机制分别挡什么
 *
 *  1. **`consume_pending` 那一支的 generation CAS**（`run-processing-tick.ts`）：它要消费
 *     的那一格若已被别人动过（generation 变了），`UPDATE … RETURNING` 取不到行 ⇒
 *     `reasonCode: "stale"`，0 副作用。这挡住"run A 在跑、run B 先落地并推进了安排、
 *     A 回来还想按自己的授权消费那一格"。
 *  2. **边界的 `onConflictDoNothing()`**（`review-schedule-boundary.ts`）：`create_initial`
 *     那一支**没有** generation CAS，但它撞上已有安排时**不覆盖**——交回**库里那一行**
 *     的 `nextReviewAt`，而不是自己算的那个。这挡住"run A 落在 B 后面，却把 B 排好的
 *     到期日改回 A 自己算的那个"。
 *
 * ## 为什么"已经在"要专门钉
 *
 * 这两处都长得像**实现细节**而不是合同：`onConflictDoNothing` 可以被"顺手改成 upsert
 * 以便排期更准"（那样就静默覆盖了），CAS 那一行可以在重构里被"清理掉重复条件"。
 * 两者任何一次改动**都不会让别的测试红**——而后果是"较新表现被更旧的评分覆盖"，
 * 屏上读不出来（库里那行的 `nextReviewAt` 只是变成了另一个值）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (relative: string) =>
  readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "..", "..", relative), "utf8");

const TICK = read("apps/api/src/modules/learning-runs/processing/run-processing-tick.ts");
const BOUNDARY = read("apps/api/src/modules/review/review-schedule-boundary.ts");

test("W7-8 刀四：`consume_pending` 那一支有 generation CAS，取不到行就 0 副作用", () => {
  // A 在跑、B 先落地推进了安排、A 回来按旧授权消费 ⇒ generation 对不上 ⇒ stale。
  assert.match(
    TICK,
    /eq\(reviewSchedules\.generation, authorization\.scheduleGeneration\)/,
    "消费那一支的 generation CAS 没了：A 回来还能消费掉 B 推进过的那一格。",
  );
  assert.match(
    TICK,
    /reasonCode: "stale"/,
    "取不到行时没有交回 stale：那一格现在是静默地什么都不做还是静默地继续，要能读出来。",
  );
});

test("W7-8 刀四 正对照：边界撞上已有安排时**不覆盖**（这条挡 `create_initial` 迟到）", () => {
  // `create_initial` 那一支没有 generation CAS，它靠边界"不覆盖"保命。
  // 改成 upsert（ON CONFLICT DO UPDATE）的那一刻，就是较新表现被更旧的评分覆盖的那一刻。
  assert.match(
    BOUNDARY,
    /\.onConflictDoNothing\(\)/,
    "边界不再用 onConflictDoNothing：改成 upsert 之后，一个**迟到的** create_initial "
    + "结算会把自己算的到期日写回去，覆盖掉已经落地的那一次安排（§16.19「迟到判定作为"
    + "带时间的补充回执挂回原轮」——原轮的数据可以补写，安排不行）。",
  );
  assert.ok(
    !/onConflictDoUpdate/.test(BOUNDARY),
    "边界改成了 onConflictDoUpdate：那就是「覆盖库里那一条」，与上一条同一种后果。",
  );
});

test("W7-8 刀四 正对照：撞上已有安排时交回的是**库里那一条**的到期日", () => {
  // 与上一条配套：不仅不覆盖，还要把库里那个值交回去——否则回执与库里对不上，
  // 屏上会出现"这个没人持有的日期"。
  // 从冲突那一支的回读锚点切起，而不是从 onConflictDoNothing 切起——第一版用后者切了
  // 900 个字符，而回读在更靠后，于是**判据红在一个不存在的缺陷上**。切窗要落在
  // 真正要看的那一块上。
  const readBackAt = BOUNDARY.indexOf("const [existing] = await tx", BOUNDARY.indexOf("onConflictDoNothing"));
  assert.ok(readBackAt > 0, "边界没有冲突之后的回读：那一支的 id 只能靠猜");
  const conflictBranch = BOUNDARY.slice(readBackAt, readBackAt + 1200);
  assert.match(
    conflictBranch,
    /nextReviewAt: existing\.nextReviewAt/,
    "冲突那一支没有交回库里那一行的 nextReviewAt：回执会报一个没人持有的日期。",
  );
});
