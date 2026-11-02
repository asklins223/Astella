import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const url = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!url) throw new Error("companion terminal-step integration requires a migrated PostgreSQL database");

test("terminal runs close running steps, preserving finished steps and uncertain tool receipts", async () => {
  const db = postgres(url, { max: 1 });
  try {
    for (const status of ["cancelled", "superseded", "failed", "succeeded"]) {
      await db.begin(async tx => {
        const uid = randomUUID(), wid = randomUUID(), cid = randomUUID(), rid = randomUUID();
        await tx`SELECT set_config('app.user_id', ${uid}, true), set_config('app.workspace_id', ${wid}, true)`;
        await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${uid},${uid+'@test.invalid'},'no-login','owner')`;
        await tx`INSERT INTO workspaces(id,name,owner_id,workspace_type) VALUES(${wid},'terminal-step test',${uid},'personal')`;
        await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${wid},${uid},'owner')`;
        await tx`INSERT INTO companion_conversations(id,workspace_id,user_id,kind,title,title_source,status)
          VALUES(${cid},${wid},${uid},'dialogue','terminal-step test','system','active')`;
        await tx`INSERT INTO companion_turn_runs(id,workspace_id,user_id,conversation_id,generation,status,idempotency_key_hash,request_body_hash,account_epoch,input_source)
          VALUES(${rid},${wid},${uid},${cid},1,'running',${'a'.repeat(64)},${'b'.repeat(64)},0,'{"kind":"initiative"}')`;
        const stepId = randomUUID();
        await tx`INSERT INTO companion_agent_steps(id,workspace_id,user_id,conversation_id,run_id,step_no,kind,status)
          VALUES(${stepId},${wid},${uid},${cid},${rid},1,'model','running'),(${randomUUID()},${wid},${uid},${cid},${rid},2,'model','succeeded')`;
        await tx`INSERT INTO companion_agent_tool_calls(id,workspace_id,user_id,conversation_id,run_id,step_id,tool_call_id,
          name,tool_version,arguments,arguments_sha256,risk_class,status)
          VALUES(${randomUUID()},${wid},${uid},${cid},${rid},${stepId},'uncertain-write','notes.write.create','1.0.0',
            '{}',${'c'.repeat(64)},'reversible_low','executing')`;
        await tx`UPDATE companion_turn_runs SET status=${status} WHERE id=${rid}`;
        const rows = await tx`SELECT status,error_code,finished_at FROM companion_agent_steps WHERE run_id=${rid} ORDER BY step_no`;
        assert.equal(rows[0]!.status, ['cancelled','superseded'].includes(status) ? 'cancelled' : 'failed');
        assert.ok(rows[0]!.finished_at);
        assert.ok(rows[0]!.error_code);
        assert.equal(rows[1]!.status, 'succeeded');
        const [receipt] = await tx`SELECT status FROM companion_agent_tool_calls WHERE run_id=${rid}`;
        assert.equal(receipt!.status, 'executing', 'terminal convergence must not invent a side-effect outcome');
        const [run] = await tx`SELECT finished_at FROM companion_turn_runs WHERE id=${rid}`;
        assert.ok(run!.finished_at);
        // A transaction rollback removes the complete isolated fixture.
        throw new Error('ROLLBACK_TERMINAL_FIXTURE');
      }).catch(error => { if (error.message !== 'ROLLBACK_TERMINAL_FIXTURE') throw error; });
    }
  } finally { await db.end(); }
});
