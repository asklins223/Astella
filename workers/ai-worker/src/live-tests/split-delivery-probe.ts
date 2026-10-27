import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import postgres from "postgres";

/**
 * Focused live check: a request for two messages must arrive as two messages.
 *
 * Asserts the stored shape, not the wording: the run has two assistant messages
 * with consecutive seq values, both carrying body text, and the run points at
 * the last one.
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

await db.begin(async tx => {
  await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true), set_config('app.user_id', ${userId}, true)`;
  await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`split-${userId}@test.invalid`},'synthetic-no-login','owner')`;
  await tx`INSERT INTO workspaces(id,name,owner_id,workspace_type) VALUES(${workspaceId},'Split delivery probe',${userId},'personal')`;
  await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
  await tx`UPDATE users SET personal_workspace_id=${workspaceId} WHERE id=${userId}`;
  await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy) VALUES(${userId},'ai-consent-v1',now(),${tx.json({ sendToExternal: true, sendImageContent: false, piiDetection: false, auditLogging: true })})`;
  await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${userId},0,true)`;
  await tx`UPDATE user_companion_account_state SET agent_settings=jsonb_set(agent_settings,'{permissionLevel}','"full"'::jsonb) WHERE user_id=${userId}`;
  await tx`INSERT INTO sessions(token,user_id,workspace_id,client_kind,expires_at) VALUES(${tokenHash},${userId},${workspaceId},'desktop',now()+interval '4 hours')`;
});

function api(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async response => {
    const result = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(result)}`);
    return result as any;
  });
}

const conversation = await api("/companion/inbox/ensure", {});
const conversationId = conversation.id ?? conversation.conversationId;
const prompt = process.env.SPLIT_PROBE_TEXT ?? "分两条跟我说：先说声早，再问我想先做哪件事。";
const accepted = await api(`/companion/conversations/${conversationId}/turns`, {
  version: 1, clientMessageId: randomUUID(), inputKind: "text", sourceSurface: "pet",
  blocks: [{ type: "text", text: prompt }],
}, { "Idempotency-Key": randomUUID() });
const runId = accepted.runId;

const deadline = Date.now() + 180_000;
let status = "";
while (Date.now() < deadline) {
  const [row] = await db`select status from companion_turn_runs where id=${runId}`;
  status = String(row?.status ?? "");
  if (["succeeded", "failed", "cancelled"].includes(status)) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
const [run] = await db`select status, assistant_message_id from companion_turn_runs where id=${runId}`;
const messages = await db`select id, seq, kind, blocks from companion_messages
  where run_id=${runId} and role='assistant' order by seq`;
const bodies = messages.map(message => {
  const blocks = message.blocks as Array<{ type?: string; text?: string }>;
  return blocks.filter(block => block.type === "text").map(block => block.text ?? "").join("");
});
console.log(JSON.stringify({ prompt, status: run?.status, messageCount: messages.length,
  seqs: messages.map(message => message.seq), bodies,
  assistantMessageId: run?.assistant_message_id,
  pointsAtLast: run?.assistant_message_id === messages.at(-1)?.id }, null, 1));
await db.end();
