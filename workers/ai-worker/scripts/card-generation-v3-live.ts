/**
 * 简化链的**真模型一次**（39d W7-1 §8.6 的第一手读数；需要显式 `V3_LIVE=1` 才会发）。
 *
 * 要回答的问题只有三个，且都只有真模型能答：
 *  1. 从认领到 `review_ready` 要等多久（用户视角的等待成本）；
 *  2. 这一批真付了几发语义调用、多少 token（§16.28 那句"刚好 2 次"在真模型下成立吗）；
 *  3. 真模型的输出过不过得了程序校验与闸门——被剔除多少、几张 `passed`、有没有 needs_attention。
 *
 * 现场落在一次性库上（自己种、自己清），不在共用 dev 库留账。跑法见文件末尾打印的那条命令。
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";

const GATE = process.env.V3_LIVE;
const PROVIDER = process.env.CARD_GENERATION_V3_PROVIDER;
const missing: string[] = [];
if (GATE !== "1") missing.push("V3_LIVE=1（这一发要花钱，必须显式给）");
if (PROVIDER !== "llm") missing.push("CARD_GENERATION_V3_PROVIDER=llm");
if (!process.env.DATABASE_URL_MIGRATOR) missing.push("DATABASE_URL_MIGRATOR");
if (missing.length > 0) {
  console.error(`[v3-live] 环境不在位，拒绝外发：\n  - ${missing.join("\n  - ")}`);
  process.exit(2);
}

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });
const workspaceId = randomUUID();
const userId = randomUUID();
const noteId = randomUUID();
const versionId = randomUUID();
const blocks = [
  "TCP 建立连接时双方各自确认一次序号，确认完成之后才开始传数据。",
  "HTTP 是无状态协议，服务端默认不记得上一个请求发生过什么。",
  "对称加密的密钥必须事先约定好，非对称加密用公钥加密、私钥解密。",
  "DNS 解析先把域名换成 IP 地址，之后才向目标服务器发起连接。",
  "TLS 握手在应用层数据之前完成，它协商的是加密套件和会话密钥。",
  "零拷贝传输减少内核态与用户态之间的复制次数，从而提高大文件传输效率。",
];

async function seed(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${userId}, ${`v3-live-${userId.slice(0, 8)}@example.invalid`}, 'unused')`;
    await tx`INSERT INTO workspaces (id, owner_id, name) VALUES (${workspaceId}, ${userId}, 'V3 Live')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;
    // 同意是账号级的（0237），且外发政策默认 false ⇒ 没有这一行，非 mock 调用出不了网。
    await tx`INSERT INTO user_ai_settings (user_id, consent_version, consent_at, data_policy)
      VALUES (${userId}, 'v3-live-consent', now(),
              ${JSON.stringify({
                sendToExternal: true, sendImageContent: false, piiDetection: true, auditLogging: true,
              })}::jsonb)`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${noteId}, ${workspaceId}, '网络与加密的六句话', ${userId})`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${versionId}, ${noteId}, ${workspaceId}, 1,
              ${tx.json({ blocks: blocks.map((content) => ({ type: "paragraph", content })) })},
              ${`v3-live-${noteId.slice(0, 8)}`}, ${userId})`;
    for (const [ordinal, content] of blocks.entries()) {
      await tx`INSERT INTO note_blocks (id, version_id, workspace_id, type, content, ordinal)
        VALUES (${randomUUID()}, ${versionId}, ${workspaceId}, 'paragraph', ${content}, ${ordinal + 1})`;
    }
  });
}

async function preflight(workspaceId: string, userId: string): Promise<string[]> {
  // 判据取生产那一份（`resolveAIGovernanceContext`），不在这里自己重算平台选择：重算就会和
  // 真的出口不一致，那是最难查的那种"看着像真模型跑过了"。
  const { resolveAIGovernanceContext } = await import("../src/lib/governance.ts");
  const ctx = await resolveAIGovernanceContext(workspaceId, userId);
  const problems: string[] = [];
  if (String(ctx.providerName).toLowerCase() === "mock") {
    problems.push(`出口解析成了 mock（providerName=${String(ctx.providerName)}）——外发不会真的发生`);
  }
  if (!ctx.consentOk) problems.push("consentOk=false：同意或外发政策没到位，非 mock 调用出不了网");
  return problems;
}

async function main(): Promise<number> {
  await seed();
  // 上一版吃过这个亏：把 `DATABASE_URL*` 指到一次性库时顺手把 `.env` 里的密钥也带丢了，
  // 于是这一发安静地落到 mock（护栏当场拒，job 记 failed），读起来却像"真模型没过合同"。
  const preflightProblems = await preflight(workspaceId, userId);
  if (preflightProblems.length > 0) {
    const { wipeCardGenerationFixtures } = await import(
      "../src/integration-tests/card-generation-fixture-cleanup.ts"
    );
    await wipeCardGenerationFixtures(admin, [workspaceId], [userId]);
    await admin.end({ timeout: 5 });
    console.error(`[v3-live] 出口不是真 provider，拒绝外发：\n  - ${preflightProblems.join("\n  - ")}`);
    return 2;
  }
  const { createGenerationRunV2 } = await import(
    "../../../apps/api/src/modules/card-generation-v2/generation-run-service.ts"
  );
  const clientRequestId = `v3-live-${randomUUID()}`;
  const created = await createGenerationRunV2(
    { workspaceId, userId },
    versionId,
    {
      version: 2, noteVersionId: versionId, sourceScope: { kind: "whole_note" },
      learningGoal: "understand", detailThreshold: "balanced",
      quantity: { kind: "adaptive" }, clientRequestId,
    },
    clientRequestId,
  );
  const runId = String((created as { runId?: string }).runId ?? (created as { id?: string }).id);

  const leaseToken = randomUUID();
  const claimed = await admin.begin(async (tx) => {
    const rows = await tx`
      UPDATE card_generation_run_outbox_v2
      SET status = 'processing', started_at = now(),
          lease_expires_at = now() + interval '30 minutes', lease_token = ${leaseToken}
      WHERE run_id = ${runId} AND job_type = 'card_generation_simplified_v1' AND status = 'pending'
      RETURNING id, workspace_id, run_id, job_type, payload
    ` as unknown as Array<{ id: string; workspace_id: string; run_id: string; job_type: string;
      payload: Record<string, unknown> }>;
    const row = rows[0];
    return row
      ? { id: row.id, workspaceId: row.workspace_id, runId: row.run_id, jobType: row.job_type,
        payload: row.payload, leaseToken }
      : null;
  });
  if (!claimed) {
    console.error("[v3-live] 没能认领到简化链 job");
    return 3;
  }

  const { processV2OutboxJob } = await import("../src/handlers/card-generation-v2-handler.ts");
  const startedAt = Date.now();
  let jobError: string | null = null;
  try {
    await processV2OutboxJob(claimed);
  } catch (error) {
    jobError = error instanceof Error ? error.message : String(error);
  }
  const elapsedMs = Date.now() - startedAt;

  const run = await admin`
    SELECT status, error_code, error_message FROM card_generation_runs_v2 WHERE id = ${runId}
  ` as unknown as Array<{ status: string; error_code: string | null; error_message: string | null }>;
  const plan = await admin`
    SELECT result ->> 'kind' AS kind FROM card_generation_plans_v2 WHERE run_id = ${runId}
  ` as unknown as Array<{ kind: string }>;
  const candidates = await admin`
    SELECT quality_state, publish_state, count(*)::int AS n
    FROM card_generation_candidates_v2 WHERE run_id = ${runId} AND revision = 1
    GROUP BY quality_state, publish_state ORDER BY quality_state
  ` as unknown as Array<Record<string, unknown>>;
  const event = await admin`
    SELECT payload FROM card_generation_events_v2
    WHERE run_id = ${runId} AND event_type = 'card_generation.simplified_completed'
    ORDER BY event_seq DESC LIMIT 1
  ` as unknown as Array<{ payload: Record<string, unknown> }>;
  const audit = await admin`
    SELECT provider, model_id, operation, status, count(*)::int AS calls,
           COALESCE(sum(cost_tokens),0)::int AS tokens, COALESCE(max(duration_ms),0)::int AS slowest_ms
    FROM ai_audit_log WHERE workspace_id = ${workspaceId}
    GROUP BY provider, model_id, operation, status
  ` as unknown as Array<Record<string, unknown>>;
  // 失败时最厚的那一句在 outbox 行上（`last_error` 是分发点 sanitize 后写进去的）；
  // 上一版没读它，结果"为什么没过合同"这个唯一的问答题跟着清场一起没了。
  const outbox = await admin`
    SELECT status, attempts, last_error FROM card_generation_run_outbox_v2 WHERE run_id = ${runId}
  ` as unknown as Array<{ status: string; attempts: number; last_error: string | null }>;

  console.log(JSON.stringify({
    elapsedMs,
    runStatus: run[0]?.status ?? null,
    runError: run[0]?.error_code ?? null,
    jobError,
    planKind: plan[0]?.kind ?? null,
    candidates,
    completionEvent: event[0]?.payload ?? null,
    audit,
    outbox,
    runMessage: run[0]?.error_message ?? null,
    gateRejected: (event[0]?.payload as { gateRejected?: unknown } | undefined)?.gateRejected ?? null,
  }, null, 2));

  const ok = run[0]?.status === "review_ready" && jobError === null;
  // 清场：走那份**共用的**夹具台子（它带维护闸门，能删掉只追加守卫管着的行，并回读计数
  // 报"还剩什么"）。手写一串 DELETE 是走不通的：notes 级联到 evidence bindings 那族时会被
  // `prevent_card_generation_immutable_delete()` 当场挡下并回滚整个事务（本次实犯一次）。
  const { wipeCardGenerationFixtures } = await import(
    "../src/integration-tests/card-generation-fixture-cleanup.ts"
  );
  const wipe = await wipeCardGenerationFixtures(admin, [workspaceId], [userId]);
  console.log(`[v3-live] verdict=${ok ? "review_ready" : "NOT review_ready"} wipe=${JSON.stringify(wipe)}`);
  // 三个池都要关：这一发为了走真入口还间接开了 api 与 worker 各自的连接池，只关 `admin`
  // 会让进程挂在那里不退（实测挂过一次，四条 idle 连接把一次性库 `ailearn_cardtest`
  // 挡得没法重建——下一次真跑前必须先清点上一发的收尾）。
  const { closeDatabase: closeWorkerDatabase } = await import("../src/db.ts");
  await closeWorkerDatabase().catch(() => undefined);
  const { closeDatabase: closeApiDatabase } = await import(
    "../../../apps/api/src/db/client.ts"
  );
  await closeApiDatabase().catch(() => undefined);
  await admin.end({ timeout: 5 });
  return ok ? 0 : 4;
}

process.exitCode = await main();
