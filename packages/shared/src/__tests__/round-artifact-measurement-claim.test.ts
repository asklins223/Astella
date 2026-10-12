import { test } from "node:test";
import assert from "node:assert/strict";
import { hasMeasurementClaimV1 } from "../note-dynamic-artifact/round-artifact-measure.ts";

/**
 * 完成判据（§6.1）拦的是"声称测过真实系统"，不是"出现过『实测』这个词"。
 *
 * 2026-10-12 真窗口那一发：提示词要求把读数标成示意值，模型老实写「非实测结果」，
 * 整页跑了 163 秒之后被这条判据判死，用户在界面上只看到一句笼统的"没能通过核对"。
 * 之后又实测到三种同形写法（「不算」「算不上」「未经过」）会被同一处误杀。这里把这几种
 * 写法连同"该拒的仍然拒"钉住——**放宽的是紧贴否定**，不是把整个判据关掉。
 */
test("紧贴判词的否定算免责：非/未/未经/无/没/不算/算不上/未经过", () => {
  for (const text of [
    "这一步读数是示意值，非实测结果。",
    "下面是演示用的数据，未经实测。",
    "耗时一栏只是示例，不算实测。",
    "这段曲线算不上实测。",
    "图中数值未经过实测。",
    "没有实测过真实系统。",
    "这不是对某次阅读行为的实测记录。",
  ]) {
    assert.equal(hasMeasurementClaimV1(text), false, `误杀了诚实免责：${text}`);
  }
});

test("真的声称测过仍然拒：转折词挡在中间就不算紧贴", () => {
  for (const text of [
    "这一步是实测结果，耗时 12 毫秒。",
    "压测了一下，QPS 到 4 万。",
    "非但实测结果惊人，还顺手压了一遍。"
  ]) {
    assert.equal(hasMeasurementClaimV1(text), true, `漏放了一条声称：${text}`);
  }
});
