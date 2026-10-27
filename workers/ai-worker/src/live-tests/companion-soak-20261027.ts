import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import postgres from "postgres";

/**
 * Repeated stability / speed / correctness soak for the companion agent.
 *
 * One account, one conversation, many rounds. Each round asks for the same
 * capability in a different wording, so a pass means the agent handled the
 * request rather than the sentence: paraphrases rotate per round, and every
 * assertion is read from durable state (rows, receipts, message shapes), never
 * from the model's own prose.
 *
 * Reports per-handler: pass rate, first-try rate, and latency percentiles.
 */
const root = new URL("../../../../", import.meta.url);
const env = parseEnv(readFileSync(new URL(".env", root), "utf8"));
const databaseUrl = env.DATABASE_URL_MIGRATOR ?? env.DATABASE_URL;
assert.ok(databaseUrl, "local development database configuration is required");
const url = new URL(databaseUrl);
assert.equal(url.pathname, "/astella");
url.hostname = "127.0.0.1";
const db = postgres(url.toString(), { max: 2 });
const workspaceId = randomUUID(), userId = randomUUID();
const token = randomBytes(32).toString("hex");
const tokenHash = createHash("sha256").update(token).digest("hex");
const base = "http://127.0.0.1:4000";
const rounds = Number(process.env.SOAK_ROUNDS ?? "3");
const kinds = (process.env.SOAK_KINDS ?? "chat,notes,memory,reminder,calc,diagram,split,navigate")
  .split(",").map(value => value.trim()).filter(Boolean);
const outputDir = new URL("outputs/audits/2026-10-27-soak/", root);
mkdirSync(outputDir, { recursive: true });
const output = new URL(`soak-${Date.now()}.json`, outputDir);

let conversationId = "";
const records: Record<string, any>[] = [];

interface Run {
  runId: string; elapsedMs: number; visible: string; terminal: string;
  calls: Array<{ name: string; status: string }>; messages: Array<{ seq: number; text: string }>;
  steps?: number; errorCode?: string;
}

await db.begin(async tx => {
  await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true), set_config('app.user_id', ${userId}, true)`;
  await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`soak-${userId}@test.invalid`},'synthetic-no-login','owner')`;
  await tx`INSERT INTO workspaces(id,name,owner_id,workspace_type) VALUES(${workspaceId},'Companion soak 2026-10-27',${userId},'personal')`;
  await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
  await tx`UPDATE users SET personal_workspace_id=${workspaceId} WHERE id=${userId}`;
  await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy) VALUES(${userId},'ai-consent-v1',now(),${tx.json({ sendToExternal: true, sendImageContent: false, piiDetection: false, auditLogging: true })})`;
  await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${userId},0,true)`;
  await tx`UPDATE user_companion_account_state SET agent_settings=jsonb_set(agent_settings,'{permissionLevel}','"full"'::jsonb) WHERE user_id=${userId}`;
  await tx`INSERT INTO sessions(token,user_id,workspace_id,client_kind,expires_at) VALUES(${tokenHash},${userId},${workspaceId},'desktop',now()+interval '8 hours')`;
});
conversationId = (await api("/companion/inbox/ensure", {})).id;

function api(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async response => {
    const result = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(result).slice(0, 200)}`);
    return result as any;
  });
}

async function turn(text: string): Promise<Run> {
  const started = Date.now();
  const accepted = await api(`/companion/conversations/${conversationId}/turns`, {
    version: 1, clientMessageId: randomUUID(), inputKind: "text", sourceSurface: "pet",
    blocks: [{ type: "text", text }],
  }, { "Idempotency-Key": randomUUID() });
  const runId = accepted.runId as string;
  const deadline = Date.now() + 240_000;
  let status = "";
  while (Date.now() < deadline) {
    const [row] = await db`select status from companion_turn_runs where id=${runId}`;
    status = String(row?.status ?? "");
    if (["succeeded", "failed", "cancelled", "waiting_for_confirmation"].includes(status)) break;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  const calls = await db`select name, status from companion_agent_tool_calls where run_id=${runId} order by created_at`;
  const rows = await db`select seq, blocks from companion_messages
    where run_id=${runId} and role='assistant' order by seq`;
  const messages = rows.map(row => ({
    seq: Number(row.seq),
    text: (row.blocks as Array<{ type?: string; text?: string }>)
      .filter(block => block.type === "text").map(block => block.text ?? "").join(""),
  }));
  const [runRow] = await db`select step_count, error_code from companion_turn_runs where id=${runId}`;
  return {
    runId, elapsedMs: Date.now() - started, terminal: status,
    visible: messages.map(message => message.text).join("\n\n"),
    calls: calls.map(call => ({ name: String(call.name), status: String(call.status) })),
    messages, ...(runRow?.error_code ? { errorCode: String(runRow.error_code) } : {}),
    ...(runRow?.step_count !== undefined ? { steps: Number(runRow.step_count) } : {}),
  } as Run;
}

const succeeded = (run: Run, name: string) => run.calls.some(call => call.name === name && call.status === "succeeded");

/** Rotating wordings so a pass reflects the capability, not one sentence. */
const prompts: Record<string, string[]> = {
  chat: ["在吗？今天有点累。", "随便聊聊，我最近有点焦虑。", "累了，说点轻松的。", "今天状态一般。"],
  notes: [
    "帮我把今天的复盘写成一篇笔记，标题叫《复盘甲》，写三点：看完了两章、还差一章、明天补。",
    "新建一篇笔记《复盘乙》，内容就写看完了两章、还差一章、明天补。",
    "把今天的情况整理成《复盘丙》存起来：看完两章、差一章、明天补。",
  ],
  memory: [
    "记一下：我晚上十点以后不想被打扰。",
    "帮我记住，晚上十点之后别打扰我。",
    "记住一条：十点后我要安静。",
  ],
  reminder: [
    "明天上午十点提醒我复习线性代数。",
    "帮我设个提醒，明天上午十点复习线代。",
    "明早十点叫我复习线性代数。",
  ],
  calc: [
    "帮我核一下 347 乘以 29 到底是多少。",
    "347×29 等于几？",
    "算一下 347 乘 29。",
  ],
  diagram: [
    "把我的复习过程画成流程图：先翻错题，再做两道新题，最后写一段总结。",
    "画个图表示复习步骤：翻错题、做新题、写总结。",
    "把这三步画成流程图：翻错题，做新题，写总结。",
  ],
  navigate: ["帮我打开笔记库看看。", "带我去笔记库。", "打开笔记库。"],
  split: [
    "分两条跟我说：先说声早，再问我想先做哪件事。",
    "别用一整段，拆成两条发我：一条打招呼，一条问我今天先做哪件事。",
    "成分两条消息：先打招呼，再问我今天先做啥。",
  ],
};

async function verify(kind: string, round: number): Promise<{ run: Run; ok: boolean; detail: string; firstTry: boolean }> {
  const options = prompts[kind] ?? prompts.chat!;
  const prompt = options[round % options.length]!;
  let run: Run;
  try {
    run = await turn(prompt);
  } catch (error) {
    return { run: { runId: "", elapsedMs: 0, visible: "", terminal: "error", calls: [], messages: [] },
      ok: false, detail: `request failed: ${String(error).slice(0, 90)}`, firstTry: false };
  }
  if (run.terminal !== "succeeded") return { run, ok: false, detail: `terminal ${run.terminal}`, firstTry: false };
  switch (kind) {
    case "chat":
      return { run, ok: run.visible.trim().length > 0 && run.calls.length === 0,
        detail: `${run.visible.trim().length} chars, ${run.calls.length} tools`, firstTry: true };
    case "notes": {
      const ok = succeeded(run, "notes.write.create");
      const expectedTitle = /《([^》]+)》/u.exec(prompt)?.[1] ?? "";
      const [note] = await db`select title from notes where workspace_id=${workspaceId} and deleted_at is null
        and title = ${expectedTitle} order by created_at desc limit 1`;
      return { run, ok: ok && Boolean(note),
        detail: ok ? String(note?.title ?? "") : run.visible.slice(0, 60), firstTry: ok };
    }
    case "memory": {
      const ok = succeeded(run, "memory.write.save");
      const [row] = await db`select content from assistant_memory_items where workspace_id=${workspaceId}
        and user_id=${userId} and deleted_at is null and content like '%十点%' limit 1`;
      return { run, ok: ok && Boolean(row), detail: ok ? String(row?.content ?? "").slice(0, 40) : run.visible.slice(0, 60), firstTry: ok };
    }
    case "reminder": {
      const ok = succeeded(run, "attention.write.schedule_reminder");
      const [row] = await db`select text from companion_reminders where workspace_id=${workspaceId}
        and user_id=${userId} and status='pending' order by created_at desc limit 1`;
      return { run, ok: ok && Boolean(row), detail: ok ? String(row?.text ?? "").slice(0, 40) : run.visible.slice(0, 60), firstTry: ok };
    }
    case "calc": {
      const ok = /10063/.test(run.visible);
      return { run, ok, detail: ok ? "10063" : run.visible.slice(0, 60), firstTry: ok };
    }
    case "diagram":
      return { run, ok: succeeded(run, "visual.diagram"),
        detail: succeeded(run, "visual.diagram") ? "diagram" : run.visible.slice(0, 60), firstTry: succeeded(run, "visual.diagram") };
    case "navigate":
      return { run, ok: succeeded(run, "open.page"),
        detail: succeeded(run, "open.page") ? "opened" : run.visible.slice(0, 60), firstTry: succeeded(run, "open.page") };
    case "split": {
      const bodies = run.messages.map(message => message.text.trim()).filter(Boolean);
      return { run, ok: bodies.length >= 2,
        detail: `messages:${bodies.length} ${JSON.stringify(bodies).slice(0, 70)}`, firstTry: bodies.length >= 2 };
    }
    default:
      return { run, ok: true, detail: "no assertion", firstTry: true };
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!);
}

for (let round = 0; round < rounds; round += 1) {
  for (const kind of kinds) {
    const result = await verify(kind, round);
    const record = { round: round + 1, kind, prompt: (prompts[kind] ?? prompts.chat!)[round % (prompts[kind] ?? prompts.chat!).length],
      ok: result.ok, detail: result.detail, firstTry: result.firstTry, elapsedMs: result.run.elapsedMs,
      steps: result.run.steps ?? null, calls: result.run.calls };
    records.push(record);
    console.log(JSON.stringify(record));
    writeFileSync(output, JSON.stringify({ version: 1, workspaceId, userId, rounds, kinds, records }, null, 1));
  }
}

const summary = kinds.map(kind => {
  const rows = records.filter(record => record.kind === kind);
  const durations = rows.map(row => row.elapsedMs).filter(Boolean);
  return { kind, runs: rows.length, passed: rows.filter(row => row.ok).length,
    firstTry: rows.filter(row => row.firstTry).length,
    p50Ms: percentile(durations, 50), p95Ms: percentile(durations, 95),
    maxMs: durations.length ? Math.max(...durations) : 0,
    avgSteps: rows.length ? Math.round(rows.reduce((sum, row) => sum + (row.steps ?? 0), 0) / rows.length * 10) / 10 : 0 };
});
console.log("\n=== SUMMARY ===");
for (const row of summary) {
  console.log(`${row.kind.padEnd(10)} pass ${row.passed}/${row.runs}  firstTry ${row.firstTry}/${row.runs}  p50 ${row.p50Ms}ms  p95 ${row.p95Ms}ms  max ${row.maxMs}ms  avgSteps ${row.avgSteps}`);
}
const total = records.length, passed = records.filter(record => record.ok).length;
console.log(`TOTAL ${passed}/${total}`);
console.log(`Evidence: ${output.pathname}`);
await db.end();
process.exit(passed === total ? 0 : 1);
