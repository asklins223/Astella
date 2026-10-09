/**
 * 伴星「共享给空间」这条能力的真库覆盖（2026-10-09 补）。
 *
 * 它为什么值得单独一份：这条能力是**把内容拿给别人看**的开关，判据只有一条——写它的人。
 * 而它不在 worker 里落库：可见性一变，目标索引里那句公开标题要跟着刷新，那条投影规则
 * 只住在服务层 `setNoteShareScope` 一处。所以这份测的是**整条派发链**——
 * worker 登记 → API 写那一列并刷投影 → worker 拿到真实回执，三段都走真角色、真 RLS。
 *
 * 需要一次性库：`bash scripts/dev-disposable-db.sh astella_note_share_it`
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import postgres from "postgres";
import { getCompanionAgentTool, resolveAllCompanionAgentTools } from "@astella/shared";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { noteShareScopeReceiptV1Schema } from "@astella/shared/note-share-contracts";
import { executeDirectTool } from "../handlers/companion-tool-execution.ts";
import type { AgentEventContext } from "../handlers/companion-read-tools.ts";
import { CompanionToolNotExecutedError } from "../handlers/companion-tool-result.ts";
import { closeDatabase } from "../db.ts";
import { withWorkspaceTransaction, closeDatabase as closeApiDatabase } from "../../../../apps/api/src/db/client.ts";
import { createNote } from "../../../../apps/api/src/modules/note/service.ts";
import { processCompanionNoteShare } from "../../../../apps/api/src/modules/note/companion-share-dispatch.ts";

const dbUrl = testDatabaseUrl("DATABASE_URL_MIGRATOR");
if (!new URL(dbUrl).pathname.startsWith("/astella_note_share_"))
  throw new Error("Use an isolated astella_note_share_* database");
const admin = postgres(dbUrl, { max: 3 });
after(async () => { await admin.end(); await closeDatabase(); await closeApiDatabase(); });

async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), otherUserId = randomUUID();
  const runId = randomUUID(), jobId = randomUUID();
  const conversationId = randomUUID(), messageId = randomUUID(), stepId = randomUUID();
  const offeredTools = resolveAllCompanionAgentTools("full")
    .map(({ name, toolVersion, riskClass }) => ({ name, toolVersion, riskClass }));
  await admin.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id',${workspaceId},true),set_config('app.user_id',${userId},true)`;
    for (const [id, email] of [[userId, `share-owner-${userId}@test.invalid`],
      [otherUserId, `share-author-${otherUserId}@test.invalid`]] as const) {
      await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${id},${email},'h','owner')`;
    }
    await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${workspaceId},'共享能力隔离回归',${userId})`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${userId},0,true)`;
    await tx`INSERT INTO companion_conversations(id,workspace_id,user_id,kind,title,title_source,status,next_message_seq)
      VALUES(${conversationId},${workspaceId},${userId},'dialogue','共享讨论','auto','active',2)`;
    await tx`INSERT INTO companion_messages(id,conversation_id,workspace_id,user_id,role,seq,kind,blocks,content_sha256)
      VALUES(${messageId},${conversationId},${workspaceId},${userId},'user',1,'text',
        ${tx.json([{ type: 'text', text: '把这篇共享给空间。' }])},${'0'.repeat(64)})`;
    await tx`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,lease_token,started_at)
      VALUES(${jobId},'companion_agent',${workspaceId},${userId},${tx.json({runId})},'running','share-lease',now())`;
    await tx`INSERT INTO companion_turn_runs(id,conversation_id,workspace_id,user_id,user_message_id,generation,status,
      idempotency_key_hash,request_body_hash,account_epoch,job_id,permission_level,permission_snapshot)
      VALUES(${runId},${conversationId},${workspaceId},${userId},${messageId},1,'running',${'a'.repeat(64)},${'b'.repeat(64)},0,${jobId},'full',${tx.json({ version: 1, level: 'full', offeredTools })})`;
    await tx`INSERT INTO companion_agent_steps(id,workspace_id,user_id,conversation_id,run_id,step_no,kind,status)
      VALUES(${stepId},${workspaceId},${userId},${conversationId},${runId},1,'model','running')`;
  });
  const mineCreated = await withWorkspaceTransaction({ workspaceId, userId }, tx => createNote(tx, workspaceId, userId, {
    title: "电功率", blocks: [{ type: "paragraph", content: "单位时间内转换的电能。" }],
  }));
  assert.ok(mineCreated);
  const mine = mineCreated.note.id;
  // 空间里**别人写**的一篇：笔记走真实创建路径，建好之后把 `created_by` 改指给别人，
  // 并直接设成 shared 让它在空间里可见。
  // 为什么不干脆用别人建：库里"谁能建笔记"本身另有判据，混进来这条用例就不知道自己在测什么。
  // 私有笔记也不行——那时"改不动"是**看不见**造成的，而这条要钉的是作者判据本身。
  const theirsCreated = await withWorkspaceTransaction({ workspaceId, userId }, tx => createNote(tx, workspaceId, userId, {
    title: "欧姆定律", blocks: [{ type: "paragraph", content: "U = IR。" }],
  }));
  assert.ok(theirsCreated);
  const theirs = theirsCreated.note.id;
  await admin`UPDATE notes SET share_scope='shared', created_by=${otherUserId} WHERE id=${theirs}`;
  const scopeOf = async (noteId: string) =>
    (await admin`SELECT share_scope, updated_at FROM notes WHERE id=${noteId}`)[0];
  /**
   * 走完整的一条派发链：台账先落一条 executing 的调用（与真实循环一致），
   * worker 那侧开始等回执，API 那侧被真实触发一次。
   */
  const share = async (noteId: string, shareScope: "private" | "shared") => {
    const callId = randomUUID(), toolCallId = randomUUID();
    await admin.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id',${workspaceId},true),set_config('app.user_id',${userId},true)`;
      await tx`INSERT INTO companion_agent_tool_calls(id,workspace_id,user_id,conversation_id,run_id,step_id,tool_call_id,
        name,tool_version,arguments,arguments_sha256,risk_class,status)
        VALUES(${callId},${workspaceId},${userId},${conversationId},${runId},${stepId},${toolCallId},
          'companion_share_note','1.0.0',${tx.json({ noteId, shareScope })},${'c'.repeat(64)},
          'reversible_low','executing')`;
    });
    const event = {
      ctx: { id: jobId, workspaceId, requestedBy: userId, leaseToken: 'share-lease', payload: { runId },
        signal: new AbortController().signal },
      read: { userId, runId, accountEpoch: 0, generation: 1 },
      expiresAt: new Date(Date.now() + 60_000), constraints: {},
    } as unknown as AgentEventContext;
    const pending = executeDirectTool(event, getCompanionAgentTool("companion_share_note")!,
      { noteId, shareScope }, new AbortController().signal, toolCallId);
    await processCompanionNoteShare({ workspaceId, userId }, callId);
    return pending;
  };
  return { share, scopeOf, mine, theirs };
}

test("作者把自己写的笔记共享给空间：API 落库，worker 拿到真实回执", async () => {
  const f = await fixture();
  const result = await f.share(f.mine, "shared");
  const receipt = noteShareScopeReceiptV1Schema.parse(JSON.parse(result.resultRef!));
  assert.equal(receipt.changed, true);
  assert.equal((await f.scopeOf(f.mine)).share_scope, "shared");
  assert.match(result.safeSummary ?? "", /已共享给空间/);
  assert.ok(result.blocks?.some(block => block.type === "nav"), "要给出回到那篇的入口");
});

test("重复设成同一个档位是幂等的：不写行也不推更新时间", async () => {
  const f = await fixture();
  await f.share(f.mine, "shared");
  const before = await f.scopeOf(f.mine);
  const again = await f.share(f.mine, "shared");
  assert.equal(noteShareScopeReceiptV1Schema.parse(JSON.parse(again.resultRef!)).changed, false);
  assert.match(again.safeSummary ?? "", /本来就是/, "没改动时不能说她改了什么");
  const after = await f.scopeOf(f.mine);
  assert.equal(after.updated_at.getTime(), before.updated_at.getTime(), "幂等那次不许推 updated_at");
});

test("取消共享真实落回 private", async () => {
  const f = await fixture();
  await f.share(f.mine, "shared");
  const back = await f.share(f.mine, "private");
  assert.equal(noteShareScopeReceiptV1Schema.parse(JSON.parse(back.resultRef!)).changed, true);
  assert.equal((await f.scopeOf(f.mine)).share_scope, "private");
});

test("不是作者就改不动，哪怕那篇在空间里本来就看得见", async () => {
  const f = await fixture();
  await assert.rejects(() => f.share(f.theirs, "private"),
    (error: unknown) => error instanceof CompanionToolNotExecutedError && /不是这位用户写的/.test(String(error)));
  assert.equal((await f.scopeOf(f.theirs)).share_scope, "shared", "拒绝之后那一篇必须一个字没动");
});
