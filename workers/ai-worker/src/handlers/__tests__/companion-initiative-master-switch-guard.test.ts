import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 「关掉主动通道」必须真的关掉**整个主动路径**（2026-10-16）。
 *
 * 相处偏好里的 `enabled` 是用户用一句自然语言设的（"以后别主动找我了"），
 * 而这个任务就是"主动"的定义域。原来它只挡得住偏好绑定的那些安排：
 *   - `builtin` 分支让所有自带机会（招呼、陪着的时候、久学休息、页面帮助）无视它通过；
 *   - 自记事与关注唤醒（`selfNote` / `plan`）从不读它。
 * 于是用户关掉主动之后招呼照打、安静陪伴照来、自学自评照跑。
 *
 * 守卫按**次序**判，而不是只查那个词是否出现：`if (!pref.enabled) return;` 必须在
 * `builtin` 与 `applicable` 之前，否则自带机会仍然绕得过去。
 */
const source = readFileSync(new URL("../companion-initiative.ts", import.meta.url), "utf8");

function initiativeBody(): string {
  const start = source.indexOf("export async function runCompanionInitiative");
  assert.notEqual(start, -1, "找不到主动参与任务的入口");
  return source.slice(start, start + 12_000);
}

test("主动总开关关掉时，整个主动任务直接结束", () => {
  const body = initiativeBody();
  assert.match(body, /if \(!pref\.enabled\) return;/,
    "相处偏好里的主动总开关没有接到这条路上 —— 关掉主动之后她仍会开口");
});

test("这条早返回排在自带机会与自带安排之前（否则绕得过去）", () => {
  const body = initiativeBody();
  const gate = body.indexOf("if (!pref.enabled) return;");
  const builtin = body.indexOf("isCompanionDefaultParticipationOpportunity(");
  const applicable = body.indexOf("const applicable = observation ?");
  assert.ok(gate > 0, "找不到主动总开关的早返回");
  assert.ok(builtin > gate, "自带机会仍排在总开关之前 —— 关掉主动后招呼/陪伴照样会来");
  assert.ok(applicable > gate, "自带安排仍排在总开关之前 —— 关掉主动后自学自评照样会跑");
});

test("约定提醒不走这条任务（它由 SQL 直接入队，不受主动总开关影响）", () => {
  // 40 §8.2：关掉主动不等于取消用户自己约好的事。守卫钉住这个边界，
  // 免得以后有人把提醒也塞进来「顺便」受这条早返回管。
  // 判据只看**代码**：注释里提到提醒的名字（比如上面那段解释）不算把提醒接进来。
  const code = initiativeBody()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map(line => line.replace(/\/\/.*$/, "")).join("\n");
  assert.doesNotMatch(code, /companion_reminders/,
    "提醒不该出现在主动任务的闸里 —— 它有独立的入队路径与「已授权安排不取消」的语义");
});
