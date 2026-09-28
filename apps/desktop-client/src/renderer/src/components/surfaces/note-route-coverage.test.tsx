// @vitest-environment jsdom
/**
 * 核心路线册页（39d W4-5 ③；PRD §4.4、§4.1、§13.4）。
 *
 * 三条判据对着三句产品要求：范围缩小要**念出理由**、待核对的**留在册页上**、
 * 读失败**不画成空册页**（空册页会被读成"这一篇没有核心问题"）。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { noteRouteCoverageV1Schema, type NoteRouteCoverageV1 } from "@ailearn/shared/note-route-coverage-v2";
import { NoteRouteCoverage } from "./note-route-coverage";

const NOTE = "44444444-4444-4444-8444-444444444444";
const OBJECTIVE = "33333333-3333-4333-8333-333333333333";
const ROUND = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const coverage = (over: Partial<NoteRouteCoverageV1> = {}): NoteRouteCoverageV1 => noteRouteCoverageV1Schema.parse({
  version: 1,
  noteId: NOTE,
  questions: [{
    questionId: `objective:${OBJECTIVE}`,
    kind: "objective",
    label: "索引为什么在组合查询里更慢",
    state: "learned_with_help",
    stateHelpCondition: "assisted",
    roundIds: [ROUND],
    attempts: [],
    conflictReason: null,
    lastSettledAt: null,
  }],
  summary: { totalCount: 1, coveredCount: 1, independentCount: 0, assistedCount: 1, uncoveredCount: 0 },
  verdict: { kind: "route_complete", scopeAdjustedAt: null, scopeAdjustmentReason: null, uncovered: [] },
  ...over,
});

afterEach(cleanup);

it("§4.4：范围缩小时册页**念出理由**，并说明这句话只对调整后的范围成立", () => {
  render(<NoteRouteCoverage
    coverage={coverage({
      verdict: {
        kind: "route_complete_within_adjusted_scope",
        scopeAdjustedAt: "2026-09-26T08:00:00.000Z",
        scopeAdjustmentReason: "这次只走前两段",
        uncovered: [],
      },
    })}
    failure={null}
  />);
  expect(screen.getByText(/按后来调整过的范围完成了/)).toBeTruthy();
  expect(screen.getByText(/这次只走前两段/)).toBeTruthy();
  // 变异自证：把「范围变过」那一行去掉 ⇒ 本条红。
  expect(screen.getByText(/范围变过，所以这句话只对调整之后的范围成立/)).toBeTruthy();
});

it("§4.4：待核对的那一条**留在册页上**，并把矛盾的理由印出来", () => {
  const conflicted = coverage({
    questions: [{
      questionId: "material_conflict:unit-7",
      kind: "material_conflict",
      label: "「写入一定比批量慢」这一处",
      state: "blocked_by_material_conflict",
      stateHelpCondition: null,
      roundIds: [ROUND],
      attempts: [],
      conflictReason: "同一段里两句话给出的结论相反",
      lastSettledAt: null,
    }],
    summary: { totalCount: 1, coveredCount: 0, independentCount: 0, assistedCount: 0, uncoveredCount: 1 },
    verdict: {
      kind: "route_incomplete",
      scopeAdjustedAt: null,
      scopeAdjustmentReason: null,
      uncovered: [{ questionId: "material_conflict:unit-7", label: "「写入一定比批量慢」这一处", state: "blocked_by_material_conflict" }],
    },
  });
  render(<NoteRouteCoverage coverage={conflicted} failure={null} />);
  expect(screen.getByText("材料自己矛盾")).toBeTruthy();
  expect(screen.getByText("同一段里两句话给出的结论相反")).toBeTruthy();
  // §4.1：那句话不许被说成"你不会"。
  expect(screen.queryByText(/不会/)).toBeNull();
  // 变异自证：把 conflictReason 那一行去掉 ⇒ 本条红。
});

it("§13.4：读失败**说清是什么失败**，不画成一本空册页", () => {
  render(<NoteRouteCoverage coverage={null} failure="服务没回音" />);
  expect(screen.getByText(/核心路线没读到/)).toBeTruthy();
  expect(screen.getByText(/服务没回音/)).toBeTruthy();
  // 变异自证：失败时不渲染任何提示（返回 null）⇒ 本条红。
  expect(screen.queryByText(/纳入的/)).toBeNull();
});

it("§10.3：点某条问题能回到走过它的那一轮", () => {
  const onInspectRound = vi.fn();
  render(<NoteRouteCoverage coverage={coverage()} failure={null} onInspectRound={onInspectRound} />);
  fireEvent.click(screen.getByRole("button", { name: /去看走过的那一轮/ }));
  expect(onInspectRound).toHaveBeenCalledWith(ROUND);
  // 变异自证：不把 roundIds[0] 传出去 ⇒ 本条红。
});
