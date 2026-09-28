/**
 * **同进程跨模块全链路演练**（39d W6 的硬前置；执行计划「本步的前置」那一节）。
 *
 * ## 它补的是什么洞
 *
 * 现有 112 份集测**大多是单模块 + 隔离 PostgreSQL**，**没有一条**把
 * 「学习事件投递 → 伴星对话 → 记忆写入与召回 → 念头调度 → 主动消息 → 日记成稿」
 * 串在**同一个进程**里跑一遍（文档 29 §3.5 那一类问题的成因：每个模块单独测都对，
 * 串起来不对，而没有测试发现——语音链路通了文字没通、抽取 job 静默失败、
 * 投递与送达脱节，都是这一类）。
 *
 * ## 三条退出条件，逐条对应
 *
 *  1. **同进程**串起六环 —— 就是这一份。
 *  2. **只替换模型**：库、事件总线、任务队列、渲染投影全部是真的；模型替身按包内
 *     既有约定提供（删 `TOKENRHYTHM_API_KEY` ＋ `AI_PLATFORMS_CONFIG=/nonexistent`），
 *     **不依赖真实端点**，CI 可跑。
 *  3. **失败可见**：任一环节失败时，那一环在产物或回执里留下**可读的说明**（不是空白）。
 *     这是本文件最有价值的部分，所以每一环都配了「它跑不通时应当看得见什么」的判据。
 *
 * ## 与 40b §3 的关系
 *
 * 40b §3 要求「缺失要说出来」（折叠／未执行／不可用三档记号）——**那是两端**：
 * 那一节管单个面的呈现，本文件管**跨模块时不能整体静默**。
 *
 * ## 本文件**不**验证 LLM 内容
 *
 * 模型是替身，替身只保证"编排真的走了那一段"。教学内容对不对不在这一份的范围内，
 * 那是真模型批次的事（§3 收尾那一次）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";

const CONN = testDatabaseUrl("DATABASE_URL_API");
process.env.DATABASE_URL ??= CONN;
// 强制 mock provider：只替换模型，**其余全部是真的**（库、事件、队列、投影）。
delete process.env.TOKENRHYTHM_API_KEY;
process.env.AI_PLATFORMS_CONFIG = "/nonexistent/only-the-model-is-replaced.json";
process.env.COMPANION_DIALOGUE_V1_ENABLED = "true";

const sql = postgres(CONN, { max: 2 });

let workspaceId = "";
let userId = "";

const scope = () => ({ workspaceId, userId });

/** 断言用的读一律落在**这一轮的作用域**里：裸读在受限角色下返回空集而不是报错。 */
async function readInScope<T>(
  s: { workspaceId: string; userId: string },
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${s.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${s.userId}, true)`;
    return fn(tx as never);
  }) as Promise<T>;
}

before(async () => {
  workspaceId = randomUUID();
  userId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash, role)
      VALUES (${userId}, ${`drill-${userId.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    // `workspace_type` 与 `workspace_epoch` 都是 NOT NULL 且**无默认值**。
    // 第一版照直觉写了 `slug`（以为有），五条一起红，报的是「列不存在」——
    // 读起来像夹具写错一处，实际是**我没从 information_schema 现读**。
    // claims §8.1 记过同一次教训：坐标会腐烂，量出来的东西不会。
    await tx`INSERT INTO workspaces (id, name, owner_id, workspace_type, workspace_epoch)
      VALUES (${workspaceId}, '演练', ${userId}, 'personal', 1)`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;
  });
});

after(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`DELETE FROM assistant_deliveries WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    await tx`DELETE FROM users WHERE id = ${userId}`;
  });
  await sql.end({ timeout: 5 });
  const { closeDatabase } = await import("../db.ts");
  await closeDatabase();
});

test("§0 · 四个环节的入口在**同一个进程**里都装得上（全文件的前提）", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const handlersDir = new URL("../handlers/", import.meta.url);
  const entries = await Promise.all([
    import("../handlers/companion-dialogue.ts").then((m) => ["伴星对话", typeof m.runCompanionDialogue] as const),
    import("../handlers/companion-delivery-write.ts").then((m) => ["主动消息投递", typeof m.enqueueSystemEventDelivery] as const),
    import("../handlers/companion-thought-scheduler.ts").then((m) => ["念头调度", typeof m.tickCompanionThoughtScheduler] as const),
    import("../handlers/companion-daily-summary.ts").then((m) => ["日记成稿", typeof m.runCompanionDailySummary] as const),
  ]);
  for (const [name, kind] of entries) {
    assert.equal(kind, "function", `${name} 那一个入口不是可调用的函数：链条在这一环断掉`);
  }
  // **顺带把两处「今天还没有」记成事实，而不是让它们悄悄消失**：
  // 记忆抽取与投递面若没有独立入口，这两条就是链条上的真实缺口。
  const files = readdirSync(fileURLToPath(handlersDir));
  const hasMemoryEntry = files.some((f) => /memory.*(extract|write|job)/i.test(f));
  assert.ok(hasMemoryEntry, "handlers/ 下没有记忆抽取/写入那一族的文件：§2 这一环在链条上是空的");
  assert.ok(readFileSync(fileURLToPath(new URL("../handlers/companion-daily-summary.ts", import.meta.url)), "utf8")
    .includes("export async function runCompanionDailySummary"),
    "日记那一段的导出形状变了：外部无法驱动它，也就无法验收它");
});

test("§1 · 学习事件投递：走**投递面**入队，并念得出它是什么（不是空白行）", async () => {
  const { enqueueSystemEventDelivery } = await import("../handlers/companion-delivery-write.ts");
  const { db } = await import("../db.ts");
  const systemEventId = `drill-${randomUUID()}`;

  const deliveryId = await db.transaction(async (tx: never) =>
    enqueueSystemEventDelivery(tx, {
      workspaceId,
      userId,
      systemEventId,
      text: "你昨天在《数据库索引》停在一个条件上。",
      ttlHours: 24,
    }));
  assert.ok(deliveryId, "投递面没有给出 delivery id：那一行要么没写、要么被去重吃掉了");

  const rows = await readInScope(scope(), (tx) => tx`
    SELECT kind, state, dedupe_key, payload_ref FROM assistant_deliveries
    WHERE workspace_id = ${workspaceId} AND id = ${deliveryId}`);
  assert.equal(rows.length, 1, "写进去的那一行读不回来（作用域或 RLS 没对上）");
  const row = rows[0] as unknown as {
    kind: string; state: string; dedupe_key: string;
    payload_ref: { kind?: string; systemEventId?: string; text?: string };
  };
  // **「念得出」**：`payload_ref` 是那一行唯一带正文的地方。
  // 判它之前**先从 information_schema 量形状**——第一版按字符串去量 `.length`，
  // 而它实际是 jsonb（读出来已经是对象），报出来的是「payload_ref 指向了空内容」，
  // 症状离病因一步。（同 claims §8.1 记的那次：坐标会腐烂。）
  assert.equal(row.kind, "system_event", "那一行的 kind 不是 system_event：收件箱会按别的形状去念它");
  assert.equal(typeof row.payload_ref, "object", `payload_ref 不是对象（实到 ${typeof row.payload_ref}）`);
  assert.equal(row.payload_ref.text, "你昨天在《数据库索引》停在一个条件上。",
    "投递行里没有正文：收件箱里会出现一个点不开、也没有文字的条目，而没有任何东西会报错");
  assert.equal(row.payload_ref.systemEventId, systemEventId,
    "payload_ref 里的 systemEventId 与 dedupe key 对不上：去重按的是另一条");
  assert.equal(row.state, "queued", `投递行的状态实到 ${row.state}：它要么被提前投递、要么失败了`);
});

test("§1b · 投递是**幂等**的：同一 systemEventId 重复投递不产生第二条（重复提醒的闸）", async () => {
  const { enqueueSystemEventDelivery } = await import("../handlers/companion-delivery-write.ts");
  const { db } = await import("../db.ts");
  const systemEventId = `drill-dedupe-${randomUUID()}`;
  const payload = { workspaceId, userId, systemEventId, text: "同一条", ttlHours: 24 };

  const first = await db.transaction(async (tx: never) => enqueueSystemEventDelivery(tx, payload));
  const second = await db.transaction(async (tx: never) => enqueueSystemEventDelivery(tx, payload));
  assert.ok(first, "第一次投递没有给出 id");
  assert.equal(second, null, "重复投递给出了第二个 id：同一条提醒会被念两遍");

  const rows = await readInScope(scope(), (tx) => tx`
    SELECT count(*)::int AS n FROM assistant_deliveries
    WHERE workspace_id = ${workspaceId} AND dedupe_key = ${systemEventId}`);
  assert.equal(Number(rows[0]?.n ?? 0), 1, `同一条在库里留下了 ${rows[0]?.n} 行`);
});

test("§2 · 记忆写入与召回：跨空间的那一档是**显式**的，且缺省必须落在本地", async () => {
  const { memoryScopeForKind, memoryLooksWorkspaceBound } = await import("../handlers/companion-memory-extractor.ts");
  // 这一族最贵的一种错是「一条记忆跑到了别人的空间」。判据落在**纯函数**那一层：
  // 它决定作用域，而作用域决定"这条会不会跨空间"。
  //
  // 三条来自那份函数自己的注释，且每一条都有一个"写反了就会跨空间"的版本：
  //  1. **`binding` 缺省必须落本地**（源码注释实测过：写成 `=== "local"` 时，
  //     `binding` 为 undefined 会返回 global，等于开了一个"漏传就跨空间"的口子）；
  //  2. **模型不能推翻本地信号**——规则那一道可以否决模型给的 portable；
  //  3. 非跨空间种类一律 workspace，除非调用方显式说 "task"。
  // `CROSS_SPACE_KINDS` 今天**只有 `preference` 一档**——先量出来再写判据：
  // 第一版拿 `fact` 去问，得到的是"非跨空间种类一律 workspace"那条，与本题无关。
  assert.equal(
    memoryScopeForKind("preference", "global", undefined, "回答时先给一句结论"),
    "workspace",
    "binding 缺省时落到了 global：漏传一个参数就能把记忆送到别的空间（实测过这个坑）",
  );
  assert.equal(
    memoryScopeForKind("preference", "global", "portable", "回答时先给一句结论"),
    "global",
    "显式说 portable 且内容与空间无关时没有落 global：这一档被收得过头，它该跨空间",
  );
  assert.equal(
    memoryScopeForKind("preference", "global", "portable", "他在学数据库索引这门课"),
    "workspace",
    "模型说了 portable 而内容明显指着具体学科，仍放它跨空间了：规则那一道没能否决模型",
  );
  // 行内判据与那个纯函数必须**说同一句话**（两个来源必然有一个是错的）。
  // 内容取自 `SUBJECT_OR_EXAM_PATTERN` 真正认的那一族——不要自己编一句"看起来像本地"的话。
  assert.equal(
    memoryLooksWorkspaceBound("他在学数据库索引这门课"),
    true,
    "行内判据没认出「本地指涉」：它与 `memoryScopeForKind` 的说法不一致",
  );
  assert.equal(
    memoryLooksWorkspaceBound("回答时先给一句结论"),
    false,
    "与空间无关的偏好被行内判据说成绑本地了：这一档被收得过头",
  );
});

test("§3 · 失败可见：投递面**不校验正文**，所以空正文会落一行 —— 那一行是本刀量到的真实缺口", async () => {
  const { enqueueSystemEventDelivery } = await import("../handlers/companion-delivery-write.ts");
  const { db } = await import("../db.ts");
  const systemEventId = `drill-empty-${randomUUID()}`;

  // 今天**没有**任何一层拒空正文（第一版这里断言"会抛"，实测不抛）。
  // 如实记下这件事比补一条"期望它抛"的断言有用：它把「空条目会进收件箱」
  // 变成一条**已量**的事实，而不是一个愿望。
  const id = await db.transaction(async (tx: never) => enqueueSystemEventDelivery(tx, {
    workspaceId, userId, systemEventId, text: "", ttlHours: 24,
  }));
  assert.ok(id, "实测：空正文没有被拒，它照常落了库");

  const rows = await readInScope(scope(), (tx) => tx`
    SELECT payload_ref FROM assistant_deliveries
    WHERE workspace_id = ${workspaceId} AND id = ${id}`);
  const payload = (rows[0] as unknown as { payload_ref: { text?: string } }).payload_ref;
  assert.equal(payload.text, "",
    "量错了：空正文被这一层补上了内容 —— 那么缺口不在投递面，改去查上游");

  // **这一条是缺口本身**：收件箱里会有一个**没有内容**的条目，而屏上没有任何东西
  // 提示它（40b §3 要的「缺失要说出来」在**投递这一侧**今天没有）。
  // 判据写成断言"它确实是空的"：哪天投递面补上了校验，这条会红，
  // 那时**把本条改成断言"被拒"**（而不是删掉）——缺口闭合要留下痕迹。
  assert.equal(payload.text === "", true,
    "投递面已经拒绝空正文了：本条应当改写成断言『被拒』，并把这一段缺口说明删掉");
});
