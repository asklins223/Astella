/**
 * 跨轮聚合读侧的**静态守卫**（39d W4-5 ③）。
 *
 * 它盯的是三件"删掉了没有任何别的东西会红"的事：
 *
 *  1. **只读**：§6.7「轮次不存聚合结论」＋§4.4「可以随时重算、随时改口径」。
 *    一个被写进表里的「已走完」会变成第二个事实源，笔记再改一次它不会自己跟上。
 *    判据按**源码形状**钉：这一层里出现任何 insert/update/delete 就是破。
 *  2. **可见性判据没被摘掉**：`notes` 的 RLS 本轮没重开，可见性完全靠每个读点
 *    自己带判据（`note-visibility-read-sites.test.ts` 的同一句话）。这一层有**四发**
 *    经 `notes` 取内容，摘掉任何一处都会让"作者撤回共享之后仍能读到自己那一篇的
 *    跨轮进度"。所以在这里点一遍，而不是指望那个棘轮数得对。
 *  3. **§14.1.1 的界没有被换掉**：读侧必须取 `learning_artifacts.locked_at`，
 *    而不是拿 `result.settledAt`／`updated_at` 顶替——后者是**评分返回时间**，
 *    §14.1.1 头一句就是「以回答锁定先后为界，而非评分返回时间」。
 *
 * 三条都做过**变异自证**：删掉对应的那一处，确认红在这一条断言上（不是红在语法错误）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SOURCE = readFileSync(
  new URL("../modules/note-learning-rounds/route-coverage.ts", import.meta.url),
  "utf8",
);

test("§6.7：跨轮聚合这一层是**只读**的——它把「已走完」算出来，不把它存下来", () => {
  // 变异自证：把 `tx.insert(` 塞进这一层 ⇒ 本条红。
  for (const forbidden of [".insert(", ".update(", ".delete("]) {
    assert.equal(
      SOURCE.includes(forbidden),
      false,
      `route-coverage.ts 出现了 ${forbidden}——聚合结论不许落库（§6.7）`,
    );
  }
});

test("§10.3 末段 / §16.13：每一处经 notes 取内容的读点都带上可见性判据", () => {
  // 三发裸 SQL 都 join 了 notes，因此每一发都要自己判。
  // 变异自证：删掉其中一处 `visibleNotesConditionSql(scope.userId)` ⇒ 本条红。
  // （这条守卫在写下当天就抓到了一处真缺口：`canonical_answer` 那一发没带判据。）
  const joinCount = (SOURCE.match(/\bJOIN public\.notes AS n\b/gi) ?? []).length;
  assert.ok(joinCount >= 3, `预期至少三处经 notes 取内容，实测 ${joinCount}`);
  const guardCount = (SOURCE.match(/visibleNotesConditionSql\(scope\.userId\)/g) ?? []).length;
  assert.equal(
    guardCount,
    joinCount,
    `${joinCount} 处 join notes，${guardCount} 处带了可见性判据——每一处都要带`,
  );
  // 判据本身仍然只有一份：手写 SQL 用文本入口，drizzle 那一发用 `visibleNotesCondition`。
  assert.match(SOURCE, /noteVisibleSqlTextForRawSql/, "裸 SQL 那一支要走同一份规则的文本入口");
  assert.match(SOURCE, /visibleNotesCondition\(scope\.userId\)/, "drizzle 那一支要走同一个条件");
});

test("§14.1.1：帮助条件的界是**回答锁定时刻**，不是评分返回时间", () => {
  // 变异自证：把 `min(a.locked_at)` 换成 `r.updated_at` ⇒ 本条红。
  assert.match(SOURCE, /min\(a\.locked_at\)/, "锁定时刻必须取自 learning_artifacts.locked_at");
  assert.match(SOURCE, /AND a\.locked_at IS NOT NULL/, "只看已锁定的那一行（未锁定的不是一份锁定的回答）");
  // 反面：不能拿结算时刻顶替它。
  assert.equal(
    /min\(a\.locked_at\)[^]*?updated_at/.test(SOURCE),
    false,
    "锁定时刻那一列不能与 updated_at 混用（那是评分返回时间，§14.1.1 明写不作为界）",
  );
});

test("§4.4：分母是**纳入过的全部**，三处取数撞上界都要如实说截断", () => {
  // 静默截断 = 一个看起来完整的假分母（§4.1「不给出全篇覆盖百分比」的同一条纪律）。
  // 变异自证：把任一处的 `truncated` 写死成 false ⇒ 本条红。
  // （第一版这条只数了 `truncated` 出现的次数，换成写死 false 杀不掉——已改成逐处点名。）
  for (const [expression, what] of [
    ["objectives.length > ROUTE_OBJECTIVE_LIMIT_V1", "纳入的问题"],
    ["rows.length > ROUTE_ATTEMPT_LIMIT_V1", "作答"],
    ["rows.length > ROUTE_EXPOSURE_LIMIT_V1", "暴露"],
  ] as const) {
    assert.match(
      SOURCE,
      new RegExp(`const truncated = ${expression.replace(/\./g, "\\.")}`),
      `${what}那一处的截断判定不见了（应为 ${expression}）`,
    );
  }
  assert.match(SOURCE, /LIMIT \$\{ROUTE_/g, "每个集合都要有上界");
  // 截断了还要真的切掉多出来的那一行，而不是把上界之后的留在结果里。
  assert.match(SOURCE, /rows\.slice\(0, ROUTE_ATTEMPT_LIMIT_V1\)/);
  assert.match(SOURCE, /rows\.slice\(0, ROUTE_EXPOSURE_LIMIT_V1\)/);
  assert.match(SOURCE, /objectives\.length = ROUTE_OBJECTIVE_LIMIT_V1;/);
});

test("§4.4：范围缩小这件事只从**计划修订**读，且只认步数变少", () => {
  // 变异自证：把 `< initial` 改成 `!== initial`（改措辞也算缩小）⇒ 本条红。
  // 变异自证二：把 `list.sort(...)` 去掉（拿查询次序当基准）⇒ 本条红。
  assert.match(SOURCE, /parsed\.data\.steps\.length < initial\.data\.steps\.length/,
    "只认步数变少的那一次（基准是这一轮的**初始**计划）");
  assert.match(SOURCE, /reason: row\.reason/, "缩小范围要带上 D3 §5 要求的那句理由");
  // 基准必须是**最初那一版**。查询是 `created_at DESC`，顺着读会把最新的一版
  // 当基准，于是任何一次缩小都比它小——每一次都判成缩小。
  // （集测里那条「只改措辞不算缩小」红的就是这个；守卫要盯着它。）
  assert.match(SOURCE, /list\.sort\(\(a, b\) => a\.ordinal - b\.ordinal\)/,
    "每一轮的计划版本必须按 planOrdinal 升序走（最初 → 现在）");
  assert.match(SOURCE, /const initial = roundPlanV1Schema\.safeParse\(list\[0\]/,
    "基准取的是第一版（最小 ordinal）");
});
