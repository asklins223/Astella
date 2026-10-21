import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import postgres from "postgres";
import { renderOperationTemplateV1, operationSpecV1Schema } from "@astella/shared/learning/note-learning-card-operation";
import { editFragmentBlockText } from "../../../../apps/api/src/modules/note/doc-fragment.ts";
const root = new URL("../../../../", import.meta.url), env = parseEnv(readFileSync(new URL(".env", root), "utf8"));
const database = new URL(env.DATABASE_URL_MIGRATOR ?? env.DATABASE_URL!);
assert.ok(["postgres", "localhost", "127.0.0.1"].includes(database.hostname) && database.pathname === "/astella");
database.hostname = "127.0.0.1";
const db = postgres(database.toString(), { max: 2 });
const workspaceId = randomUUID(), userId = randomUUID(), token = randomBytes(32).toString("hex");
const output = new URL(`outputs/audits/plan57-58-2026-10-21/card-http-${Date.now()}.json`, root);
const records: unknown[] = [];
let disabled = false;
const persist = () => writeFileSync(output, JSON.stringify({ syntheticAccount: true, workspaceId, userId, disabled, records }, null, 2));
const mutate = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) => db.begin(async tx => {
  await tx`SELECT set_config('app.workspace_id',${workspaceId},true), set_config('app.user_id',${userId},true)`; return fn(tx);
});
async function api(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`http://127.0.0.1:4000${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json() as any;
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`); return value;
}
async function wait<T>(read: () => Promise<T | null>, label: string) {
  const start = Date.now();
  while (Date.now() - start < 300_000) { const result = await read(); if (result !== null) return result; await new Promise(resolve => setTimeout(resolve, 900)); }
  throw new Error(`Probe observation ended: ${label}`);
}
const text = "电压、电阻与电流：欧姆定律为I=U/R。电压为6V、电阻为3Ω时，电流为2A。电压保持6V而电阻增加为6Ω，电流减为1A。电功率P=UI，因此6V与2A时功率为12W。实验先断开电源，再连接电路，核对连接，最后接通电源观察读数。电压的单位是伏特V，电阻的单位是欧姆Ω，电流的单位是安培A。";
async function newNote(title: string) { const result = await api("/notes", { title, blocks: [{ type: "paragraph", content: text }] }); return { noteId: result.note.id as string, versionId: result.version.id as string }; }
function submitted(row: any): unknown {
  const a = row.answer;
  switch (row.question_type) {
    case "single_choice": return { optionId: a.correctOptionId };
    case "multi_choice": return { optionIds: a.correctOptionIds };
    case "true_false": return a.correct;
    case "fill_blank": return { values: a.blanks.map((values: string[]) => values[0]) };
    case "ordering": return { order: a.order };
    case "matching": return { pairs: a.pairs };
    case "short_answer": return { text: JSON.stringify(row.rubric) + text };
    case "operation": return a.controls.length ? { kind: "controls", values: a.target } : { kind: "steps", steps: a.steps };
  }
}
async function practice(cardId: string, skips = false, partial = false) {
  const [first, second] = await Promise.all([api(`/v2/learning-cards/${cardId}/attempts`, {}), api(`/v2/learning-cards/${cardId}/attempts`, {})]);
  assert.equal(first.attemptId, second.attemptId, "concurrent starts must resume the same unfinished attempt");
  const questions = await mutate(tx => tx`SELECT * FROM note_learning_card_questions WHERE card_id=${cardId} ORDER BY ordinal`);
  for (const row of questions) await api(`/v2/learning-cards/${cardId}/attempts/${first.attemptId}/answers`, { questionId: row.id,
    answer: skips ? { skipped: true } : partial && row.question_type === "multi_choice" ? { optionIds: ["0", "1", "2"] } : submitted(row) });
  await api(`/v2/learning-cards/${cardId}/attempts/${first.attemptId}/complete`, {});
  const result = await wait(async () => { const history = await api(`/v2/learning-cards/${cardId}/attempts`); const attempt = history.items.find((item: any) => item.attemptId === first.attemptId); if (attempt?.status === "grading_failed") throw new Error("real grading failed"); return attempt?.status === "completed" ? attempt : null; }, "grading");
  records.push({ kind: "attempt", cardId, skips, result }); persist(); return result;
}
try {
  let healthy = 0;
  await wait(async () => {
    try { healthy = (await fetch("http://127.0.0.1:4000/ready")).ok ? healthy + 1 : 0; } catch { healthy = 0; }
    return healthy >= 3 ? true : null;
  }, "development-service readiness");
  await mutate(async tx => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`plan57-audit-${userId}@test.invalid`},'synthetic-no-login','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id,workspace_type) VALUES(${workspaceId},'Plan 57 audit',${userId},'personal')`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`UPDATE users SET personal_workspace_id=${workspaceId} WHERE id=${userId}`;
    await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy) VALUES(${userId},'ai-consent-v1',now(),${tx.json({sendToExternal:true,sendImageContent:false,piiDetection:false,auditLogging:true})})`;
    await tx`INSERT INTO sessions(token,user_id,workspace_id,client_kind,expires_at) VALUES(${createHash('sha256').update(token).digest('hex')},${userId},${workspaceId},'desktop',now()+interval '2 hours')`;
  });
  const note = await newNote("Plan 57 real generation"); const started = Date.now();
  const generation = await api(`/v2/notes/${note.noteId}/learning-card/generate`, { noteVersionId: note.versionId, options: { questionCount: 6 } });
  const generated = await wait(async () => {
    const card = await api(`/v2/notes/${note.noteId}/learning-card`); if (card.card) return card.card;
    const [job] = await mutate(tx => tx`SELECT status,last_error FROM jobs WHERE id=${generation.jobId}`);
    if (job.status === 'dead') throw new Error(`generation failed: ${job.last_error}`); return null;
  }, "generation");
  // Plan 57: a question that fails validation is discarded instead of failing the
  // whole card, so a successful generation may be a smaller (>=4) card.
  assert.ok(generated.questions.length >= 4 && generated.questions.length <= 6, `got ${generated.questions.length}`);
  assert.ok(Number(generated.omittedQuestionCount ?? 0) >= 0);
  records.push({ kind: "real-model-generation", elapsedMs: Date.now()-started, card: generated }); persist(); console.log(`Generated ${generated.questions.length} grounded questions in ${Date.now()-started}ms`);
  await practice(generated.cardId);
  // A clearly authored fixture checks both trusted templates and an all-objective card.
  const fixture = await newNote("Plan 57 controlled operation fixture"), cardId = randomUUID();
  const parameter = operationSpecV1Schema.parse({ title: "参数实验", prompt: "将电压调至6V、电阻调至3Ω。", controls: [{id:"u",label:"电压",min:0,max:12,step:1,initial:0},{id:"r",label:"电阻",min:1,max:10,step:1,initial:1}],target:{u:6,r:3} });
  const repair = operationSpecV1Schema.parse({ title: "连接步骤", prompt: "按正确顺序选择实验步骤。", controls: [], target: {}, steps: ["断开电源","连接电路","核对连接","接通电源"] });
  const fixed = [
    { type:"single_choice", stem:"电流是多少？", options:["2A","1A"], answer:{correctOptionId:"0"} },
    { type:"multi_choice", stem:"哪些量的单位正确？", options:["伏特V","欧姆Ω","电流W","电压A"], answer:{correctOptionIds:["0","1"]} },
    { type:"true_false", stem:"电压是否为6V？", options:null, answer:{correct:true} },
    { type:"fill_blank", stem:"电阻是多少？", options:null, answer:{blanks:[["3Ω"]]} },
    { type:"ordering", stem:"如何按实验顺序排列？", options:["断开电源","连接电路","接通电源"], answer:{order:["0","1","2"]} },
    { type:"matching", stem:"哪些物理量和单位对应？", options:["电压","电流"], answer:{pairs:{"0":"V","1":"A"},rightOptions:["A","V"]} },
    { type:"operation", stem:"调整电压和电阻到目标值。", options:null, answer:parameter },
    { type:"operation", stem:"选择实验的正确步骤顺序。", options:null, answer:repair },
  ];
  await mutate(async tx => {
    await tx`INSERT INTO note_learning_cards(id,workspace_id,note_id,note_version_id) VALUES(${cardId},${workspaceId},${fixture.noteId},${fixture.versionId})`;
    for (const [ordinal,q] of fixed.entries()) {
      let artifactId: string | null=null;
      if(q.type==='operation') { artifactId=randomUUID(); const template=ordinal===6?'parameter_experiment':'repair_steps'; await tx`INSERT INTO note_learning_card_operation_artifacts(id,workspace_id,card_id,question_ordinal,template,spec,html) VALUES(${artifactId},${workspaceId},${cardId},${ordinal},${template},${tx.json(q.answer)},${renderOperationTemplateV1(template,ordinal===6?parameter:repair)})`; }
      await tx`INSERT INTO note_learning_card_questions(card_id,ordinal,question_type,stem,options,answer,grounding,operation_artifact_id) VALUES(${cardId},${ordinal},${q.type},${q.stem},${q.options?tx.json(q.options):null},${tx.json(q.answer)},${tx.json({note:[{blockOrdinal:0,quote:text}]})},${artifactId})`;
    }
  });
  const completed = await practice(cardId,false,true); assert.equal(completed.score,94); assert.ok(completed.summary?.text);
  const zero = await practice(cardId,true); assert.equal(zero.score,0); assert.equal(zero.stars,0);
  const card = (await api(`/v2/notes/${fixture.noteId}/learning-card`)).card; assert.equal(card.bestScore,94); assert.equal(card.completedAttemptCount,2);
  await mutate(tx => tx`UPDATE note_learning_card_attempts SET summary=NULL WHERE id=${zero.attemptId}`);
  await api(`/v2/learning-cards/${cardId}/attempts/${zero.attemptId}/complete`,{summaryOnly:true});
  const retried = await wait(async()=>{ const item=(await api(`/v2/learning-cards/${cardId}/attempts`)).items.find((a:any)=>a.attemptId===zero.attemptId); return item.summary?.text?item:null; },"summary-only retry"); assert.equal(retried.score,0);
  const state=await api(`/v2/notes/${fixture.noteId}/doc-state`);
  const yjsUrl=new URL("../../../../apps/api/node_modules/yjs/dist/yjs.mjs",import.meta.url).href;
  const Y=await import(yjsUrl), doc=new Y.Doc(); Y.applyUpdate(doc,Buffer.from(state.update,"base64")); const vector=Y.encodeStateVector(doc);
  editFragmentBlockText(doc,0,text+" 新版补充：测量时先核对仪表量程。");
  await api(`/v2/notes/${fixture.noteId}/doc-update`,{update:Buffer.from(Y.encodeStateAsUpdate(doc,vector)).toString("base64")}); doc.destroy();
  const saved=await api(`/v2/notes/${fixture.noteId}`,{version:1,baseVersionId:fixture.versionId},"PATCH"); assert.notEqual(saved.versionId,fixture.versionId);
  await api(`/v2/notes/${fixture.noteId}/learning-card/generate`,{noteVersionId:saved.versionId,options:{questionCount:4}});
  const historical=await api(`/v2/notes/${fixture.noteId}/learning-card?cardId=${cardId}`); assert.equal(historical.card.bestScore,94); assert.equal(historical.card.noteVersionId,fixture.versionId);
  records.push({kind:"fixed-fixture-validation",score:completed.score,zero:zero.score,best:card.bestScore,summaryRetryScore:retried.score,historicalVersionReadable:true});persist();
  console.log("Passed real grading, both operation templates, 0-star completion, best-score retention, summary-only retry, and historical-version read.");
} catch(error) { records.push({kind:"failure",message:String(error)});persist();throw error; }
finally { await mutate(async tx=>{await tx`DELETE FROM sessions WHERE user_id=${userId}`;}); disabled=true;persist();await db.end();console.log(`Evidence: ${output.pathname}`); }
