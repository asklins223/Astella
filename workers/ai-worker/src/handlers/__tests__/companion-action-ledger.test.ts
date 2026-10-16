import assert from "node:assert/strict";
import { test } from "node:test";
import { readCompanionActionLedger } from "../companion-dialogue-store.ts";

type LedgerRow = {
  receipt_id: string; tool_call_id: string; name: string; status: string;
  result_safe_summary: string | null; from_current_run: boolean;
  anchor_seq: string; run_status: string;
};

function ledgerWith(rows: readonly LedgerRow[]) {
  return readCompanionActionLedger(
    { execute: async () => rows } as never,
    {
      conversationId: "conversation-1", runId: "run-1",
      coverageFromSeq: "1", coverageThroughSeq: "541", coverageGaps: [],
    },
  );
}

const row = (over: Partial<LedgerRow>): LedgerRow => ({
  receipt_id: "receipt-1", tool_call_id: "call-1", name: "companion_edit_note",
  status: "not_executed", result_safe_summary: "那篇唐朝笔记两次没改成",
  from_current_run: false, anchor_seq: "609", run_status: "succeeded", ...over,
});

/**
 * 摘要覆盖线只到 541，而会话停在 615：挂在已收尾 run 上的失败因此每一轮都原样重发，
 * 用户隔两天进来只说「hihihi」也被她接成旧账（2026-10-16 开发库实测 5 条）。
 * 收掉的是那句报告，不是这件事——status 必须照旧带走，否则「failed 不能说成已完成」
 * 那道闸就没了依据。
 */
test("已收尾 run 的失败只留状态，不再带着那句失败报告", async () => {
  const ledger = await ledgerWith([row({})]);
  assert.equal(ledger.entries.length, 1, "摘要覆盖线之上的旧失败仍然要出现在账本里");
  assert.equal(ledger.entries[0].status, "not_executed");
  assert.equal(ledger.entries[0].safeSummary, null, "报告句不再逐轮重发");
});

test("本轮自己那条 run 的失败保留完整报告", async () => {
  const ledger = await ledgerWith([row({ from_current_run: true })]);
  assert.equal(ledger.entries[0].safeSummary, "那篇唐朝笔记两次没改成");
});

test("run 还没收尾的失败保留完整报告", async () => {
  const ledger = await ledgerWith([
    row({ receipt_id: "r-run", run_status: "running" }),
    row({ receipt_id: "r-accepted", run_status: "accepted" }),
    row({ receipt_id: "r-waiting", run_status: "waiting_for_confirmation" }),
  ]);
  assert.deepEqual(ledger.entries.map(entry => entry.safeSummary), [
    "那篇唐朝笔记两次没改成", "那篇唐朝笔记两次没改成", "那篇唐朝笔记两次没改成",
  ]);
});

test("未决状态与已完成项不受这条收口影响", async () => {
  const ledger = await ledgerWith([
    row({ receipt_id: "r-unknown", status: "outcome_unknown", anchor_seq: "610" }),
    row({ receipt_id: "r-done", status: "succeeded", anchor_seq: "611", result_safe_summary: "已插入" }),
    row({ receipt_id: "r-folded", status: "succeeded", anchor_seq: "300", result_safe_summary: "早先已折" }),
  ]);
  assert.deepEqual(ledger.entries.map(entry => [entry.receiptId, entry.safeSummary]), [
    ["r-unknown", "那篇唐朝笔记两次没改成"],
    ["r-done", "已插入"],
  ], "未决与覆盖线之后的成功项都照旧带着摘要");
  assert.deepEqual(ledger.omitted, { completed: 1, unresolved: 0, notCompleted: 0 });
});
