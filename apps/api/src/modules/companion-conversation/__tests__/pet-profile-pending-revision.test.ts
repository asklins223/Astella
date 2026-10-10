/**
 * 「待生效」这一版的两个纯规则（A50 / 40 §4.8.4）。
 *
 * ## 为什么这两条要单独测
 *
 * 它们各自都对应一种**安静**的错误：
 *
 *   * `nextPersonaRevisionNumber`：版本号撞唯一键。用户「直接纠正」的那一下会直接
 *     失败并回滚——错误是响亮的，但功能是坏的，而且只在"恰好排过队"时才犯。
 *   * `personaRevisionEffectiveWhen`：生效条件显示错。模型自改与用户直接纠正的生效
 *     时点不同，界面自己复述一遍规则，早晚有一处漂。
 *
 * 另外还钉住一条**为什么这么放路由**的事实：桌面端对
 * `GET /companion/pet-profile` 的响应是 strictObject 逐字段校验，
 * 所以"当前 / 待生效"不能靠往那份响应里加字段来交付。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { companionPersonaV1Schema } from "@astella/shared/companion-memory-desktop-contracts";

import { nextPersonaRevisionNumber, personaRevisionEffectiveWhen } from "../pet-profile-service.ts";

test("没有排队时，新号就是当前 +1（既有行为不变）", () => {
  assert.equal(nextPersonaRevisionNumber(0, null), 1);
  assert.equal(nextPersonaRevisionNumber(3, null), 4);
  assert.equal(nextPersonaRevisionNumber(7, null), 8);
});

test("排过队时，新号必须排在队尾——否则会撞上那一版的唯一键", () => {
  // 当前 3、排队 4。此时一次用户直接纠正若还按「当前 +1」= 4 写，
  // versions(user_id, 4) 已经被排队那版占了 → 唯一键冲突 → 那次纠正整个回滚。
  assert.equal(nextPersonaRevisionNumber(3, 4), 5);
  // 排队的号比当前大多少都不影响：取更大的那个 +1。
  assert.equal(nextPersonaRevisionNumber(3, 9), 10);
});

test("新号永远大于当前，也永远不等于排队中的那一号", () => {
  for (const current of [0, 1, 5, 12]) {
    for (const staged of [null, 0, 1, 6, 40]) {
      const next = nextPersonaRevisionNumber(current, staged);
      assert.ok(next > current, `next(${current}, ${staged}) 必须大于当前`);
      if (staged !== null) assert.notEqual(next, staged, `next(${current}, ${staged}) 不得复用排队那一号`);
      if (staged !== null) assert.ok(next > staged, `next(${current}, ${staged}) 必须排在队尾`);
    }
  }
});

test("【自证】旧的算法（当前 +1）在排队存在时确实会撞号", () => {
  // 正控制：判据认得出的是「排到队尾」这件事，不是「+1」这个写法。
  const current = 3;
  const staged = 4;
  const legacy = current + 1;
  assert.equal(legacy, staged, "自证样本没造好：旧算法在排队时没撞上");
  assert.notEqual(nextPersonaRevisionNumber(current, staged), legacy);
});

test("生效条件按作者区分（40 §4.8.4 原文那两句）", () => {
  assert.equal(personaRevisionEffectiveWhen("assistant_tool"), "下一轮新发起的对话生效，当前已开始的调用保持原版本");
  assert.equal(personaRevisionEffectiveWhen("user"), "下一轮未开始的调用生效");
  assert.equal(personaRevisionEffectiveWhen("restore"), "恢复后立即生效");
  assert.equal(personaRevisionEffectiveWhen("migration"), "历史导入版本");
});

test("四类作者都有对应文案——新增作者时这里会红，而不是静默掉进默认分支", () => {
  const authors = ["user", "assistant_tool", "restore", "migration"] as const;
  const seen = new Set(authors.map(personaRevisionEffectiveWhen));
  assert.equal(seen.size, authors.length, `生效条件文案重复了：${[...seen].join(" / ")}`);
  for (const text of seen) assert.ok(text.length > 0, "生效条件不得为空串——空串等于没告诉用户");
});

test("【路由形状】桌面端对主响应是 strictObject：加字段就整份解析失败", () => {
  // 这是「待生效」必须走独立路由的直接原因。
  const currentResponse = {
    version: 1 as const,
    profile: null,
    profileRevision: 3,
    relationship: { familiarity: 0.2, interactionCount: 7, lastActiveAt: null },
    presets: [],
    activePreset: null,
  };
  assert.equal(companionPersonaV1Schema.safeParse(currentResponse).success, true, "自证样本本身必须是合法的");
  assert.equal(
    companionPersonaV1Schema.safeParse({ ...currentResponse, pending: null }).success,
    false,
    "主响应仍是 strictObject：把待生效塞进去会让桌面端报 unsupported_contract",
  );
});
