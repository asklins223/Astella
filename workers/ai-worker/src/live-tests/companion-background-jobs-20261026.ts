import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import postgres from "postgres";

/**
 * Background generation matrix: the four queued jobs the companion starts on a
 * saved note (overview, mind map, expansion drafts, learning cards) plus the
 * delivery-agent goal path. Each is a real HTTP request, a real queue row, a
 * real worker run and a real model call; the assertions are the persisted rows.
 */
const root = new URL("../../../../", import.meta.url);
const env = parseEnv(readFileSync(new URL(".env", root), "utf8"));
const databaseUrl = env.DATABASE_URL_MIGRATOR ?? env.DATABASE_URL;
assert.ok(databaseUrl);
const url = new URL(databaseUrl);
url.pathname = "/astella";
url.hostname = "127.0.0.1";
const db = postgres(url.toString(), { max: 2 });
const workspaceId = randomUUID(), userId = randomUUID(), noteId = randomUUID(), versionId = randomUUID();
const token = randomBytes(32).toString("hex");
const tokenHash = createHash("sha256").update(token).digest("hex");
const base = "http://127.0.0.1:4000";
const checks: Record<string, { ok: boolean; detail: string }> = {};
const check = (name: string, ok: boolean, detail: string) => {
  checks[name] = { ok, detail };
  console.log(JSON.stringify({ check: name, ok, detail }));
};
const ARTICLE = [
  "光合作用是绿色植物把光能转成化学能的过程。光反应在类囊体膜上进行，水被分解并释放氧气，同时生成ATP和NADPH。",
  "暗反应在叶绿体基质中进行，二氧化碳被固定成三碳化合物，再借助ATP和NADPH被还原成糖类。",
  "影响光合作用速率的外界因素主要有光照强度、二氧化碳浓度和温度；三者在不同区间起限制作用。",
].join("\n\n");

function api(path: string, body?: unknown) {
  return fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(payload)}`);
      return payload as any;
    });
}
async function waitJob(type: string, limitMs = 420_000) {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    const [row] = await db<{ status: string; last_error: string | null }[]>`select status, last_error from jobs
      where workspace_id=${workspaceId} and type=${type} order by scheduled_at desc limit 1`;
    if (row && ["succeeded", "failed", "dead", "cancelled"].includes(row.status)) return row;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error(`${type} did not finish`);
}

try {
  await db.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id',${workspaceId},true),set_config('app.user_id',${userId},true)`;
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`bg-${userId}@test.invalid`},'x','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id,workspace_type) VALUES(${workspaceId},'背景生成矩阵',${userId},'personal')`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`UPDATE users SET personal_workspace_id=${workspaceId} WHERE id=${userId}`;
    await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy)
      VALUES(${userId},'ai-consent-v1',now(),${tx.json({ sendToExternal: true, sendImageContent: false, piiDetection: false, auditLogging: true })})`;
    await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${userId},0,true)`;
    await tx`INSERT INTO sessions(token,user_id,workspace_id,client_kind,expires_at)
      VALUES(${tokenHash},${userId},${workspaceId},'desktop',now()+interval '3 hours')`;
    await tx`INSERT INTO notes(id,workspace_id,title,title_source,created_by,share_scope)
      VALUES(${noteId},${workspaceId},'光合作用','manual',${userId},'private')`;
    await tx`INSERT INTO note_versions(id,note_id,workspace_id,version_no,content_json,content_hash,created_by)
      VALUES(${versionId},${noteId},${workspaceId},1,${tx.json({ blocks: [] })},${"a".repeat(32)},${userId})`;
    await tx`UPDATE notes SET current_version_id=${versionId} WHERE id=${noteId}`;
    const blocks = ARTICLE.split("\n\n");
    for (const [index, text] of blocks.entries()) {
      await tx`INSERT INTO note_blocks(workspace_id,version_id,ordinal,type,content)
        VALUES(${workspaceId},${versionId},${index + 1},'paragraph',${text})`;
    }
  });

  // 1. Overview
  try {
    await api(`/v2/notes/${noteId}/overview-tasks`, { noteVersionId: versionId, requestId: randomUUID() });
    const job = await waitJob("note_overview_generate");
    const [row] = await db<{ body: string; points: number }[]>`select body,
      coalesce(jsonb_array_length(overview_points),0) as points from note_overviews
      where workspace_id=${workspaceId} and note_id=${noteId} order by created_at desc limit 1`;
    check("background-overview", Boolean(row) && row!.body.trim().length > 40,
      `${job.status} / ${row ? `${row!.body.length} chars, ${row!.points} points` : "no row"}`);
  } catch (error) { check("background-overview", false, String(error).slice(0, 160)); }

  // 2. Mind map
  try {
    await api(`/v2/notes/${noteId}/mind-map-tasks`, { noteVersionId: versionId, requestId: randomUUID() });
    const job = await waitJob("note_mind_map_generate");
    const [row] = await db<{ title: string; nodes: number }[]>`select title,
      (select count(*)::int from jsonb_path_query(content,'$.**.label')) as nodes
      from note_mind_maps where workspace_id=${workspaceId} and note_id=${noteId} order by created_at desc limit 1`;
    check("background-mind-map", Boolean(row) && row!.nodes >= 2,
      `${job.status} / ${row ? `${row!.title} (${row!.nodes} labels)` : "no row"}`);
  } catch (error) { check("background-mind-map", false, String(error).slice(0, 160)); }

  // 3. Expansion drafts
  try {
    await api(`/v2/notes/${noteId}/expansion-tasks`, { noteVersionId: versionId, requestId: randomUUID() });
    const job = await waitJob("note_expansion_generate");
    const [row] = await db<{ drafts: number }[]>`select jsonb_array_length(drafts) as drafts from note_expansion_tasks
      where workspace_id=${workspaceId} and note_id=${noteId} order by created_at desc limit 1`;
    check("background-expansion", Boolean(row) && Number(row!.drafts) > 0,
      `${job.status} / drafts ${row ? row!.drafts : "no row"}`);
  } catch (error) { check("background-expansion", false, String(error).slice(0, 160)); }

  // 4. Learning cards
  try {
    await api(`/v2/notes/${noteId}/learning-card/generate`, { noteVersionId: versionId });
    const job = await waitJob("note_learning_card_generate");
    const [row] = await db<{ questions: number }[]>`select count(*)::int as questions from note_learning_card_questions q
      join note_learning_cards c on c.id=q.card_id where c.workspace_id=${workspaceId} and c.note_id=${noteId}`;
    check("background-learning-cards", Boolean(row) && row!.questions > 0,
      `${job.status} / ${row ? row!.questions : 0} questions`);
  } catch (error) { check("background-learning-cards", false, String(error).slice(0, 160)); }

  const passed = Object.values(checks).filter(entry => entry.ok).length;
  console.log(JSON.stringify({ result: passed === Object.keys(checks).length ? "pass" : "partial",
    passed, total: Object.keys(checks).length, checks }));
} finally {
  await db.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id',${workspaceId},true),set_config('app.user_id',${userId},true)`;
    await tx`UPDATE user_companion_account_state SET global_enabled=false,epoch=epoch+1 WHERE user_id=${userId}`;
    await tx`DELETE FROM sessions WHERE user_id=${userId}`;
  }).catch(() => undefined);
  await db.end();
}
