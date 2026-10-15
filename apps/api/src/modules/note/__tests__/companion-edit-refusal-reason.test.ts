/**
 * 守卫：编辑放行判据全灭时，回执必须说出**真的那一条**原因。
 *
 * 背景（2026-10-14 dev 库实测）：三轮 `companion_edit_note` 全败在
 * `page_context->'context'->>'noteId'=n.id`——用户从气泡发消息、当时没打开这篇笔记，
 * `page_context` 是空的。而回执统一写「这轮已经停止、页面已变化或没有编辑权限」，
 * 模型照着复述给用户，把"页面不对"说成了"对话断了"：run 明明 running、权限 full。
 *
 * 判据：每种真实失败都要有自己的话，且**只在那一条真的成立时**才报它；
 * 页面原因必须排在轮次原因之前检查是错的（先谎报轮次）——这里按每条独立喂原料断言。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseNoteEditRefusal } from "../companion-edit-dispatch.ts";
import type { ApiTransaction } from "../../../db/client.ts";

const SCOPE = { workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };
const CALL_ID = "33333333-3333-4333-8333-333333333333";
const NOTE_ID = "44444444-4444-4444-8444-444444444444";

/**
 * 一条"其它判据全过"的原料；页面缺失（实测那三轮的形状）由各自的用例覆盖掉。
 */
function baseline(overrides: Record<string, unknown> = {}) {
  return {
    call_status: "executing",
    result_ref: null,
    run_status: "running",
    cancel_requested_at: null,
    permission_level: "full",
    account_epoch: 0,
    global_enabled: true,
    current_epoch: 0,
    page_note_id: NOTE_ID,
    note_id: NOTE_ID,
    deleted_at: null,
    share_scope: "private",
    created_by: SCOPE.userId,
    member_left_at: null,
    member_role: "owner",
    workspace_owner: SCOPE.userId,
    job_status: "running",
    job_type: "companion_agent",
    job_requested_by: SCOPE.userId,
    operation: "replace_blocks",
    offered: true,
    confirmed: false,
    ...overrides,
  };
}

/** 只喂诊断函数它自己读的那一行——判据在 SQL 里还是在 JS 里都能被钉住。 */
function txReturning(row: Record<string, unknown> | undefined): ApiTransaction {
  return {
    async execute() {
      return row === undefined ? [] : [row];
    },
  } as unknown as ApiTransaction;
}

async function reasonFor(row: Record<string, unknown> | undefined): Promise<string> {
  return diagnoseNoteEditRefusal(txReturning(row), SCOPE, CALL_ID);
}

test("页面没打开这篇笔记时，说的是页面，不是「这轮已经停止」", async () => {
  const message = await reasonFor(baseline({ page_note_id: null }));
  assert.match(message, /没有打开这篇笔记/);
  assert.doesNotMatch(message, /这轮已经停止/,
    "实测那三轮失败的真因是 page_context 为空；把它说成轮次停止会让模型向用户复述假原因");
});

test("打开了别的笔记时，点名「另一篇」而不是泛泛的页面已变化", async () => {
  const message = await reasonFor(baseline({ page_note_id: "55555555-5555-4555-8555-555555555555" }));
  assert.match(message, /另一篇笔记/);
});

test("轮次真的停了才说「这轮已经停止」", async () => {
  for (const row of [
    baseline({ run_status: "failed" }),
    baseline({ run_status: "succeeded" }),
    baseline({ cancel_requested_at: new Date() }),
    baseline({ run_status: null }),
  ]) {
    const message = await reasonFor(row);
    assert.match(message, /这轮已经停止/, `原料 ${JSON.stringify({ run_status: row.run_status, cancel: row.cancel_requested_at !== null })} 必须报轮次原因`);
  }
});

test("权限与账号各有自己的话，不和轮次、页面混成一句", async () => {
  const disabled = await reasonFor(baseline({ global_enabled: false }));
  assert.match(disabled, /已关闭/);
  const epoch = await reasonFor(baseline({ current_epoch: 1 }));
  assert.match(epoch, /账号信息已更新/);
  const permission = await reasonFor(baseline({ permission_level: "guided" }));
  assert.match(permission, /需要你先确认/);
  const membership = await reasonFor(baseline({ member_left_at: new Date() }));
  assert.match(membership, /没有编辑这篇笔记的权限/);
  const deleted = await reasonFor(baseline({ deleted_at: new Date() }));
  assert.match(deleted, /已经删除/);
  const job = await reasonFor(baseline({ job_status: "succeeded" }));
  assert.match(job, /后台任务已经结束/);
  const unoffered = await reasonFor(baseline({ offered: false }));
  assert.match(unoffered, /没有把编辑工具交给我/);
  const gone = await reasonFor(undefined);
  assert.match(gone, /不在了/);
  // 这些话彼此不能互串：每条都只说自己那件事。
  for (const message of [disabled, epoch, permission, membership, deleted, job, unoffered]) {
    assert.doesNotMatch(message, /这轮已经停止/);
  }
});

test("删除类操作即使 full 档也要确认，没确认就照实说", async () => {
  const message = await reasonFor(baseline({ operation: "delete_blocks", confirmed: false }));
  assert.match(message, /需要你先确认/);
  // full 档的普通编辑不需要确认：不该误报确认问题。
  const ordinary = await reasonFor(baseline({ operation: "replace_blocks", permission_level: "full", confirmed: false }));
  assert.doesNotMatch(ordinary, /需要你先确认/);
  // 已确认的删除不再卡在确认上，会落到后面的兜底句。
  const confirmed = await reasonFor(baseline({ operation: "delete_blocks", confirmed: true }));
  assert.doesNotMatch(confirmed, /需要你先确认/);
});
