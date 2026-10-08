/** Real HTTP/queue/model/search probe. Expected decisions never enter model inputs. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

if (process.env.LIVE_SEARCH_DISCRETION !== "1") throw new Error("Explicit live-search test switch required");
const suffix = process.argv[2];
if (!suffix || !/^[a-z0-9-]{1,60}$/.test(suffix)) throw new Error("Unique evidence suffix required");
const api = process.env.SEARCH_PROBE_API ?? "http://127.0.0.1:4000";
const database = process.env.SEARCH_PROBE_DATABASE ?? "postgres://astella:astella_dev@127.0.0.1:5432/astella";
if (!["localhost", "127.0.0.1"].includes(new URL(api).hostname) || !["localhost", "127.0.0.1"].includes(new URL(database).hostname))
  throw new Error("This synthetic fixture probe is restricted to the local development stack");
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const directory = `${root}outputs/audits/2026-10-08-search-discretion/${suffix}`;
if (existsSync(directory)) throw new Error("Evidence cannot be overwritten");
mkdirSync(directory, { recursive: true });
const admin = postgres(database, { max: 3 });
type Case = { id: string; text: string; needsSearch: boolean; basis: string; after?: string };
const cases: Case[] = [
  { id: "comfort", text: "今天有点累，陪我说一句就好。", needsSearch: false, basis: "日常情绪交流" },
  { id: "weather", text: "北京今天下午会下雨吗？我出门要不要带伞？", needsSearch: true, basis: "当日天气随时间变化" },
  { id: "binary-search", text: "什么是二分查找？用一个简单例子解释一下。", needsSearch: false, basis: "稳定的基础概念" },
  { id: "python-version", text: "Python 现在最新的稳定版本是多少？", needsSearch: true, basis: "当前版本不能由旧知识保证" },
  { id: "poem", text: "把‘今天有点冷，我想早点回家’写成两句小诗。", needsSearch: false, basis: "今天出现在给定创作材料中" },
  { id: "palace", text: "故宫现在周一开放吗？这周去的话几点停止入场？", needsSearch: true, basis: "开放与入馆规则需要现行来源" },
  { id: "dinner", text: "我晚饭在炒饭和面条之间纠结，你偏哪一个？", needsSearch: false, basis: "主观口味交流" },
  { id: "node-lts", text: "Node.js 最新的 LTS 主版本是哪一个？", needsSearch: true, basis: "当前软件发布信息" },
  { id: "cooling", text: "为什么热水会慢慢变凉？", needsSearch: false, basis: "稳定的物理常识" },
  { id: "nobel", text: "今年诺贝尔物理学奖公布了吗？获奖者是谁？", needsSearch: true, basis: "本年度刚发生或尚未发生的事件" },
  { id: "birthday", text: "帮我想一句祝朋友生日快乐的话，轻松一点。", needsSearch: false, basis: "按要求直接写文案" },
  { id: "chrome", text: "Chrome 现在最新的稳定版版本号是多少？", needsSearch: true, basis: "实时软件版本" },
  { id: "water", text: "水的化学式是什么？", needsSearch: false, basis: "稳定且简单的事实" },
  { id: "deepseek-api", text: "DeepSeek API 里的 deepseek-chat 和 deepseek-reasoner 对应哪些型号？", needsSearch: true, basis: "当前产品映射，未出现时间或查询动作词" },
  { id: "rewrite", text: "把‘会议挪到下午三点’换成更礼貌的一句话。", needsSearch: false, basis: "用户已提供全部改写材料" },
  { id: "museum", text: "上海博物馆今天要预约才能进去吗？", needsSearch: true, basis: "现行预约规则" },
  { id: "weather-to-thanks", after: "weather", text: "嗯，知道了，谢谢你。", needsSearch: false, basis: "查过后普通收尾，不继承旧查询" },
  { id: "version-to-poem", after: "python-version", text: "有数了。给我写两句春天的小诗。", needsSearch: false, basis: "从查资料换到直接创作" },
  { id: "concept-to-current", after: "binary-search", text: "这段先放放，Chrome 现在的稳定版是多少？", needsSearch: true, basis: "从稳定概念换到现行事实" },
  { id: "poem-to-weather", after: "poem", text: "北京今天下午会下雨吗？", needsSearch: true, basis: "从给定天气诗句换到实际天气" },
];
const regressionCases: Case[] = [
  { id: "agent-patterns", text: "讲讲目前agent都有哪些种类，例如agent loop、链式这种东西。", needsSearch: false, basis: "基本架构概念" },
  { id: "agent-patterns-latest", after: "agent-patterns", text: "还有吧，看看最新的", needsSearch: true, basis: "真实报错场景的自然追问，要求现行进展" },
];
const allCases = [...cases, ...regressionCases];
const selectedIds = process.env.SEARCH_PROBE_CASES?.split(",").filter(Boolean);
const selected = selectedIds ? allCases.filter(c => selectedIds.includes(c.id) || allCases.some(f => selectedIds.includes(f.id) && f.after === c.id)) : cases;
if (selectedIds?.some(id => !allCases.some(c => c.id === id))) throw new Error("Unknown test case");
writeFileSync(`${directory}/manifest.json`, JSON.stringify({ startedAt: new Date().toISOString(), cases: selected,
  scope: "Real API, queue, production classifier and agent, configured model and BigModel search. Fresh synthetic user/workspace per cold case; follow-ups reuse only the named case's actual replies. Only case.text enters the turn request. No forced intent, tool choice, evaluator or expected decision.",
  modelOverride: false, parallelConversations: 2 }, null, 2), { flag: "wx" });

type Fixture = { userId: string; workspaceId: string; token: string; conversationId: string };
type ToolRow = { name: string; status: string; arguments: unknown; summary: string | null; result: unknown };
type Evidence = { id: string; text: string; needsSearch: boolean; basis: string; after?: string;
  runId?: string; status?: string; provider?: string | null; model?: string | null; interpretation?: unknown;
  tools?: ToolRow[]; answer?: string; sourceCount?: number; elapsedMs?: number; error?: string;
  decision?: "correct" | "unnecessary_search" | "missed_search" | "unassessed" };
const fixtures = new Map<string, Fixture>();
const rows: Evidence[] = [];
const save = () => writeFileSync(`${directory}/results.json`, JSON.stringify(rows, null, 2));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function post(path: string, body: unknown, token: string, idempotency?: string) {
  const response = await fetch(`${api}${path}`, { method: "POST", headers: {
    "Content-Type": "application/json", Authorization: `Bearer ${token}`,
    ...(idempotency ? { "Idempotency-Key": idempotency } : {}),
  }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const value = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${String(value.code ?? value.error ?? "request_failed")}`);
  return value;
}
async function seed(id: string): Promise<Fixture> {
  const userId = randomUUID(), workspaceId = randomUUID(), token = randomBytes(24).toString("hex");
  await admin.begin(async tx => {
    await tx`INSERT INTO users (id,email,password_hash,role) VALUES (${userId},${`search-probe-${userId}@example.test`},'synthetic-no-login','owner')`;
    await tx`INSERT INTO workspaces (id,name,owner_id,workspace_type) VALUES (${workspaceId},${`搜索决策测试 ${id}`},${userId},'personal')`;
    await tx`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (${workspaceId},${userId},'owner')`;
    await tx`INSERT INTO user_ai_settings (user_id,consent_version,consent_at,data_policy) VALUES
      (${userId},'ai-consent-v1',now(),${tx.json({ sendToExternal: true, sendImageContent: false, piiDetection: true, auditLogging: true })})`;
    await tx`INSERT INTO user_companion_account_state (user_id,diary_enabled,agent_settings,animation_voice_off) VALUES
      (${userId},false,${tx.json({ version: 1, permissionLevel: "read_only", webSearchEnabled: true })},${tx.json({ voiceOff: true })})`;
    await tx`INSERT INTO sessions (token,user_id,workspace_id,expires_at) VALUES
      (${createHash("sha256").update(token).digest("hex")},${userId},${workspaceId},now()+interval '1 hour')`;
  });
  const inbox = await post("/companion/inbox/ensure", {}, token);
  return { userId, workspaceId, token, conversationId: String(inbox.id) };
}
async function runCase(c: Case) {
  const row: Evidence = { ...c }; rows.push(row); save();
  const started = Date.now();
  try {
    let fixture = c.after ? fixtures.get(c.after) : undefined;
    if (!fixture) { fixture = await seed(c.id); fixtures.set(c.id, fixture); }
    const created = await post(`/companion/conversations/${fixture.conversationId}/turns`, {
      version: 1, clientMessageId: randomUUID(), inputKind: "text", blocks: [{ type: "text", text: c.text }], sourceSurface: "pet",
    }, fixture.token, randomUUID());
    const runId = String(created.runId); row.runId = runId;
    const deadline = Date.now() + 150_000;
    let status = "accepted";
    while (Date.now() < deadline) {
      const [run] = await admin`SELECT status,provider_id,model_id,turn_interpretation,error_code FROM companion_turn_runs WHERE id=${runId}`;
      status = String(run?.status ?? "missing");
      if (!["accepted", "running", "cancel_requested"].includes(status)) {
        Object.assign(row, { status, provider: run.provider_id, model: run.model_id, interpretation: run.turn_interpretation });
        if (run.error_code) row.error = String(run.error_code);
        break;
      }
      await delay(1000);
    }
    row.status ??= status === "running" || status === "accepted" ? "timeout" : status;
    const tools = await admin`SELECT name,status,arguments,result_safe_summary,result_ref FROM companion_agent_tool_calls WHERE run_id=${runId} ORDER BY created_at,id`;
    row.tools = tools.map(tool => {
      let result: unknown = null;
      if (tool.name === "agent_web_search" && typeof tool.result_ref === "string") {
        try { result = JSON.parse(tool.result_ref); } catch { /* No invented receipt. */ }
      }
      return { name: String(tool.name), status: String(tool.status), arguments: tool.arguments,
        summary: tool.result_safe_summary == null ? null : String(tool.result_safe_summary), result };
    });
    const [message] = await admin`SELECT blocks FROM companion_messages WHERE run_id=${runId} AND role='assistant' ORDER BY seq DESC LIMIT 1`;
    const blocks = message?.blocks as Array<{ type: string; text?: string; referenceId?: string }> | undefined;
    row.answer = blocks?.filter(block => block.type === "text").map(block => block.text ?? "").join("\n") ?? "";
    row.sourceCount = blocks?.filter(block => block.type === "citation" && block.referenceId).length ?? 0;
    const searched = row.tools.some(tool => tool.name === "agent_web_search");
    row.decision = row.status !== "succeeded" ? "unassessed" : searched === c.needsSearch ? "correct"
      : searched ? "unnecessary_search" : "missed_search";
  } catch (error) { row.error = error instanceof Error ? error.message : "probe_error"; row.decision = "unassessed"; }
  row.elapsedMs = Date.now() - started; save();
  console.log(JSON.stringify({ id: c.id, expectedSearch: c.needsSearch, decision: row.decision, status: row.status,
    tools: row.tools?.map(t => t.name), elapsedMs: row.elapsedMs, error: row.error }));
}

async function retireFixtures() {
  for (const fixture of fixtures.values()) {
    await admin`UPDATE user_companion_account_state SET global_enabled=false,agent_settings=jsonb_set(agent_settings,'{webSearchEnabled}','false'::jsonb),epoch=epoch+1 WHERE user_id=${fixture.userId}`;
    await admin`DELETE FROM sessions WHERE user_id=${fixture.userId}`;
    // Preserve only scoped synthetic fixtures for result inspection; never touch a real account.
  }
  writeFileSync(`${directory}/fixtures.json`, JSON.stringify([...fixtures].map(([id, f]) => ({ id, userId: f.userId, workspaceId: f.workspaceId, conversationId: f.conversationId })), null, 2));
}
try {
  const cold = selected.filter(c => !c.after);
  let next = 0;
  await Promise.all([0, 1].map(async () => { for (;;) { const c = cold[next++]; if (!c) return; await runCase(c); } }));
  for (const c of selected.filter(c => c.after)) await runCase(c);
} finally { await retireFixtures(); await admin.end({ timeout: 5 }); }
const summary = { total: rows.length, correct: rows.filter(r => r.decision === "correct").length,
  unnecessary: rows.filter(r => r.decision === "unnecessary_search").length, missed: rows.filter(r => r.decision === "missed_search").length,
  unassessed: rows.filter(r => r.decision === "unassessed").length };
writeFileSync(`${directory}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ directory, ...summary }));
