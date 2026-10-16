import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPANION_TRIGGERED_TOPICS, initiativeCadenceApplies } from "../companion-initiative-observation.ts";

/**
 * 档位间隔的**钟**只数她自己新起的话题（2026-10-16）。
 *
 * 原来它数"任意一次她开口"，于是触发式也把钟按下去：一次启动问候之后的半小时里，
 * 到页面的搭话、陪着的时候一律被挡。真窗口实测：问候之后六分钟里 `page.arrived` 报上来 2 次、
 * 产出运行 0 个；全库对照 `page.arrived` 观察 48 条只换来 1 次运行，`app.started` 一类却有 94 次。
 *
 * 这条守卫读真代码：钟的 SQL 必须把触发式话题排除掉，否则"该开口的时候不开口"会原样回来。
 */
test("档位间隔的钟把触发式话题排除在外", () => {
  const source = readFileSync(new URL("../companion-initiative.ts", import.meta.url), "utf8");
  const clock = source.slice(source.indexOf("SELECT r.created_at AS at FROM companion_turn_runs"),
    source.indexOf("const msSince = spoke"));
  assert.ok(clock.length > 0, "找不到档位间隔的读数 SQL");
  assert.match(clock, /NOT IN \(/, "钟必须排除一类话题，而不是数任意一次开口");
  assert.match(clock, /COMPANION_TRIGGERED_TOPICS\.map/, "排除的名单要与触发式清单同源，不能各写一份");
  // 触发式清单本身：招呼、回到前台、偏好改动、页面帮助、真实结果、答后接续。
  for (const topic of ["app.started", "app.foreground", "preference.changed", "help.available", "result.available", "reply.finished"]) {
    assert.ok((COMPANION_TRIGGERED_TOPICS as readonly string[]).includes(topic), `${topic} 应在触发式清单里`);
  }
});

/** 钟只影响 routine：陪着的时候（第八轮）与触发式都不走这条闸，页面搭话仍走。 */
test("谁走档位间隔：与上一轮的豁免口径一致", () => {
  assert.equal(initiativeCadenceApplies("page.arrived", false), true);
  assert.equal(initiativeCadenceApplies("study.started", false), true);
  assert.equal(initiativeCadenceApplies("presence.quiet", false), false);
  assert.equal(initiativeCadenceApplies("app.started", false), false);
});
