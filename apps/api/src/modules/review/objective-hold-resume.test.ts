/**
 * 「恢复此目标并开启」这条组合命令的判据（39d W5-6 刀一；39 §9.1 规则表行 3）。
 *
 * 这一格原来只判"服务返回什么"。它真正要挡住的是三件**说错了也不会有人立刻发现**的事，
 * 所以判据大半是按源码形状钉的：
 *
 *  1. **不能只解除不排期**。`releaseObjectiveHoldV2` 撤下去的那些排期是 `dismissed`（终态），
 *     所以少写一次排期，用户点完「恢复」之后那个目标就永远不回到队列——而界面上那颗按钮
 *     承诺的是"恢复**并开启**"。这一条是最容易在重构时被"简化"掉的。
 *  2. **不能用一次观察策略来排首次回访**。`calculateDiscreteV2Schedule` 要一个 outcome；
 *     硬凑一个 `correct` 等于把一次从没发生过的表现记成发生过（§9.2 三种事实分开）。
 *  3. **顺序不能反**。先排期后解除的话，同事务内边界会拿刚写下 `released_at` 的那一行
 *     问出"还挡着吗"，于是自己把自己挡回去，而这一发还会报"已开启"。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { resumeObjectiveRequestV2Schema } from "./objective-review-holds.ts";

// apps/api/src/modules/review → 上溯五级到仓库根。
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");
const HOLDS_FILE = join(REPO_ROOT, "apps/api/src/modules/review/objective-review-holds.ts");
const ROUTES_FILE = join(REPO_ROOT, "apps/api/src/modules/review/routes.ts");

const source = readFileSync(HOLDS_FILE, "utf8");

/** 这个函数体在源码里的起止（按 `export async function` 到下一个顶层 `export`）。 */
function resumeFnBody(): string {
  const start = source.indexOf("export async function resumeObjectiveAndScheduleV2");
  assert.ok(start > 0, "服务里读不到 resumeObjectiveAndScheduleV2 ⇒ 这条判据空转");
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

/**
 * 剥掉行注释与块注释后再判。
 *
 * 不剥的话判据会**两个方向都不可信**：函数上方那段头注里就写着"不调
 * `calculateDiscreteV2Schedule`"，于是「不许调它」那条会因为注释里提到过它而恒红；
 * 反过来，将来谁在函数体里写一句解释为什么**可以**调它，判据就假绿。
 * 源码形状判据要判的是**代码**，注释里的话是给人读的。
 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("组合动作：排期真的发生了，不只是解除排除", () => {
  const body = resumeFnBody();
  assert.ok(body.includes("releaseObjectiveHoldV2("), "没有解除排除这一半");
  assert.ok(body.includes("ensurePendingReviewScheduleV2("),
    "只解除不排期：dismissed 是终态，解除之后那个目标永远回不到队列，而界面上写的是「恢复并开启」");
});

test("顺序：先解除、后排期（反过来会自己把自己挡回去）", () => {
  const body = resumeFnBody();
  const releaseAt = body.indexOf("releaseObjectiveHoldV2(");
  const scheduleAt = body.indexOf("ensurePendingReviewScheduleV2(");
  assert.ok(releaseAt > 0 && scheduleAt > releaseAt,
    "排期排在解除之前：同事务内边界读得到刚写的 released_at，于是这一发会自己挡自己，"
    + "而回执还写着「已开启」——那是最坏的一种：既没排上，又说排上了");
});

test("不调观察策略来排首次回访（§9.2 三种事实分开）", () => {
  const body = codeOnly(resumeFnBody());
  assert.ok(!body.includes("calculateDiscreteV2Schedule"),
    "「恢复并开启」调了 calculateDiscreteV2Schedule：那个函数要一个 outcome，"
    + "而这里用户什么都没做——硬凑一个 correct 等于把一次从没发生过的表现记成发生过");
  assert.ok(body.includes("DISCRETE_V2_POLICY_VERSION"),
    "policyVersion 没有沿用策略那一档 ⇒ 这一条排期会在账上认不出是哪份策略排的");
});

test("首档到期时刻走策略自己那个 `discreteV2FirstDueAt`，不自己算天数", () => {
  // 第一版在这里自己写了一份 `RESUMED_FIRST_INTERVAL_DAYS = TIERS[0]` 并用
  // `at.getTime() + N * 86_400_000` 算到期——那既把阶梯头一档抄了第二份（阶梯改了这里
  // 不会跟着改），又绕过了那个函数里的 `addMs` 溢出护栏。2026-09-27 已还这笔债。
  const body = codeOnly(resumeFnBody());
  assert.match(body, /nextReviewAt: discreteV2FirstDueAt\(at\)/,
    "没有走策略那个 `discreteV2FirstDueAt`：自己算天数会绕过 addMs 溢出护栏");
  assert.match(body, /intervalDays: DISCRETE_V2_FIRST_INTERVAL_DAYS/,
    "间隔天数没有取自策略导出的头一档常量");
  assert.ok(!/getTime\(\)\s*\+/.test(body),
    "这一格自己在用 getTime 算到期时刻 ⇒ addMs 护栏被绕过了");
  assert.ok(!/RESUMED_FIRST_INTERVAL_DAYS/.test(codeOnly(source)),
    "本文件里还留着那份重复的阶梯头一档常量（一个来源就够了）");
});

test("排的是持续安排，且共用那一格唯一键（0297 头注第 1 条）", () => {
  const body = codeOnly(resumeFnBody());
  assert.match(body, /reminderKind:\s*"sustained"/,
    "「开启」不是「仅提醒这一次」：那一档处理后不自动产生后续提醒，与这里要的相反");
});

test("排不动时如实说 still_held，不报「已开启」", () => {
  const body = codeOnly(resumeFnBody());
  assert.ok(body.includes('status: "still_held"'),
    "没有 still_held 那一档：边界把这一发挡下时会被报成排上了");
  // 路由那一侧也不能把它当成功。
  const routes = readFileSync(ROUTES_FILE, "utf8");
  assert.ok(routes.includes('error: "objective_held"'),
    "路由没有把 still_held 翻成错误：用户会看到「已开启」，而库里什么都没排");
  assert.ok(routes.includes("reply.code(409)"),
    "still_held 不是 200：它是「这一发没有做成」，与「做成了」是两句不同的话");
});

test("三种结果在回执里分开说（新建／沿用已有的那一格）", () => {
  const routes = readFileSync(ROUTES_FILE, "utf8");
  assert.ok(routes.includes("resumed_and_scheduled"),
    "回执没有区分「排上了新的」与「沿用已有的那一格」");
  assert.ok(routes.includes("reused_existing"),
    "回执没有把「沿用已有」这一档说出来 ⇒ 界面会把两件不同的事念成同一句");
});

test("排期走唯一边界，不裸 insert（0287 的单写者判据会再拦一次，这里先说清为什么）", () => {
  const body = codeOnly(resumeFnBody());
  assert.equal((body.match(/\.insert\(/g) ?? []).length, 0,
    "这一格出现了裸 insert：0287 的部分唯一索引会把它变成一次 23505，"
    + "而且绕过边界就绕过了目标级排除的执法");
});

test("可见性判据与「设排除」那一侧同档（读不到翻 404，不是 500 也不是 409）", () => {
  const body = codeOnly(resumeFnBody());
  assert.ok(body.includes("visibleNotesCondition("),
    "没有按本人可见的笔记判：撤销权限后仍能用旧目标 id 排出一条自己的安排");
  assert.ok(body.includes("ObjectiveHoldNoteNotFoundV2"),
    "读不到笔记时没有抛与 set 那一侧同档的错误，路由就分不出 404");
});

test("请求体必须带 noteId（2026-09-27 起这一发会写 review_schedules）", () => {
  const ok = resumeObjectiveRequestV2Schema.safeParse({
    objectiveId: "22222222-2222-4222-8222-222222222222",
    noteId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(ok.success, true);
  const missing = resumeObjectiveRequestV2Schema.safeParse({
    objectiveId: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(missing.success, false,
    "noteId 变成可选：这一发已经会写 review_schedules，而没有笔记就没法判可见性");
});

test("判据对「自己算天数」灵敏：换回 getTime 写法，判据必须跟着红", () => {
  // 同一份源码上做内存变异，不改生产文件。恒真的判据比没有判据更坏。
  const mutated = codeOnly(resumeFnBody()).replace(
    /nextReviewAt: discreteV2FirstDueAt\(at\)/,
    "nextReviewAt: new Date(at.getTime() + DISCRETE_V2_FIRST_INTERVAL_DAYS * 86_400_000)",
  );
  assert.ok(
    !/nextReviewAt: discreteV2FirstDueAt\(at\)/.test(mutated),
    "换成自己算天数之后判据仍判成立 ⇒ 这条判据读不到那一格（恒真）",
  );
  assert.match(mutated, /getTime\(\)/, "变异没落在正确位置");
});
