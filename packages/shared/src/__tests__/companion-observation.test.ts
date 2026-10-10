/**
 * 观察投影的合同与渲染（方案 50 §6.1 / §10.2）。
 *
 * 钉的都是"编不出来的那部分"：段粒度、没有中间位置这一格、过期即丢、
 * rejected（没尝试）不等于播失败。这几条一旦被"顺手补个进度百分比"破掉，
 * 症状是她会把没听到的话说成用户已经听过。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  companionObservationSetV1Schema,
  COMPANION_OBSERVATION_MAX_PER_TURN,
} from "../contracts/companion-observation-contracts.ts";
import { renderCompanionDeliveryObservation } from "../companion-observation-render.ts";

const base = {
  version: 1 as const,
  sourceId: "companion_tts_outcomes:11111111-1111-4111-8111-111111111111",
  kind: "delivery" as const,
  producer: "device" as const,
  scope: {
    workspaceId: "33333333-3333-4333-8333-333333333333",
    userId: "44444444-4444-4444-8444-444444444444",
    conversationId: "55555555-5555-4555-8555-555555555555",
    runId: "11111111-1111-4111-8111-111111111111",
    referencedVersion: "11111111-1111-4111-8111-111111111111",
  },
  occurredAt: "2026-10-10T04:00:00.000Z",
  observedAt: "2026-10-10T04:05:00.000Z",
  trust: "device_recorded" as const,
  purpose: "current_context_clue" as const,
  withdrawal: { invalidatedWhenSourceChanges: true, expiresAt: "2026-10-11T04:05:00.000Z" },
  payload: {
    segmentsPlayed: 2, segmentsPrepared: 5, failedSegmentCount: 0,
    unfinishedPlayback: true, lastOutcomeAt: "2026-10-10T04:00:30.000Z",
  },
};
const set = { version: 1 as const, observations: [base], droppedCount: 0 };

test("观察带身份、范围、两个时刻与信任/用途：少一项都不算一条观察", () => {
  assert.deepEqual(companionObservationSetV1Schema.parse(set), set);
  for (const missing of ["occurredAt", "observedAt", "trust", "purpose", "withdrawal", "sourceId"] as const) {
    const broken = { ...base } as Record<string, unknown>;
    delete broken[missing];
    assert.equal(companionObservationSetV1Schema.safeParse({ ...set, observations: [broken] }).success, false,
      `${missing} 可以缺省的话，观察就没法回答「谁在什么时候说的、能拿去干什么」`);
  }
});

test("不认的键与没有的取值一律拒收：不复制完整事件库，也不新造一档状态", () => {
  assert.equal(companionObservationSetV1Schema.safeParse({
    ...set, observations: [{ ...base, progressPercent: 43 }],
  }).success, false, "段内进度没有权威来源，合同里就不该有这一格");
  assert.equal(companionObservationSetV1Schema.safeParse({
    ...set, observations: [{ ...base, trust: "user_stated" }],
  }).success, true);
  assert.equal(companionObservationSetV1Schema.safeParse({
    ...set, observations: [{ ...base, trust: "definitely_known" }],
  }).success, false);
  assert.equal(companionObservationSetV1Schema.safeParse({
    version: 1, observations: Array.from({ length: COMPANION_OBSERVATION_MAX_PER_TURN + 1 }, () => base), droppedCount: 0,
  }).success, false, "有界是合同的一部分，超出要计入 droppedCount 而不是塞进请求");
});

test("渲染只说段粒度事实，过期那条直接不带上", () => {
  const rendered = renderCompanionDeliveryObservation(set, new Date("2026-10-10T05:00:00.000Z"));
  assert.match(rendered, /只播到第 2 段（一共 5 段）/);
  assert.match(rendered, /不要汇报播放情况/);
  assert.match(rendered, /不要把没播完的部分说成对方已经听过/);
  assert.equal(rendered.includes("%"), false);
  assert.equal(renderCompanionDeliveryObservation(set, new Date("2026-10-12T05:00:00.000Z")), "",
    "过期之后这条线索不再进请求");
});

test("只有失败段时说的是「没播成」，没有段数进度", () => {
  const rendered = renderCompanionDeliveryObservation({
    ...set,
    observations: [{ ...base, payload: { ...base.payload, segmentsPlayed: 5, unfinishedPlayback: false, failedSegmentCount: 2 } }],
  }, new Date("2026-10-10T05:00:00.000Z"));
  assert.match(rendered, /有 2 段没播成/);
  assert.equal(rendered.includes("只播到"), false);
});
