/**
 * Member 开启个人复习的判据（39d W5-6 刀四；§14.4、§16.20、§9.1）。
 *
 * 这一格钉的是四条，前三条是产品规则，第四条是"不许在这一刀顺手多做的那一半"：
 *
 *  1. **本人可见、且这张卡确实来自一篇笔记**。可见性判据必须是现成那一份
 *     （`visibleObjectivesCondition`），不许在本文件旁边重写一份第二来源。
 *  2. **排的是读者本人**：主体是 `objectiveId` 不是 `cardId`（D2 §3.1 实测存量那 32 行里
 *     `subject_id` 命中 objective 26、命中 card 4，主体那列的语义是"可确认的目标 id"）。
 *  3. **`reason_code` 与作者那一档分开**——它是审计列，也是将来 W7-3 行 1 按来源精确停订
 *     要用的依据。
 *  4. **这一刀只做「开启」**。「停」属 §9.1 规则表**行 1**（仅停用该授权来源），而
 *     `holdObjectiveFromReviewV2` 做的是**行 2**（优先于一切授权的排除）——拿它实现
 *     "停个人复习"会连读者自己的笔记订阅一起停掉，那句话用户没说过。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  SHARED_CARD_PERSONAL_REVIEW_REASON,
} from "../shared-card-review-service.ts";
import { startSharedCardPersonalReviewV2Schema } from "@astella/shared/review-reminder-contracts";

// apps/api/src/modules/review → 上溯五级到仓库根。
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..", "..");
const SERVICE_FILE = join(REPO_ROOT, "apps/api/src/modules/review/shared-card-review-service.ts");
const HOLDS_FILE = join(REPO_ROOT, "apps/api/src/modules/review/objective-review-holds.ts");
const BOUNDARY_FILE = join(REPO_ROOT, "apps/api/src/modules/review/review-schedule-boundary.ts");
const ACTIVATION_FILE = join(REPO_ROOT, "apps/api/src/modules/card-generation-v2/activation-service.ts");
const ROUTES_FILE = join(REPO_ROOT, "apps/api/src/modules/review/routes.ts");

const source = readFileSync(SERVICE_FILE, "utf8");
/** 剥掉注释：源码形状判据要判代码，注释里的话是给人读的。 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const body = codeOnly(source);

test("不变量①：可见性用现成那一份判据，不在旁侧重写第二来源", () => {
  assert.match(body, /visibleObjectivesCondition\(/,
    "没有用 note/visibility.ts 那份现成判据：在旁边再写一份 SQL 就是「同一口径两处各写一次」");
  // 可见性必须落在 WHERE 里（读侧先收窄），不是查出来再判。
  const whereAt = body.indexOf("visibleObjectivesCondition(");
  const returnAt = body.indexOf("if (!card) throw");
  assert.ok(whereAt > 0 && returnAt > whereAt,
    "可见性判据不在查询里，而在查出来之后 ⇒ 那是「读出来再遮蔽」，加字段时会漏");
  // 全仓只应有一处判据来源：这份文件不得自己拼 notes/notes.share_scope。
  assert.ok(!/notes\.shareScope|shareScope/.test(body),
    "这一格自己在读分享范围：那会把「private/shared 二档」这个口径抄成第二份");
});

test("不变量①的反面：没有笔记来源的卡不归这一格（「共享卡」的定义）", () => {
  assert.match(body, /isNotNull\(learningCardsV2\.noteVersionId\)/,
    "没有排除「没有笔记来源的卡」：那种卡不属于共享卡，0274 之后 noteVersionId 可空");
  assert.match(body, /eq\(learningCardsV2\.lifecycle, "active"\)/,
    "没有要求 lifecycle=active：停用/退役的卡不该被开启个人复习");
});

test("不变量②：排期主体是目标 id，不是卡 id（D2 §3.1 的存量口径）", () => {
  assert.match(body, /subjectId: card\.objectiveId/,
    "排期主体写成了 cardId：作者那一条与读者这一条会撞不上 0287 的唯一索引，同一需求被排成两条");
  assert.ok(!/subjectId: card\.cardId|subjectId: input\.cardId/.test(body),
    "主体用的是卡 id");
});

test("不变量②的另一半：排的是读者本人那一行（user_id 来自会话，不来自请求体）", () => {
  assert.match(body, /userId: scope\.userId/,
    "排期的 user 不是会话里的那个人 ⇒ 读者能给别人排安排");
  const contract = readFileSync(join(REPO_ROOT, "packages/shared/src/contracts/review-reminder-contracts.ts"), "utf8");
  assert.match(contract, /startSharedCardPersonalReviewV2Schema = z\.strictObject\(\{\s*\n\s*cardId: z\.string\(\)\.uuid\(\)/,
    "请求体第一格不是 cardId，或多了别的字段");
  // 请求体不许带 userId / workspaceId
  const schema = startSharedCardPersonalReviewV2Schema.safeParse({
    cardId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(schema.success, false, "请求体收下了 userId：排给谁由服务端决定，不由客户端指定");
});

test("不变量③：reason_code 与作者那一档分开（审计列，也是将来按来源停订的依据）", () => {
  assert.equal(SHARED_CARD_PERSONAL_REVIEW_REASON, "shared_card_personal_review");
  const activation = readFileSync(ACTIVATION_FILE, "utf8");
  assert.match(activation, /reasonCode: "activation_authorized"/,
    "读不到作者那一档的 reason（判据可能指错了地方）");
  assert.notEqual(SHARED_CARD_PERSONAL_REVIEW_REASON, "activation_authorized",
    "两个来源共用一个 reason ⇒ 事后分不清哪条是作者排的、哪条是读者排的（§9.2）");
  assert.match(body, new RegExp(`reasonCode: SHARED_CARD_PERSONAL_REVIEW_REASON`),
    "这一发没有用它自己那档 reason");
});

test("间隔形状照作者那一档，一个字都不改（且不调观察策略）", () => {
  assert.match(body, /nextReviewAt: discreteV2FirstDueAt\(at\)/,
    "到期时刻没有走策略那个 discreteV2FirstDueAt");
  assert.match(body, /intervalDays: DISCRETE_V2_FIRST_INTERVAL_DAYS/,
    "间隔天数没有取自策略导出的头一档常量");
  assert.match(body, /policyVersion: DISCRETE_V2_POLICY_VERSION/);
  assert.ok(!/calculateDiscreteV2Schedule/.test(body),
    "这一发调了 calculateDiscreteV2Schedule：那要一个 outcome，而「读者开启自己的复习」"
    + "不是一次观察——硬凑一个 correct 等于把一次从没发生过的表现记成发生过（§9.2）");
  assert.ok(!/getTime\(\)\s*\+/.test(body),
    "自己在用 getTime 算到期时刻 ⇒ addMs 溢出护栏被绕过，且阶梯头一档被抄了第二份");
});

test("走唯一调度边界，不裸 insert（0287 的单写者判据会再拦一次）", () => {
  assert.match(body, /ensurePendingReviewScheduleV2\(/);
  assert.equal((body.match(/\.insert\(/g) ?? []).length, 0,
    "出现了裸 insert：会变成一次 23505，而且绕过边界就绕过了目标级「暂不安排」的执法");
  assert.match(body, /reminderKind: "sustained"/,
    "「开启复习」是持续安排；写成 one_time 的话处理后就不再排下一次（§9.1 末段）");
});

test("不变量④：这一刀只做「开启」，不用排除表去实现「停」", () => {
  assert.ok(!/holdObjectiveFromReviewV2|holdObjectiveRequestV2Schema|objectiveReviewHoldsV2/.test(body),
    "这一刀碰了「暂不安排」：那是 §9.1 规则表行 2（优先于一切授权的排除），"
    + "而「停掉个人复习」是行 1（仅停用该授权来源）——用排除实现会把读者自己的笔记订阅一起停掉");
  // 反向自证：那一侧确实**是另一件事**——它的头注把所属规则表行号写明了（行 2 / 行 3），
  // 而这一格是行 1。读的是那一行而不是"优先"两个字：第一版匹配「优先」没匹配上，
  // 判据指错了地方却没有让产品出问题——那正是恒真判据长什么样。
  const holds = readFileSync(HOLDS_FILE, "utf8");
  assert.match(holds, /§9\.1 规则表行 2 与行 3/,
    "排除那一侧的头注没读到规则表行号（判据可能指错了地方）");
  assert.ok(!/§9\.1 规则表行 1[^\n]*排除/.test(holds),
    "排除那一侧自称行 1：那与本刀的理解冲突，先把它读清楚再动代码");
});

test("三种结果分开说，排不动的如实报「held」而不是「已开启」", () => {
  assert.match(body, /status: "started"/);
  assert.match(body, /status: "already_scheduled"/);
  assert.match(body, /status: "held"/);
  const routes = readFileSync(ROUTES_FILE, "utf8");
  assert.ok(routes.includes('error: "objective_held"'),
    "路由没有把 held 翻成错误：用户会看到「已开启」，而库里什么都没排");
  assert.ok(routes.includes("reused_existing"),
    "回执没有把「沿用已有」这一档说出来 ⇒ 界面会把两件不同的事念成同一句");
  assert.ok(routes.includes('"card_not_found"'),
    "读不到那张卡没有翻成 404：不可见与不存在是两句不同的话，混起来会泄露卡片存在性");
});

test("边界自身不变量仍然成立（这一刀没碰它）", () => {
  const boundary = readFileSync(BOUNDARY_FILE, "utf8");
  assert.ok(boundary.includes(".onConflictDoNothing()"),
    "边界不再是 DO NOTHING 那一支：要么它改成了覆盖别人的到期时间，要么这条判据该同步改口径");
  assert.match(boundary, /if \(!existing\) \{[\s\S]{0,200}throw new Error/,
    "边界丢了「冲突后回读不到就抛」那一档：那时它会安静交回一个猜出来的 id");
});
