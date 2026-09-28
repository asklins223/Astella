/**
 * §14.2「待复核时不持续放大结论」的**执法点**不许被悄悄拆掉（39d W5-5）。
 *
 * 这份判据用静态读源码，而不是起库跑一整轮结算——后者要为 `applyDemonstratedSchedule`
 * 造出 run/task/artifact/assessment/commit 全套夹具，代价与它挡住的那一行不成比例
 * （真实闸的行为由 `assessment-disputes-postgres.integration.ts` 那条
 * 「结算闸」在真库上量）。这里要挡的是另外两件更便宜也更常发生的事：
 *
 *  1. **有人把调用删了**。删掉之后类型检查照过、单测照过、结算照跑，
 *     只是"争议期间那一次观察真的不推进间隔"这条产品规则悄悄没了——正是本仓
 *     §16.22 要挡的那一类静默劣化。
 *  2. **有人把闸挪到 `consume_pending` 之后**。那样 `consume_pending` 会先把那条
 *     待办写成 `completed`、我们再返回"不排期"，用户队列里就留下一个没有对象的
 *     提醒（§8.5 明写不能留下无对象的提醒）。顺序在这里是**语义的一部分**，
 *     而它不体现在任何类型上。
 *
 * 判据的形状与 `review-schedule-single-writer.test.ts` 那族一致：按函数切片，
 * 比对"闸在第一次排期写入之前"这一个事实。刻意**不**断言闸只出现一次——
 * `applyDemonstratedSchedule` 与 `applyUnableSchedule` 是两个独立入口，各调一次是
 * 对称的，不是抄写。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const TICK_FILE = resolve(
  import.meta.dirname,
  "..",
  "modules/learning-runs/run-processing-tick.ts",
);

/**
 * **先剥注释再定位**。这份判据按字符位置比"闸在消费之前"，所以注释里只要提到
 * `consume_pending` 就会把位置算错——第一版就栽在这：闸上面那句
 * 「同样挡在 consume_pending 之前」的注释比闸本身更早命中，整个判据恒红。
 *
 * 与 `learning-exposure-kinds.test.ts` 同一处教训：扫源码的判据必须先把注释剥掉，
 * 否则改一句注释就能让判据变瞎或变红。剥完再切片，位置始终来自同一份文本。
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const source = stripComments(readFileSync(TICK_FILE, "utf8"));

/** 取 `function <name>(` 到下一个顶层 `}` 之前的那一段。 */
function sliceFunction(name: string): string {
  const at = source.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `run-processing-tick.ts 里找不到 ${name}`);
  // 下一个顶层函数声明就是这一段的末尾：缩进为 0 的 `async function` / `function`。
  const rest = source.slice(at + 1);
  const next = rest.search(/\n(?:async )?function \w/);
  assert.notEqual(next, -1, `找不到 ${name} 的结束位置`);
  return rest.slice(0, next);
}

const GATE = "disputeAllowsScheduleChange";
const MARK_APPLIED = "markCorrectionAppliedV2";
const RESOLUTION = "disputeScheduleResolutionV2";

test("demonstrated 与 unable 两个排期入口都先问这道闸", () => {
  for (const name of ["applyDemonstratedSchedule", "applyUnableSchedule"]) {
    const body = sliceFunction(name);
    assert.ok(
      body.includes(GATE),
      `${name} 没有调用 ${GATE}：§14.2「待复核时不持续放大结论」在 ${name} 这一档失效了`,
    );
  }
});

test("闸挡在消费 pending 之前：先消费后挡会留下一个没有对象的提醒（§8.5）", () => {
  for (const name of ["applyDemonstratedSchedule", "applyUnableSchedule"]) {
    const body = sliceFunction(name);
    const gateAt = body.indexOf(GATE);
    assert.notEqual(gateAt, -1, `${name} 里找不到 ${GATE}`);
    // `consume_pending` 那一档把待办写成 completed；闸必须在它之前。
    const consumeAt = body.indexOf("consume_pending");
    assert.notEqual(consumeAt, -1, `${name} 里找不到 consume_pending 那一档（判据可能过期了）`);
    assert.ok(
      gateAt < consumeAt,
      `${name} 把 ${GATE} 挪到了 consume_pending 之后：那条待办会先被消费掉再返回「不排期」，`
      + "用户队列里就留下一个没有对象的提醒（§8.5）",
    );
  }
});

/**
 * 「修正」那一档的更正**要被消费一次**（§9.6「不能重复消费同一日程」）。
 *
 * 系统侧的复核（`dispute-recheck.ts`）写完更正记录就结束；消费方是结算这一发。
 * 少了 `markCorrectionAppliedV2` 这一句，那条更正就是一条"有人写、没人读"的记录：
 * 类型检查过、其它单测过、复核照跑，而 `markCorrectionAppliedV2` 至今**零生产调用方**
 * ——这正是 §16.25 要防的"两种更正混算"里最容易发生的那一种。
 *
 * 同样按函数切片：闸的**函数体**里必须出现那一句消费动作，且它必须排在放行之前
 * （消费之后才谈得上放行）。而"消费的是交回来的那一条"也要钉——随手挑一个
 * assessmentId 也能让这句话通过，那不是消费，是随手写一行。
 */
test("复核判成「修正」时，更正要在这道闸里被消费一次，而且消费的是交回来的那一条（§9.6）", () => {
  const body = sliceFunction(GATE);
  assert.ok(
    body.includes(RESOLUTION),
    `${GATE} 不再读 ${RESOLUTION}：它交回的「该消费哪一条」没人接（判据可能过期了）`,
  );
  const consumeAt = body.indexOf(MARK_APPLIED);
  assert.notEqual(consumeAt, -1, `${GATE} 里没有 ${MARK_APPLIED}：更正写了没人消费，`
    + `${MARK_APPLIED} 仍是零生产调用方（§9.6／§16.25）`);
  // 用**最后一个**放行点：函数开头那个「不是 create/consume 就放行」的早退在消费
  // 之前是正常的（那一档压根没有更正要消费），拿第一个比会恒红。
  const returnAt = body.lastIndexOf("return { allowed: true }");
  assert.notEqual(returnAt, -1, `${GATE} 里找不到放行那一行（判据可能过期了）`);
  assert.ok(consumeAt < returnAt, `${GATE} 在消费更正之前就放行了：这一发就没有消费者了`);
  assert.ok(
    body.includes("correctionToApply.assessmentId"),
    `${GATE} 消费的不是 ${RESOLUTION} 交回的那一条更正`,
  );
  // 消费那一支必须**真的**被 `correctionToApply` 守着。少了这一条，把条件改成
  // `if (false)`／`if (someOtherFlag)` 就能让上面三句全部照过，而运行时一次更正
  // 都不消费——这是"静态扫源码"这一族判据最容易有的一个洞，变异实测过。
  // 匹配时不写死接收者变量名（`resolution` 改个名不该让判据红），只钉住**属性**。
  assert.ok(
    /if\s*\(\s*[A-Za-z_$][\w$]*\.correctionToApply\s*\)\s*\{/.test(body),
    `${GATE} 里消费更正的那一支没有守在 correctionToApply 上：`
    + "把它关掉之后上面几句会照过，而运行时一次更正都不消费（§9.6）",
  );
});

test("判据自己的灵敏度：把闸挪到消费之后，这一份必须跟着翻", () => {  // 合成一段"先消费后挡"的函数体，按同一条判据判一次。
  const swapped = stripComments(`async function fake() {
  // 这句注释提到 consume_pending，不该影响判据。
  if (authorization.kind === "consume_pending") {
    await tx.update(reviewSchedules).set({ status: "completed" });
  }
  const g = await ${GATE}(tx, c, a);
  if (!g.allowed) return g;
}`);
  const gateAt = swapped.indexOf(GATE);
  const consumeAt = swapped.indexOf("consume_pending");
  assert.ok(consumeAt > 0, "剥注释把代码本身也剥掉了，判据是瞎的");
  assert.ok(gateAt > consumeAt, "合成样本的顺序构造错了，判据是瞎的");
  assert.ok(!(gateAt < consumeAt), "判据没有抓出「先消费后挡」这个真实的坏形状");
  // 真正想量的是「注释里提到 consume_pending 不会多出一次更早的命中」——
  // 那正是第一版恒红的形状。加一句这种注释，剥完之后它不该再被数进去。
  const withComment = `${GATE}(tx); if (authorization.kind === "consume_pending") {}`;
  const alsoCommented = `// 挡在 consume_pending 之前\n${withComment}`;
  const hits = (text: string, needle: string) => text.split(needle).length - 1;
  assert.equal(hits(alsoCommented, "consume_pending"), 2, "合成样本里应当有两处");
  assert.equal(
    hits(stripComments(alsoCommented), "consume_pending"),
    1,
    "剥注释之后注释里那处不见了；判据仍会先命中注释就说明这里没剥干净",
  );
});
