/**
 * 记忆召回质量实测（无向量的真实状态）。
 *
 * 前提是从开发库量出来的：`assistant_memory_embeddings` 0 行、
 * 151 条记忆全部 embedding_status ∈ (pending|none|failed)，
 * 补偿调度器每 30 分钟报错一次（6 小时 4 425 条）。
 * 也就是说线上此刻的召回只有关键词那一条路。
 *
 * 这里按"用了两周的账号"建一份真实分布的语料（用户明说的偏好／目标、
 * 抽取器推断的、维护整理出来的），然后问 12 个自然人会问的 paraphrase，
 * 记录：走的是哪条模式、正确那条排第几、带回来几条无关的。
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { COMPANION_AGENT_TOOL_DEFINITIONS } from "@astella/shared/companion-agent-registry";

const CONN = testDatabaseUrl("DATABASE_URL");
const admin = postgres(CONN, { max: 3 });

const userId = randomUUID();
const workspaceId = randomUUID();
const conversationId = randomUUID();
const prefix = userId.slice(0, 8);

const { closeDatabase: closeWorkerDatabase, withWorkerWorkspaceTransaction } =
  await import("../../../../workers/ai-worker/src/db.ts");
const { executeCompanionMemoryTool } =
  await import("../../../../workers/ai-worker/src/handlers/tools/companion-memory-tools.ts");
const { retrieveCompanionMemoriesKeyword } =
  await import("../../../../workers/ai-worker/src/handlers/memory/companion-memory-vector.ts");
const { assembleCompanionContext } =
  await import("../../../../workers/ai-worker/src/handlers/context/companion-context-orchestrator.ts");

/** 一条长期记忆：两周里陆续攒下来的样子。 */
type Fixture = {
  id: string;
  content: string;
  kind: string;
  importance: number;
  pinned: boolean;
  userConfirmed: boolean;
  author: string;
  epistemic: string;
  tier: string;
  /** 这条是不是某个问题的正确答案。 */
  answers?: string[];
};

const FIXTURES: Fixture[] = [
  { id: "m-cat", content: "我的猫叫 Momo，周四要带去复查，结果出来要第一时间说。", kind: "episodic", importance: 0.6, pinned: false, userConfirmed: true, author: "user", epistemic: "supported", tier: "active", answers: ["cat"] },
  { id: "m-n2", content: "我现在准备在 7 月参加 JLPT N2 考试。", kind: "goal", importance: 0.7, pinned: false, userConfirmed: true, author: "user", epistemic: "supported", tier: "active", answers: ["exam"] },
  { id: "m-jazz", content: "我在准备爵士钢琴的 transcribe，每天只练二十分钟。", kind: "goal", importance: 0.6, pinned: false, userConfirmed: true, author: "user", epistemic: "supported", tier: "active", answers: ["jazz"] },
  { id: "m-conclusion", content: "学习日语时先给结论，再举例；工作日晚上用短轮次。", kind: "preference", importance: 0.7, pinned: true, userConfirmed: true, author: "user", epistemic: "supported", tier: "resident", answers: ["style"] },
  { id: "m-dialect", content: "此后每句都用河南话风格回复。", kind: "preference", importance: 0.8, pinned: true, userConfirmed: true, author: "user", epistemic: "supported", tier: "resident", answers: ["dialect"] },
  { id: "m-kid", content: "孩子明年上小学，晚上八点后不要提学习的事。", kind: "preference", importance: 0.6, pinned: false, userConfirmed: true, author: "user", epistemic: "supported", tier: "active", answers: ["evening"] },
  { id: "m-chem", content: "有机化学要重点突破取代反应和消除反应。", kind: "learning_context", importance: 0.5, pinned: false, userConfirmed: false, author: "extractor", epistemic: "tentative", tier: "active", answers: ["chem"] },
  { id: "m-library", content: "习惯在图书馆三楼复习，周末不去。", kind: "episodic", importance: 0.4, pinned: false, userConfirmed: false, author: "extractor", epistemic: "tentative", tier: "active", answers: ["where"] },
  // 以下是噪声：内容里高频复现「学习／复习／笔记／时间」这类通用词。
  { id: "n-1", content: "用户提到在做学习笔记，希望把复习安排得更清楚。", kind: "learning_context", importance: 0.9, pinned: true, userConfirmed: true, author: "maintenance", epistemic: "supported", tier: "resident" },
  { id: "n-2", content: "最近在学时间管理，想把每天的时间排开。", kind: "learning_context", importance: 0.85, pinned: true, userConfirmed: true, author: "maintenance", epistemic: "supported", tier: "resident" },
  { id: "n-3", content: "用户偏好先看整体结构，再逐节展开学习材料。", kind: "preference", importance: 0.8, pinned: false, userConfirmed: true, author: "extractor", epistemic: "supported", tier: "resident" },
  { id: "n-4", content: "学习时喜欢边记笔记边复述，笔记写在同一个空间里。", kind: "preference", importance: 0.75, pinned: false, userConfirmed: false, author: "extractor", epistemic: "tentative", tier: "active" },
  { id: "n-5", content: "复习节奏最近改成两天一次，每次不超过半小时。", kind: "learning_context", importance: 0.72, pinned: false, userConfirmed: false, author: "extractor", epistemic: "tentative", tier: "active" },
  { id: "n-6", content: "用户说早上状态最好，重要的学习内容放在上午。", kind: "preference", importance: 0.7, pinned: false, userConfirmed: false, author: "extractor", epistemic: "tentative", tier: "active" },
  { id: "n-7", content: "笔记里想多放例子，少放术语定义。", kind: "preference", importance: 0.68, pinned: false, userConfirmed: false, author: "extractor", epistemic: "tentative", tier: "active" },
  { id: "n-8", content: "本周学习目标是把第三章的笔记整理完。", kind: "goal", importance: 0.66, pinned: false, userConfirmed: false, author: "extractor", epistemic: "tentative", tier: "active" },
  { id: "n-9", content: "用户提到复习时容易走神，需要更短的任务段。", kind: "learning_context", importance: 0.64, pinned: false, userConfirmed: false, author: "extractor", epistemic: "tentative", tier: "active" },
  { id: "n-10", content: "学习安排尽量围绕一个主题，不要同时开三条。", kind: "preference", importance: 0.62, pinned: false, userConfirmed: false, author: "extractor", epistemic: "tentative", tier: "active" },
  { id: "n-11", content: "用户习惯用语音输入，晚上还是打字。", kind: "preference", importance: 0.6, pinned: false, userConfirmed: false, author: "extractor", epistemic: "tentative", tier: "active" },
  { id: "n-12", content: "笔记生成后要确认是否共享给空间。", kind: "interaction_note", importance: 0.58, pinned: false, userConfirmed: false, author: "extractor", epistemic: "tentative", tier: "active" },
  { id: "n-13", content: "用户说学习时不喜欢被打断，希望一次说完。", kind: "preference", importance: 0.56, pinned: false, userConfirmed: false, author: "extractor", epistemic: "tentative", tier: "active" },
  { id: "n-14", content: "复习卡片最近生成得偏多，用户只挑了三张。", kind: "learning_context", importance: 0.54, pinned: false, userConfirmed: false, author: "extractor", epistemic: "tentative", tier: "active" },
  { id: "n-15", content: "用户希望解释里带上生活里的例子。", kind: "preference", importance: 0.52, pinned: false, userConfirmed: false, author: "extractor", epistemic: "tentative", tier: "active" },
  { id: "n-16", content: "学习空间里放了日语、化学与钢琴三份材料。", kind: "learning_context", importance: 0.5, pinned: false, userConfirmed: false, author: "extractor", epistemic: "tentative", tier: "active" },
  { id: "n-17", content: "用户提到通勤路上会听一点日语。", kind: "episodic", importance: 0.48, pinned: false, userConfirmed: false, author: "extractor", epistemic: "tentative", tier: "active" },
  { id: "n-18", content: "笔记编辑的三次操作记录已完成。", kind: "interaction_note", importance: 0.46, pinned: false, userConfirmed: false, author: "maintenance", epistemic: "supported", tier: "active" },
  { id: "n-19", content: "用户偏好短的回答，不要太长的段落。", kind: "preference", importance: 0.44, pinned: false, userConfirmed: false, author: "extractor", epistemic: "tentative", tier: "active" },
  { id: "n-20", content: "学习进度按周记录，方便回头对照。", kind: "learning_context", importance: 0.42, pinned: false, userConfirmed: false, author: "extractor", epistemic: "tentative", tier: "active" },
];

/**
 * 12 个自然人会问的问题，按**词法上答不答得了**分两组：
 * - `lexical`：问句与那条记忆共享至少一个子串（bigram），关键词那一路本该能找到；
 * - `semantic`：只有理解才连得上（"乐器"↔"爵士钢琴"、"语气"↔"河南话风格"）。
 *   这一组是向量的活，用关键词判它输赢是冤枉人——真实数字照样打出来，
 *   判据交给跑真模型的折叠／向量探针（live-tests）。
 */
const QUESTIONS: { key: string; query: string; target: string; needs: "lexical" | "semantic" }[] = [
  { key: "exam", query: "我今年备考的那个考试是什么时候来着", target: "m-n2", needs: "lexical" },
  { key: "style", query: "我说过学日语希望怎么讲？", target: "m-conclusion", needs: "lexical" },
  { key: "evening", query: "晚上几点以后别跟我提孩子学习的事", target: "m-kid", needs: "lexical" },
  { key: "chem", query: "我有机化学要突破的是哪两块", target: "m-chem", needs: "lexical" },
  { key: "where", query: "我平时在哪儿复习", target: "m-library", needs: "lexical" },
  { key: "x1", query: "上次说的猫复查后来怎么样了", target: "m-cat", needs: "lexical" },
  { key: "x2", query: "关于爵士钢琴我定过什么计划", target: "m-jazz", needs: "lexical" },
  { key: "x3", query: "考试日期我改过一次吧，现在算哪个", target: "m-n2", needs: "lexical" },
  { key: "x4", query: "我说过复习时不喜欢什么", target: "n-13", needs: "lexical" },
  { key: "cat", query: "我之前是不是提过我家猫要去看医生？", target: "m-cat", needs: "semantic" },
  { key: "jazz", query: "我最近在练的乐器，一天练多久？", target: "m-jazz", needs: "semantic" },
  { key: "dialect", query: "我要求过你以后用什么语气说话", target: "m-dialect", needs: "semantic" },
];

/** 语料 key → 真实 uuid（id 列是 uuid，不能直接写 "m-cat"）。 */
const memoryIds = new Map<string, string>(FIXTURES.map((item) => [item.id, randomUUID()]));
const keyOf = (memoryId: string): string =>
  [...memoryIds.entries()].find(([, id]) => id === memoryId)?.[0] ?? memoryId.slice(0, 4);

before(async () => {
  await admin`
    INSERT INTO users (id, email, password_hash, role)
    VALUES (${userId}, ${`recall-quality-${prefix}@example.test`}, 'test-hash', 'owner')
  `;
  await admin`
    INSERT INTO workspaces (id, name, owner_id, workspace_type)
    VALUES (${workspaceId}, ${`recall-quality-${prefix}`}, ${userId}, 'collaborative')
  `;
  await admin`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
  await admin`
    INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
    VALUES (${conversationId}, ${workspaceId}, ${userId}, 'inbox', '召回质量实测', 'user', 'active')
  `;
  const created = new Date(Date.now() - 14 * 24 * 3_600_000);
  for (const [index, item] of FIXTURES.entries()) {
    // 两周里陆续写下：updated_at 拉开，越靠后的越新。
    const updatedAt = new Date(created.getTime() + index * 3_600_000);
    await admin`
      INSERT INTO assistant_memory_items
        (id, workspace_id, user_id, kind, content, source_type, author_type, epistemic_status,
         user_stated, user_confirmed, candidate, importance, confidence, pinned, scope,
         embedding_status, budget_tier, created_at, updated_at, confirmed_at)
      VALUES (${memoryIds.get(item.id)!}, ${workspaceId}, ${userId}, ${item.kind}, ${item.content},
        ${item.author === "user" ? "user_stated" : "model_inferred"}, ${item.author}, ${item.epistemic},
        ${item.userConfirmed}, ${item.userConfirmed}, false, ${item.importance}, 0.6, ${item.pinned},
        'workspace', 'pending', ${item.tier}, ${updatedAt}, ${updatedAt},
        ${item.userConfirmed ? updatedAt : null})
    `;
  }
});

after(async () => {
  await admin`DELETE FROM memory_usage_log WHERE user_id = ${userId}`;
  await admin`DELETE FROM assistant_memory_item_revisions WHERE user_id = ${userId}`;
  await admin`DELETE FROM assistant_memory_items WHERE user_id = ${userId}`;
  await admin`DELETE FROM companion_conversations WHERE id = ${conversationId}`;
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await admin`DELETE FROM users WHERE id = ${userId}`;
  await admin.end({ timeout: 5 }).catch(() => {});
  await closeWorkerDatabase().catch(() => {});
});

/** 走真实工具入口：模型在运行时调的就是这条。无外发授权 → 查询向量为空。 */
async function recallViaTool(query: string, limit = 8) {
  const definition = COMPANION_AGENT_TOOL_DEFINITIONS.find((item) => item.name === "companion_memory_read");
  assert.ok(definition);
  const controller = new AbortController();
  const event = {
    ctx: { id: randomUUID(), workspaceId, requestedBy: userId, leaseToken: "recall-test", signal: controller.signal },
    read: {
      runId: randomUUID(), conversationId, userId, userMessageId: null, generation: 1, pageContext: null,
      memoryRefs: [], residentMemories: [],
    },
    constraints: {},
  } as never;
  const result = await executeCompanionMemoryTool(event, definition, { query, limit });
  return result.value as { memories: Array<{ memoryId: string; content: string }>; retrievalMode: string };
}

test("两周语料 + 12 个自然提问：量出关键词召回的命中率与排序", async () => {
  // 常驻档（resident）的记忆**不进按需检索**：它们该当场就在 prompt 里（另一条测试量那一半）。
  // 所以这里的判据是产品真正承诺的那句话：**要么当场看得见，要么一查能查到**。
  const runId = randomUUID();
  const context = await withWorkerWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    assembleCompanionContext(tx, { workspaceId, userId }, { runId, pageContext: null, playbooksDisabled: true }));
  const residentSet = new Set((context.residentMemoryIds ?? []).map(String));

  const rows: string[] = [];
  const stat = { lexical: { top1: 0, hit: 0, n: 0 }, semantic: { top1: 0, hit: 0, n: 0 } };
  let modeSeen = "";

  for (const question of QUESTIONS) {
    const result = await recallViaTool(question.query);
    modeSeen = result.retrievalMode;
    const targetId = memoryIds.get(question.target)!;
    const rank = result.memories.findIndex((memory) => memory.memoryId === targetId) + 1;
    const resident = residentSet.has(targetId);
    const bucket = stat[question.needs];
    bucket.n += 1;
    if (rank === 1 || (resident && rank === 0)) bucket.top1 += 1;
    if (rank > 0 || resident) bucket.hit += 1;
    rows.push(`${question.needs === "lexical" ? "词法" : "语义"} ${question.key.padEnd(7)}`
      + ` | rank=${rank === 0 ? (resident ? "常驻已注入" : "未命中") : rank}`
      + ` | 带回 ${result.memories.length} 条 | ${result.memories.slice(0, 3).map((memory) => keyOf(memory.memoryId)).join(",")}`);
  }

  console.log(`\n=== 关键词召回实测（模式=${modeSeen}，语料 ${FIXTURES.length} 条，提问 ${QUESTIONS.length} 个）===`);
  for (const row of rows) console.log(row);
  console.log(`词法可答的 ${stat.lexical.n} 条：top-1 ${stat.lexical.top1}，top-8 ${stat.lexical.hit}`);
  console.log(`只有理解才连得上的 ${stat.semantic.n} 条：top-1 ${stat.semantic.top1}，top-8 ${stat.semantic.hit}（关键词本不该赢这一组，向量的账在 live 探针里算）`);

  // 关键词这一路的底线：**问句里出现过的字，就该把那条找回来**。
  // 找不到就不是"语义不够"，是词元根本没生成或排序把它压到 8 名之外。
  assert.equal(stat.lexical.hit, stat.lexical.n,
    `词法上答得了的问题只找回 ${stat.lexical.hit}/${stat.lexical.n}——子串都对得上还捞不到，这条兜底路是坏的`);
  assert.ok(stat.lexical.top1 >= Math.ceil(stat.lexical.n * 0.75),
    `top-1 只有 ${stat.lexical.top1}/${stat.lexical.n}：找回来却排在无关的后面，她照前面的说就是"记错了"`);
});

test("找回来的顺序按相关度排：正主不许压在噪声下面", async () => {
  const a = await withWorkerWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    retrieveCompanionMemoriesKeyword(tx, { workspaceId, userId }, "我之前是不是提过我家猫要去看医生？", 8, null));
  const b = await withWorkerWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    retrieveCompanionMemoriesKeyword(tx, { workspaceId, userId }, "我有机化学要突破的是哪两块", 8, null));
  const orderA = a.items.map((item) => keyOf(item.memoryId)).join(",");
  const orderB = b.items.map((item) => keyOf(item.memoryId)).join(",");
  console.log(`\n=== 同一个池子，两条不同的问题 ===\n猫复查 → ${orderA}\n有机化学 → ${orderB}`);

  // 旧排序只看 pinned/importance/updated_at：查询词元只用来**筛**、不用来**排**。
  // 结果"有机化学要突破哪两块"把沾了一个"化学"的噪声 n-16 排在正主 m-chem 前面，
  // 她照着最前面那条说，用户读到的就是"记错了"。
  assert.ok(orderB.indexOf("m-chem") < orderB.indexOf("n-16") || !orderB.includes("n-16"),
    `有机化学那条问出来的顺序仍然是噪声在前：${orderB}`);
  assert.notEqual(orderA, orderB, "两条不同问题返回同一批记忆、同一顺序：匹配度没进排序");
});

test("resident 只有 6 条名额：把她的长期偏好挤出去的是最近写入的那条", async () => {
  const runId = randomUUID();
  const context = await withWorkerWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    assembleCompanionContext(tx, { workspaceId, userId }, { runId, pageContext: null, playbooksDisabled: true }));
  const resident = (context.residentMemoryIds ?? []).map((id) => keyOf(String(id)));
  console.log(`\n=== 常驻记忆 ===\nresident 带入 ${resident.length} 条：${resident.join(",")}（resident 名额上限外的 ${context.residentOmittedCount ?? 0} 条省略）`);
  console.log(`目录 ${context.memoryDirectory.length} 条：${context.memoryDirectory.slice(0, 4).map((entry) => JSON.stringify(entry).slice(0, 70)).join(" | ")}`);

  // 她明说的两条（先结论／河南话）都标了 resident 档，看是否真在常驻里。
  assert.ok(resident.includes("m-conclusion") && resident.includes("m-dialect"),
    `两条用户明确说过、且落在 resident 档的偏好都没进常驻：实际带入 ${resident.join(",")}`);
});
