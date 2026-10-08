import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import postgres from "postgres";

test("fresh lease heartbeats keep long work alive and stale owners cannot commit", async () => {
  const url = process.env.JOB_BUDGET_TEST_DATABASE_URL;
  if (!url || !/^\/(?:astella_maketest|astella_job_budget_[a-zA-Z0-9_]+)$/.test(new URL(url).pathname)) {
    throw new Error("Use an isolated astella_job_budget_* database or astella_maketest");
  }
  const db = postgres(url, { max: 1 });
  const rollback = new Error("rollback synthetic job");
  try {
    await assert.rejects(db.begin(async tx => {
      const actor = randomUUID(), workspace = { id: randomUUID() };
      await tx`INSERT INTO users(id,email,password_hash) VALUES(${actor},${`budget-${actor}@example.test`},'synthetic')`;
      await tx`INSERT INTO workspaces(id,owner_id,name) VALUES(${workspace.id},${actor},'Budget lease probe')`;
      const id = randomUUID(), token = randomUUID();
      await tx`INSERT INTO jobs(id,type,workspace_id,payload,status,started_at,lease_token)
        VALUES(${id},'budget_lease_probe',${workspace.id},'{}','running',clock_timestamp()-interval '10 minutes',${token})`;
      const [initial] = await tx`SELECT started_at FROM jobs WHERE id=${id}`;
      const [renewed] = await tx`SELECT astella_renew_job_lease(${id},${workspace.id},${token}) AS ok`;
      assert.equal(renewed.ok, true);
      const [live] = await tx`SELECT started_at,lease_renewed_at FROM jobs WHERE id=${id}`;
      assert.equal(live.started_at.getTime(), initial.started_at.getTime(), "heartbeat must preserve real execution start");
      assert.ok(live.lease_renewed_at.getTime() > live.started_at.getTime());
      const healthy = await tx`SELECT * FROM astella_reap_stale_jobs(120000,3)`;
      assert.equal(healthy.some(row => row.id === id), false, "long work with a fresh heartbeat was reaped");
      const [wrongToken] = await tx`SELECT astella_renew_job_lease(${id},${workspace.id},${randomUUID()}) AS ok`;
      assert.equal(wrongToken.ok, false);
      await tx`UPDATE jobs SET lease_renewed_at=clock_timestamp()-interval '10 minutes' WHERE id=${id}`;
      const stale = await tx`SELECT * FROM astella_reap_stale_jobs(120000,3)`;
      assert.equal(stale.some(row => row.id === id), true, "crashed work was not recovered");
      const [lateRenew] = await tx`SELECT astella_renew_job_lease(${id},${workspace.id},${token}) AS ok`;
      const [lateFinish] = await tx`SELECT astella_finish_job(${id},${workspace.id},${token}) AS ok`;
      assert.equal(lateRenew.ok, false);
      assert.equal(lateFinish.ok, false);
      throw rollback;
    }), error => error === rollback);
  } finally { await db.end(); }
});
