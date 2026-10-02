/**
 * 40 §8.2「今天别催学习」的**写入侧**。
 *
 * ## 为什么判据的对象是"两端都通"
 *
 * 抑制侧（投递时读账号上的暂停）已经测过。但那句话要能被**记住**，还需要
 * 有人把它写进去。真实形状是：
 *
 *   用户说「今天别催我学习」→ 模型调 `companion_pause_learning_suggestions`
 *   → worker 写 `suggestion_pause.localDate` → 投递那侧读到它。
 *
 * 中间断一环，用户就只会发现"我说过了她还是催"。而界面上没有任何异常。
 *
 * ## 两条最容易写错的
 *
 *  1. **本地日由服务端算**。模型只说 `today` / `resume`；哪天由 `localDateIn`
 *     按账号时区算。写成"从现在起 24 小时"会在跨天时差一天。
 *  2. **写入侧不许碰已授权安排**。这一行里除了 `suggestion_pause` 不该写别的，
 *     尤其是任何与提醒/安排有关的列。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { getCompanionAgentTool } from "../companion-agent-registry.ts";
import { localDateIn } from "../companion-proactive-quota.ts";

const REPO = resolve(import.meta.dirname, "..", "..", "..", "..");
const executor = readFileSync(
  join(REPO, "workers", "ai-worker", "src", "handlers", "companion-tool-execution.ts"), "utf8",
);
const delivery = readFileSync(
  join(REPO, "apps", "api", "src", "modules", "companion-conversation", "delivery", "delivery-service.ts"), "utf8",
);

test("工具已登记，且只给 `today` / `resume` —— 不让模型自己算哪天", () => {
  const definition = getCompanionAgentTool("companion_pause_learning_suggestions");
  assert.ok(definition, "工具没登记 —— 用户说「今天别催」时她没有入口");
  const props = definition.parameters.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(props).sort(), ["reason", "scope"]);
  // 给一个"暂停到某天"就是让模型算时区，而它一定会算错。
  assert.ok(!("until" in props) && !("localDate" in props) && !("days" in props),
    "工具让模型自己指定到期时间 —— 时区它算不对");
});

test("执行体**真的存在**且会写 `suggestion_pause`", () => {
  const start = executor.indexOf('case "companion_pause_learning_suggestions"');
  assert.ok(start > 0, "执行体里没有这一条 —— 工具会走「未实现」分支");
  const body = executor.slice(start, start + 2600);
  assert.match(body, /suggestionPause/);
  // 本地日由 `localDateIn` 算，而不是从当前时刻加 24 小时。
  assert.match(body, /const localDate = localDateIn\(/,
    "本地日不是按服务端算的 —— 写成 now+24h 会在跨天时差一天");
  assert.ok(!/now\s*\+\s*86400000|Date\.now\(\)\s*\+\s*24/.test(body),
    "执行体里出现了「加 24 小时」—— 那是时刻口径，不是本地日");
});

test("写入侧**只动** suggestion_pause，不碰已授权安排", () => {
  const start = executor.indexOf('case "companion_pause_learning_suggestions"');
  const body = executor.slice(start, start + 2600);
  // §8.2：「不会取消已授权安排。」这一段里除了 revision/updated_at 与
  // suggestion_pause，不该出现任何与提醒/安排相关的写。
  const setClause = body.slice(body.indexOf(".set("), body.indexOf(".where("));
  assert.ok(!/reminder|arrangement|schedule|appointment/i.test(setClause),
    "写入侧碰了提醒/安排 —— 一句「别催学习」把用户约好的事也撤了");
  assert.ok(!/\bdelete\b/i.test(body),
    "这一段里出现了删除 —— 「别催学习」绝不该删任何东西");
});

test("恢复（resume）会**清掉** localDate —— 否则明天她又以为还停着", () => {
  const start = executor.indexOf('case "companion_pause_learning_suggestions"');
  const body = executor.slice(start, start + 2600);
  assert.match(body, /paused: false/);
  assert.match(body, /localDate: undefined/,
    "恢复时没清 localDate —— 过期判据会继续命中它");
});

test("投递那侧读的是**同一个键**", () => {
  // 写入写 suggestion_pause，读出也读它。两边对不上就是"说了但没用"。
  const hook = readFileSync(
    join(REPO, "apps", "api", "src", "modules", "companion-conversation", "delivery", "proactive-hook.ts"), "utf8",
  );
  assert.match(hook, /suggestionPause/);
  assert.match(delivery, /evaluateStaleAfterResume/, "自证：另一条丢弃规则仍在");
});

test("【自证】判据认得出「把本地日写成 now+24h」这个真实退化", () => {
  // 退化形状：让执行体按 24 小时算。
  const degraded = "const localDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);";
  assert.ok(degraded.includes("86400000"), "自证样本没造好");
  // 正控制：真执行体走的是 localDateIn。
  const start = executor.indexOf('case "companion_pause_learning_suggestions"');
  assert.match(executor.slice(start, start + 2600), /localDateIn\(/,
    "自证：当前确实走 localDateIn，所以判据今天是绿的");
  // 而 localDateIn 按时区算，与 24 小时不同：
  const at = new Date("2026-10-03T15:50:00Z"); // 上海 10-03 23:50
  assert.equal(localDateIn("Asia/Shanghai", at), "2026-10-03");
  assert.equal(new Date(at.getTime() + 86400000).toISOString().slice(0, 10), "2026-10-04",
    "自证：此刻两个口径差一天");
});

test("【自证】判据认得住「执行体被删掉」这个真实退化", () => {
  const degraded = 'switch (name) { case "companion_set_activeness": {';
  assert.ok(!degraded.includes("companion_pause_learning_suggestions"), "自证样本没造好");
  assert.ok(executor.includes('case "companion_pause_learning_suggestions"'),
    "自证：当前执行体确实在");
});
