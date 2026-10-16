import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 触发式主动交付（run 完成 →「要继续吗」）必须守**用户显式关掉主动**的那几个开关
 * （2026-10-16）。
 *
 * 这条路上原来只读账号级总开关与设备在线，于是：
 *   - 用户在某个空间静音了伴星（0266 的空间级开关），那个空间照样收到「刚才的学习已完成」；
 *   - 用户把相处偏好里的主动总开关关掉（40 §9「关掉主动通道」），触发式也不受它约束，
 *     而 `companion-initiative` 那条路是读这两个开关的——两条主动通道对"关掉"的理解不一致。
 *
 * 「触发式不进频率限制」是 2026-09-21 针对**节奏**（静默时段、24h 计数、最近展示时间）
 * 的决定，与"显式开关"是两件事；这条守卫把后者钉住，也把前者的豁免范围写清楚。
 *
 * 2026-10-16 补：用户要求加一条**跨话题的全局地板**（"全局主动这个我觉得可以不用节流
 * 太严重"）。它不取代 2026-09-21 的节奏豁免——触发式仍然不继承 routine 的档位间隔——
 * 只补"她刚开过口就别马上再说"这一格，读数取 assistant_deliveries 里最近一次主动开口
 * （不含 `reminder:`）。它同样必须在入队之前判。
 */
const source = readFileSync(
  new URL("../modules/companion-conversation/delivery/proactive-hook.ts", import.meta.url),
  "utf8",
);

/** 结算钩子那一段（从函数头到第一次真正的入队）。 */
function hookBody(): string {
  const start = source.indexOf("export async function hookProactiveOnRunCompleted");
  assert.notEqual(start, -1, "找不到 run 完成后的主动钩子");
  const end = source.indexOf("deliver(tx, scope", start);
  assert.notEqual(end, -1, "找不到这个钩子的入队点");
  return source.slice(start, end);
}

test("触发式主动交付读空间级静音，静音的空间不入队", () => {
  const body = hookBody();
  assert.match(body, /companionRoomProfiles\.proactiveMuted/,
    "空间级静音（0266）必须在这条路上生效：它是用户对一个空间的显式动作");
  assert.match(body, /if \(roomRows\[0\]\?\.proactiveMuted === true\) return null;/);
});

test("触发式主动交付读相处偏好里的主动总开关", () => {
  const body = hookBody();
  assert.match(body, /readParticipationPreferences\(tx, scope\)/,
    "两条主动通道必须对「关掉主动」有同一个理解");
  assert.match(body, /if \(!participation\.enabled\) return null;/);
});

test("这两个开关都在入队之前判，且豁免范围只写到节奏那几道上", () => {
  const body = hookBody();
  const muteAt = body.indexOf("proactiveMuted === true");
  const preferenceAt = body.indexOf("participation.enabled");
  assert.ok(muteAt > 0 && preferenceAt > muteAt, "两个开关都要在入队前判");
  assert.doesNotMatch(body, /quiet_hours|quietHours/,
    "静默时段仍属节奏档：触发式不进它（2026-09-21 的用户口径）");
});

test("跨话题地板也在入队之前判，且读数不含约定提醒", () => {
  const body = hookBody();
  assert.match(body, /globalProactiveFloorBlocked\(\{ msSinceAnyCue \}\)/,
    "跨话题地板必须在这条路上生效：她刚开过口就不该马上再发一条「要继续吗」");
  // 读数的定义在 agent-host 的唯一实现里：只数 initiative / run.completed，
  // 不数 reminder——约定提醒不能反过来把她静音。只看真代码，注释里会提到那个前缀。
  const floor = readFileSync(
    new URL("../../../../packages/agent-host/src/proactive-floor.ts", import.meta.url),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(floor, /systemEventId' LIKE 'initiative:%'/);
  assert.match(floor, /systemEventId' LIKE 'run\.completed:%'/);
  assert.doesNotMatch(floor, /reminder:/, "约定提醒不进这条读数");
  // 作废（被新启动作废的旧问候）与过期投递用户永远看不到；拿它们压下一句 = 一句没人
  // 听见的话把她静音了：真栈实测快速重启时旧问候把这次启动自己的问候推迟了两分钟。
  assert.match(floor, /state NOT IN \('suppressed', 'expired'\)/);
});
