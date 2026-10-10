/**
 * 交付观察的投影判据（方案 50 §10.2）。
 *
 * 这一族判的全是"什么时候不该说话"：正常播完什么都不带；合成失败的段不该算成
 * "她话说了一半"；`rejected`（根本没尝试：静音、窗口不可见）不该被说成设备播失败。
 * 每一条都对应一种她会说错的话，所以宁可少说。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  projectDeliveryObservation,
} from "../companion-delivery-observation.ts";

const at = (iso: string) => new Date(iso);
const scope = {
  workspaceId: "33333333-3333-4333-8333-333333333333",
  userId: "44444444-4444-4444-8444-444444444444",
  conversationId: "55555555-5555-4555-8555-555555555555",
  previousRunId: "11111111-1111-4111-8111-111111111111",
  currentRunId: "22222222-2222-4222-8222-222222222222",
  observedAt: at("2026-10-10T04:05:00.000Z"),
};
const row = (segmentId: string, stage: string, outcome: string, created = "2026-10-10T04:00:00.000Z") =>
  ({ segment_id: segmentId, stage, outcome, created_at: at(created) });

const synth = (n: number) => Array.from({ length: n }, (_u, i) => row(`s${i}`, "synth", "ok"));

test("全部播完了就什么都不带：她不必每轮复述播报状态", () => {
  assert.equal(projectDeliveryObservation({
    ...scope, rows: [...synth(3), row("s0", "playback", "ok"), row("s1", "playback", "ok"), row("s2", "playback", "ok")],
  }), null);
});

test("用户在朗读中途发下一条：带上「播到第几段、共几段」，不带段内位置", () => {
  const projected = projectDeliveryObservation({
    ...scope,
    rows: [...synth(5), row("s0", "playback", "ok", "2026-10-10T04:00:10.000Z"),
      row("s1", "playback", "ok", "2026-10-10T04:00:20.000Z")],
  });
  const entry = projected?.observations[0];
  assert.equal(entry?.payload.segmentsPlayed, 2);
  assert.equal(entry?.payload.segmentsPrepared, 5);
  assert.equal(entry?.payload.unfinishedPlayback, true);
  assert.equal(entry?.purpose, "current_context_clue");
  assert.equal(entry?.trust, "device_recorded");
  assert.equal(JSON.stringify(projected).includes("percent"), false);
  assert.equal(entry?.withdrawal.invalidatedWhenSourceChanges, true);
});

test("合成失败的段不算「她话说了一半」：那本来就没有声音", () => {
  assert.equal(projectDeliveryObservation({
    ...scope,
    rows: [row("s0", "synth", "ok"), row("s1", "synth", "failed"), row("s0", "playback", "ok")],
  }), null, "只有合成成功过的段才进入分母");
});

test("一段都没出声（静音、窗口不可见）时什么都不带：她没说到一半，只是没念", () => {
  assert.equal(projectDeliveryObservation({
    ...scope, rows: [...synth(2), row("s0", "playback", "rejected"), row("s1", "playback", "rejected")],
  }), null);
});

test("一部分没尝试、一部分没播完：只按真出声过的段算分母", () => {
  const projected = projectDeliveryObservation({
    ...scope,
    rows: [...synth(3), row("s0", "playback", "ok"), row("s1", "playback", "rejected")],
  });
  const payload = projected?.observations[0].payload;
  assert.equal(payload?.segmentsPrepared, 2);
  assert.equal(payload?.segmentsPlayed, 1);
  assert.equal(payload?.failedSegmentCount, 0);
  assert.equal(payload?.unfinishedPlayback, true);
});

test("播放侧真失败时把失败段数带出去", () => {
  const projected = projectDeliveryObservation({
    ...scope, rows: [...synth(2), row("s0", "playback", "ok"), row("s1", "playback", "failed")],
  });
  assert.equal(projected?.observations[0].payload.failedSegmentCount, 1);
  assert.equal(projected?.observations[0].payload.unfinishedPlayback, true);
});

test("没有任何回执（纯文字回合）时不产生观察", () => {
  assert.equal(projectDeliveryObservation({ ...scope, rows: [] }), null);
});
