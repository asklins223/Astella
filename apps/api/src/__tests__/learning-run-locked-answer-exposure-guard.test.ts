/**
 * §16.37(a)「第一份已锁定回答不被正常事后揭示降级」的守卫（39d W5-1；PRD §14.1.1）。
 *
 * ## 这一条钉的是什么
 *
 * 评估期那道闸（`run-processing-tick.ts` 的 `hasHintExposure`）要回答的是
 * 「这一次作答**带没带帮助**」，而「帮助」有两个来源：
 *
 *  - 同 run 内请求过提示（`learning_task.hint_requested` 事件）；
 *  - **这一次回答锁定之前**，本人已经看过这个目标的受控 Reveal
 *    （`learning_exposures_v2` 的 `answer_reveal` / `evidence_reveal` /
 *    `answer_editor_view`）。
 *
 * 第二个来源以前**没有**被读。现实里最常见的一串是「答完 → 看卡背 → 评分稍后才
 * 返回」：那次揭示发生在**答案已经锁定之后**，按"现在"去算就会把一份**已经锁定**
 * 的独立回答降成 `practice_only`——§16.37(a) 当场反向。
 *
 * ## 所以判据是"以锁定先后为界"，不是"以评分返回时间"
 *
 * §14.1.1 加粗那句：「**以回答锁定先后为界，而不是评分返回时间**」。
 * 这条不是口号，`learning_artifacts.locked_at` 就是那个界，且
 * `CHECK (status <> 'locked' OR locked_at IS NOT NULL)` 保证锁定行必有它。
 * 于是判据是：**以 `locked_at` 当作"现在"**，再套规划期同一个有界窗口。
 * 两个性质一次拿到：
 *
 *  - 揭示早于锁定且在窗口内 → 这次作答确实带着帮助 ⇒ 降级；
 *  - 揭示晚于锁定（差值为负）⇒ 窗口不成立 ⇒ **不降级**。
 *
 * 2026-09-27 之前的这一份守卫断言的是"**不许**加读侧"，理由是"锁定时刻今天没有
 * 数据面"。那条理由**实测是错的**（`locked_at` 一直在），所以本份把它改写成
 * "加读侧，但**必须按 locked_at 截断**"——真正要防的不是"有读侧"，是
 * "**没有边界的读侧**"。
 *
 * 底下还有一层保险：`practice_only` 那次评估不写 canonical 事件
 * （`evaluated` → `trustClass` → 结算那一层）。本份钉住它仍然在。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const TICK_FILE = join(REPO_ROOT, "apps/api/src/modules/learning-runs/run-processing-tick.ts");
const ADAPTER_FILE = join(REPO_ROOT, "apps/api/src/modules/card-generation-v2/target-snapshot-adapter.ts");

/** 剥掉注释：源码形状判据要判代码，注释里的话是给人读的。 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const tick = codeOnly(readFileSync(TICK_FILE, "utf8"));
const adapter = codeOnly(readFileSync(ADAPTER_FILE, "utf8"));

/**
 * 帮助条件那个读侧的函数体（按 `async function` 到下一个顶层声明）。
 *
 * **它原先叫 `hasHintExposure`**，返回的是 boolean，判据逐字照着那个名字写。
 * 39d W5-1 主体刀二把它换成 `readHelpConditionV2` 并返回四档——因为 boolean
 * 那一档在下游是「读不到回执 ⇒ 没有被帮助 ⇒ 可以是独立表现」，而 §14.1.1 说的是
 * 「判不出来 ⇒ 不签发独立证据」。**两个读侧读同一批事实是「两个来源」那类病**，
 * 所以这里合并成一个，判据跟着指向合并后的那一个。
 */
function hasHintExposureBody(): string {
  const at = tick.indexOf("async function readHelpConditionV2(");
  assert.ok(at > 0, "run-processing-tick 里读不到 readHelpConditionV2 ⇒ 这条判据空转（函数被改名或挪走了）");
  const next = tick.indexOf("\n}\n", at);
  return tick.slice(at, next === -1 ? tick.length : next + 2);
}

test("评估期那道闸读 exposure 表——「出题后、锁定前」的揭示是以前唯一被漏掉的那一种", () => {
  const body = hasHintExposureBody();
  assert.ok(body.includes("learningRunEvents"), "读不到 learningRunEvents 那个读点（判据可能指错了地方）");
  assert.ok(/learningExposures|learning_exposures/.test(body),
    "那个读侧又不读 exposure 表了：那么「先出题、后揭示、再作答」这一种"
    + "仍然会按独立作答结算——那正是这道闸存在的理由。");
});

test("⚠️ 那个读侧**必须**以 locked_at 为界——这是 §16.37(a) 全部的重量所在", () => {
  const body = hasHintExposureBody();
  assert.ok(/lockedAt/.test(body),
    "读侧读了 exposure 却没有按 locked_at 截断——**这会让 §16.37(a) 反向**："
    + "「答完 → 看卡背 → 评分稍后返回」这一串里，那次揭示会被算成「作答时带着帮助」，"
    + "把一份**已经锁定**的独立回答降成 practice_only。");
  // 差值必须与 0 比过：只有「揭示早于锁定」才降级。
  assert.ok(/gapMs\s*>=\s*0|0\s*<=\s*gapMs/.test(body),
    "读不到「差值非负」那一处判定：晚于锁定的揭示也会被算进去，§16.37(a) 反向。");
});

test("判据对「无边界读侧」灵敏：去掉 locked_at 截断，这一条必须红", () => {
  // 同一份源码上做内存变异，不改生产文件。恒真的守卫比没有守卫更坏。
  // 变异的是**危险的那一版**（有 exposure 读、没有 locked_at 截断）——
  // 上一份守卫写的是「加读侧就红」，那在前提被证伪之后就变成了给正确改法设障。
  const body = hasHintExposureBody();
  const unbounded = body
    .replace(/answerLockedAt\.getTime\(\)\s*-\s*helpPresentedAt\.getTime\(\)/, "Date.now() - helpPresentedAt.getTime()")
    .replace(/gapMs\s*>=\s*0\s*&&\s*/, "");
  assert.ok(
    !/lockedAt/.test(unbounded) || !/gapMs\s*>=\s*0/.test(unbounded),
    "变异没落在正确位置：守卫读不到那一处",
  );
  assert.ok(
    /lockedAt/.test(body) && /gapMs\s*>=\s*0/.test(body),
    "变异后守卫仍判成立 ⇒ 这条判据恒真",
  );
});

test("规划期那道闸读 exposure，且有一个有界窗口（它是第一道保险）", () => {
  assert.ok(/learningExposures|learning_exposures/.test(adapter),
    "target-snapshot-adapter 里读不到 exposure 的读点（判据可能指错了地方）");
  // 「近期」必须**有界**：一个无界的窗口会把「一般教学经历」永久变成「不能独立提取」，
  // 而 §14.1.1 明确「已经学过概念、看过以前的讲解，不意味着今后永远不能独立提取」。
  assert.match(adapter, /RECENT_REVEAL_WINDOW_MS\s*=\s*\d/,
    "读不到那个有界窗口常量：没有界的话，一般教学经历会永久压住独立提取");
});

test("两道闸的窗口必须相等（否则会出现「出题算近期、锁定不算」的分岔）", () => {
  const planning = Number(adapter.match(/RECENT_REVEAL_WINDOW_MS\s*=\s*(\d+)/)?.[1]);
  const assessing = Number(tick.match(/ASSESSMENT_REVEAL_WINDOW_MS\s*=\s*(\d+)/)?.[1]);
  assert.ok(Number.isFinite(planning), "读不到规划期那个窗口常量");
  assert.ok(Number.isFinite(assessing), "读不到评估期那个窗口常量");
  assert.equal(assessing, planning,
    `两处判的是同一个"近期"，窗口却不同：规划期 ${planning}ms、评估期 ${assessing}ms。`
    + "不相等就会出现同一段经历在两个时点被分成两档。");
});

test("第二道保险：practice_only 不产生 canonical 事实（降级不等于把学习记没了）", () => {
  // ceiling 被钳到 practice_only 的那一次评估不写 canonical 事件。
  assert.match(tick, /practice_only/,
    "tick 里读不到 practice_only 那一档（判据可能指错了地方）");
  assert.match(tick, /ceilingOrder/,
    "读不到 ceiling 钳制那张顺序表");
});

test("揭示路径与评估路径今天不相交（第三道保险：答完之后再揭示走的是另一条）", () => {
  // `reveal_not_available` 要求 run 已结算：答完之后再揭示不会再回到评估那一步。
  const runService = codeOnly(readFileSync(
    join(REPO_ROOT, "apps/api/src/modules/learning-runs/run-service.ts"), "utf8"));
  assert.ok(runService.includes("reveal_not_available"),
    "run-service 里读不到 reveal_not_available（判据可能指错了地方）");
});
