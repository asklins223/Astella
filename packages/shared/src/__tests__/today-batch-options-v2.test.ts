/**
 * 今日复习那三个动作的判据（39d W7-4 刀十；39 §12 表「今日复习」行）。
 *
 * 「可换顺序、减量、延后、暂停」＋**剩余需求不伪称完成**。这一组钉住两件最容易写错的：
 *
 *  1. **三档都原样交回 `remaining`，而 `remaining > 0` 时屏上那一行**必须**带上它。**
 *     §12 表第三列最后那半句。写错的形态是"今天完成 3 道"——那三道确实做完了，
 *     而剩下的没被任何一句文案提到，读数于是变成"今天做了 3 道"而她手上有 5 道到期。
 *  2. **暂停**停的是**这一批**，不是那些目标。**长度不变。** 合成一个"当前长度"的
 *     后果：她暂停再恢复时那一批会短一截——**而她什么也没少做**。
 *
 * 3. **减量只减不增，且 `reduceBy<=0` 不许"顺手重算今天该有多少道"**——那是 §9.4
 *     禁止的那一条路（后台改长度）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTodayBatchOptionV2 } from "../today-batch-options-v2.ts";

const base = { lockedLength: 5, remaining: 2, paused: false };

test("W7-4 刀十 正对照：三档都原样交回剩余，且屏上那一行**必须**带上它", () => {
  // §12 表「剩余需求不伪称完成」。三档各念一次——漏掉任何一档就是一个静默的失真。
  // 剩余刻意从**两个来源**各来一遍：2 与 0。这一条断言要在 remaining=0 那一档也成立
  // （「今天做完了」是**允许**的说法），所以不能拿一个非零的字面量去比。
  for (const remaining of [2, 0] as const) {
    for (const action of ["reduce", "pause", "resume"] as const) {
      const decided = decideTodayBatchOptionV2({ ...base, remaining, reduceBy: 2 }, action);
      assert.equal(decided.remaining, remaining, `${action}/${remaining} 那一档把剩余吞了`);
      if (remaining > 0) {
        assert.ok(!/都做完了|已全部|完成[。！]/.test(decided.screenLine),
          `${action} 那一行把「完成」说成了没有剩余的样子：${decided.screenLine}`);
      }
    }
  }
});

test("W7-4 刀十 正对照：暂停**不改长度**（长度是记录，暂停是现在不做了）", () => {
  const decided = decideTodayBatchOptionV2(base, "pause");
  assert.equal(decided.lockedLength, 5, "暂停把长度改了：她恢复时那一批会短一截，而她什么也没少做");
  assert.equal(decided.paused, true);
  assert.equal(decided.remaining, 2);
});

test("W7-4 刀十：恢复不改长度，也不改剩余", () => {
  const paused = decideTodayBatchOptionV2(base, "pause");
  const resumed = decideTodayBatchOptionV2({ ...base, paused: paused.paused }, "resume");
  assert.equal(resumed.lockedLength, paused.lockedLength);
  assert.equal(resumed.paused, false);
  assert.equal(resumed.remaining, 2, "恢复不消费任何一道");
});

test("W7-4 刀十：减量只减不增，且不许越过 0", () => {
  assert.equal(decideTodayBatchOptionV2({ ...base, reduceBy: 2 }, "reduce").lockedLength, 3);
  assert.equal(decideTodayBatchOptionV2({ ...base, reduceBy: 99 }, "reduce").lockedLength, 0,
    "减到负数会造出负的长度");
});

test("W7-4 刀十 正对照：`reduceBy <= 0` **不许**变成「重算今天该有多少道」", () => {
  // §9.4「批次一旦开始，**不因后台新任务到期不断增加长度**」。一个"重算"就绕过了它，
  // 而屏上读不出来（长度变了，但没有一句说过为什么）。
  for (const by of [0, -3, undefined]) {
    const decided = decideTodayBatchOptionV2({ ...base, reduceBy: by }, "reduce");
    assert.equal(decided.lockedLength, 5, `reduceBy=${String(by)} 时长度变了：那是「后台改长度」`);
  }
});

test("W7-4 刀十：剩余真的为 0 时才可以说「已经做完了」", () => {
  const done = decideTodayBatchOptionV2({ lockedLength: 5, remaining: 0, paused: false }, "reduce");
  assert.equal(done.remaining, 0);
  assert.match(done.screenLine, /今天的已经做完了/);
});
