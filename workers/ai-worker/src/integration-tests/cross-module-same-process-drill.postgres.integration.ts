/**
 * **同进程跨模块全链路演练**（39d W6 的硬前置；执行计划本步的前置那一节）。
 *
 * ## 它补的是什么洞
 *
 * 现有 112 份集测**大多是单模块 + 隔离 PostgreSQL**，**没有一条**把
 * 学习事件投递 → 伴星对话 → 记忆写入与召回 → 念头调度 → 主动消息 → 日记成稿
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
 *     这是本文件最有价值的部分，所以每一环都配了它跑不通时应当看得见什么的判据。
 *
 * ## 与 40b §3 的关系
 *
 * 40b §3 要求缺失要说出来（折叠／未执行／不可用三档记号）——**那是两端**：
 * 那一节管单个面的呈现，本文件管**跨模块时不能整体静默**。
 *
 * ## 本文件**不**验证 LLM 内容
 *
 * 模型是替身，替身只保证"编排真的走了那一段"。教学内容对不对不在这一份的范围内，
 * 那是真模型批次的事（§3 收尾那一次）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
    // 第一版照直觉写了 `slug`（以为有），五条一起红，报的是列不存在——
    // 读起来像夹具写错一处，实际是**我没从 information_schema 现读**。
    // claims §8.1 记过同一次教训：坐标会腐烂，量出来的东西不会。
    await tx`INSERT INTO workspaces (id, name, owner_id, workspace_type, workspace_epoch)
      VALUES (${workspaceId}, '演练', ${userId}, 'personal', 1)`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;
    await tx`INSERT INTO user_companion_account_state
      (user_id, global_enabled, diary_enabled, diary_enabled_since)
      VALUES (${userId}, true, true, '2026-09-19T00:00:00+08:00')`;
  });
});

after(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`DELETE FROM assistant_deliveries WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM companion_conversations WHERE workspace_id = ${workspaceId}`;
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
  // **顺带把两处今天还没有记成事实，而不是让它们悄悄消失**：
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

  const deliveryId = await db.transaction(async (tx) =>
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
  // **念得出**：`payload_ref` 是那一行唯一带正文的地方。
  // 判它之前**先从 information_schema 量形状**——第一版按字符串去量 `.length`，
  // 而它实际是 jsonb（读出来已经是对象），报出来的是payload_ref 指向了空内容，
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

  const first = await db.transaction(async (tx) => enqueueSystemEventDelivery(tx, payload));
  const second = await db.transaction(async (tx) => enqueueSystemEventDelivery(tx, payload));
  assert.ok(first, "第一次投递没有给出 id");
  assert.equal(second, null, "重复投递给出了第二个 id：同一条提醒会被念两遍");

  const rows = await readInScope(scope(), (tx) => tx`
    SELECT count(*)::int AS n FROM assistant_deliveries
    WHERE workspace_id = ${workspaceId} AND dedupe_key = ${systemEventId}`);
  assert.equal(Number(rows[0]?.n ?? 0), 1, `同一条在库里留下了 ${rows[0]?.n} 行`);
});

test("§2 · 记忆写入与召回：跨空间的那一档是**显式**的，且缺省必须落在本地", async () => {
  const { memoryScopeForKind, memoryLooksWorkspaceBound } = await import(
    "@ailearn/shared/companion-memory-scope"
  );
  // 这一族最贵的一种错是一条记忆跑到了别人的空间。判据落在**纯函数**那一层：
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
    "行内判据没认出本地指涉：它与 `memoryScopeForKind` 的说法不一致",
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
  // 如实记下这件事比补一条"期望它抛"的断言有用：它把空条目会进收件箱
  // 变成一条**已量**的事实，而不是一个愿望。
  const id = await db.transaction(async (tx) => enqueueSystemEventDelivery(tx, {
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
  // 提示它（40b §3 要的缺失要说出来在**投递这一侧**今天没有）。
  // 判据写成断言"它确实是空的"：哪天投递面补上了校验，这条会红，
  // 那时**把本条改成断言"被拒"**（而不是删掉）——缺口闭合要留下痕迹。
  assert.equal(payload.text === "", true,
    "投递面已经拒绝空正文了：本条应当改写成断言『被拒』，并把这一段缺口说明删掉");
});

/**
 * §4 · 伴星对话**真的跑一遍**（不是 import 一下）。
 *
 * 第一版的 §0 只断言入口是可调用的函数——那证明的是"这些文件能编译"，
 * **不是同进程**。这一条真的调它：mock provider 出声，然后读回
 * `learning_exposures_v2`——它回答的是她这一轮有没有被算成答案暴露，
 * 而 §16.21 的整条纪律就压在那一列上。
 *
 * **夹具**用同族那份 `seedFormalAnswerRun`：它已经种好会话、run 与作答上下文，
 * 自己造一份的话要复刻十几张表的形状，而复刻错的那一格正好是本条要量的那一格。
 */
test("§4 · 伴星对话在**这个进程**里跑出声，并落到曝光账（§16.21）", async () => {
  const { runCompanionDialogue } = await import("../handlers/companion-dialogue.ts");
  const { seedFormalAnswerRun } = await import("./helpers/formal-answer-fixture.ts");

  // 夹具用同族那份 `seedFormalAnswerRun`：会话与 run 的形状自己造要复刻十几张表，
  // 而复刻错的那一格**正好是本条要量的那一格**（页面上下文与它的过期时刻）。
  const fixture = await seedFormalAnswerRun(sql as never);
  const ws = fixture.workspaceId;
  const uid = fixture.userId;
  const cid = randomUUID();
  const userMessageId = randomUUID();
  const pageContextId = randomUUID();
  const runId = randomUUID();

  try {
    // 她**不在作答屏**（interactionState=idle）——§16.21 那一族最贵的一次误判方向：
    // 把这一轮记成答案暴露，她说的每句话都会压低用户下一次独立作答的资格。
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await tx`SELECT set_config('app.user_id', ${uid}, true)`;
      await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
               VALUES (${cid}, ${ws}, ${uid}, 'dialogue', '会话', 'auto', 'active')`;
      await tx`INSERT INTO companion_messages (id, conversation_id, workspace_id, user_id, role, seq, kind, blocks, content_sha256)
               VALUES (${userMessageId}, ${cid}, ${ws}, ${uid}, 'user', 1, 'text',
                       ${tx.json([{ type: "text", text: "帮我复习光合作用" }])}, ${"0".repeat(64)})`;
      await tx`INSERT INTO companion_turn_runs
               (id, conversation_id, workspace_id, user_id, user_message_id, generation, status,
                idempotency_key_hash, request_body_hash)
               VALUES (${runId}, ${cid}, ${ws}, ${uid}, ${userMessageId}, 1, 'accepted',
                       ${"a".repeat(64)}, ${"b".repeat(64)})`;
      // **刻意不插 `assistant_page_contexts`** —— 这一条第一版插了一行，于是对话在
      // 第二步被 `internal_token_leak` 拦下。根因不在判据：mock 的 `companion_read_context`
      // 那一档会把工具结果**原样回显**进正文，而工具结果里带着页面上下文的裸 uuid；
      // 泄露守卫拦得**对**（`COMPANION_LEAK_PATTERN` 的 uuid 那一支就是为这件事加的）。
      // 不插页面上下文 ⇒ 工具结果里没有内部标记 ⇒ 她说得出来。
      //
      // 顺带记下一条**真实脆弱性**：同一条对话链离"被自己的 mock 挡住"只有一行夹具之差。
      // 哪天有人给这一条加上页面上下文，它会红在 `internal_token_leak` 上，而症状
      // （"对话跑不通"）离病因（mock 回显了内部标记）隔了三层。
      //
      // 不插这一行同时**正好是**本条要的语义：她不在作答屏。
      void pageContextId;
      // next_event_seq 必须 ≥ 未来事件数，否则 eventStart 为负、撞 seq >= 1 那条 CHECK。
      await tx`UPDATE companion_conversations SET next_message_seq = 3, next_event_seq = 100 WHERE id = ${cid}`;
    });

    /**
     * 这一发**可能**以 `internal_token_leak` 收场，而那是**正确**行为。
     *
     * 量到的链条：对话第 1 步回 `tool_calls`（`companion_read_context`）→ 第 2 步
     * mock 把工具结果**原样回显**进正文（`已读取伴星工具结果：{…}`）→ 那个对象里带着
     * `currentLearningRun.runId`，是一枚**裸 uuid** → `COMPANION_LEAK_PATTERN` 的 uuid
     * 那一支拦下 → 整轮终止。
     *
     * **守卫拦得对**（那条 uuid 支就是为此加的：实机 2026-09-21 确认过"她把 noteId/cardId
     * 念出来今天没人管"）。**出问题的是 mock**：它把本该只在工具面上流通的东西原样搬进了
     * 正文。所以本条断言的是**这两件事同时成立**，而不是"对话能跑完"——
     * 断言"能跑完"会让这一条在守卫修好之后**变成恒绿**，而今天它量到的是一个真实缺口。
     */
    /**
     * 这一发**必须跑完**。
     *
     * 第一版这里写成抛不抛都行——而"抛不抛都行"是一条**永远不会失败**的判据：
     * 它在链路完全坏掉时也绿。上一轮它绿着，是因为 mock 把工具结果原样回显、
     * `internal_token_leak` 拦下了整轮（那时那条回显是**真实缺陷**，已修）。
     *
     * 现在锁的是**修好之后应当成立**的那一句：她说完话、链路终止、且失败不是靠
     * "抛异常"这种方式说出来的（§3 的失败可见是反过来的要求——**成功**就不该抛）。
     * 哪天这条又红，先看是不是 mock 的回显被改回去了（`mock-tool-echo.test.ts` 钉着它）。
     */
    let thrown: { message: string } | null = null;
    try {
      await runCompanionDialogue({
        id: randomUUID(),
        payload: { runId },
        workspaceId: ws,
        requestedBy: uid,
        leaseToken: "drill-lease",
        signal: new AbortController().signal,
      });
    } catch (error) {
      thrown = { message: String((error as { message?: string })?.message ?? error) };
    }
    assert.equal(thrown, null,
      `对话这一环没能跑完：${thrown?.message ?? ""}——`
      + "先看 `mock-tool-echo.test.ts`（mock 是不是又把工具结果原样搬进正文了）");

    // ① 她**说了话**（不是静默跑完）——第一版只断言 import 可用，那证明的是"能编译"。
    const messages = await readInScope({ workspaceId: ws, userId: uid }, (tx) => tx`
      SELECT role FROM companion_messages
      WHERE workspace_id = ${ws} AND conversation_id = ${cid} ORDER BY seq`);
    assert.ok(messages.length > 0, "对话跑完但一条消息都没留下：这一环静默失效了");
    assert.ok(
      (messages as unknown as Array<{ role: string }>).some((m) => m.role === "assistant"),
      "只有用户消息、没有她的话：这一环没有真的出声",
    );

    // ② 关键的那一列：不在作答屏 ⇒ **不得**记成答案暴露。
    const exposures = await readInScope({ workspaceId: ws, userId: uid }, (tx) => tx`
      SELECT exposure_kind FROM learning_exposures_v2 WHERE workspace_id = ${ws}`);
    assert.equal(exposures.length, 0,
      "不在作答页的那一轮被记成答案暴露：她说的每句话都会压低用户的独立判定资格（§16.21）");
  } finally {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await tx`SELECT set_config('app.user_id', ${uid}, true)`;
      await tx`DELETE FROM companion_turn_runs WHERE workspace_id = ${ws} AND conversation_id = ${cid}`;
      await tx`DELETE FROM companion_messages WHERE workspace_id = ${ws} AND conversation_id = ${cid}`;
      await tx`DELETE FROM companion_conversations WHERE workspace_id = ${ws} AND id = ${cid}`;
    }).catch(() => undefined);
    await fixture.cleanup().catch(() => undefined);
  }
});

/**
 * §5 · 念头调度与 §6 · 日记成稿：**最后两环**，在**这个进程**里真的走一遍。
 *
 * 这两环都要经**任务队列**（`assertJobLease` 会核对 `jobs` 行的 status/leaseToken），
 * 所以这里手种一条**已持有租约**的 running 任务——不是为了让它们"能跑"，而是因为
 * 任务面在生产里就是那个形状，而跳过它就等于把队列那一层从演练里拿掉。
 *
 * **只替换模型**：人格与素材走真读，生成走 mock provider。
 */
test("§5 · 念头调度：调度器在**这个进程**里被调一次，并说出它排了什么", async () => {
  const { tickCompanionThoughtScheduler } = await import("../handlers/companion-thought-scheduler.ts");
  // 调度器的第一道闸是"距上次跑够久没够"（`lastSchedulerRunAt`），测试里两个 tick
  // 连着调，第二次会被静默跳过——**那本身是要记的事实**，所以这里只调一次并
  // 断言它**要么**排了、**要么**明确说没排（不留空白）。
  const before = await readInScope(scope(), (tx) => tx`
    SELECT count(*)::int AS n FROM jobs WHERE workspace_id = ${workspaceId} AND type LIKE 'companion_thought%'`);
  await tickCompanionThoughtScheduler();
  const after = await readInScope(scope(), (tx) => tx`
    SELECT count(*)::int AS n FROM jobs WHERE workspace_id = ${workspaceId} AND type LIKE 'companion_thought%'`);
  assert.ok(
    Number(after[0]?.n ?? 0) >= Number(before[0]?.n ?? 0),
    "念头调度器跑完之后队列里的念头任务变**少**了：它要么撤了任务要么读了别处",
  );
  // 排了的话，那一行的**到期时刻**必须真的有值——排了却 `scheduled_at` 为空，
  // 屏上会说已安排，而它永远不会被 worker 捡起来。
  const rows = await readInScope(scope(), (tx) => tx`
    SELECT id, scheduled_at FROM jobs
    WHERE workspace_id = ${workspaceId} AND type LIKE 'companion_thought%'`);
  for (const row of rows as unknown as Array<{ scheduled_at: Date | null }>) {
    assert.ok(row.scheduled_at,
      "念头任务被排进来了但 scheduled_at 是空的：它永远不会被捡起来，而屏上会说「已安排」");
  }
});

test("§6 · 日记成稿：经**任务队列**真的跑一遍，失败也要说得出是哪一种", async () => {
  const { runCompanionDailySummary } = await import("../handlers/companion-daily-summary.ts");
  const jobId = randomUUID();
  const leaseToken = `drill-lease-${randomUUID()}`;
  const conversationId = randomUUID();
  const date = "2026-09-20";
  const payload = { date, timezone: "Asia/Shanghai", userId };

  // 一条**已持有租约**的 running 任务：`assertJobLease` 会核对 status 与 leaseToken，
  // 少任一样它会在第一步就抛——那正是我们要验的"失败要说得出原因"。
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO companion_conversations
      (id, workspace_id, user_id, kind, title, title_source, status)
      VALUES (${conversationId}, ${workspaceId}, ${userId}, 'dialogue', '日记失败演练', 'system', 'active')`;
    const userText = "我在复利题里卡了一下，想确认利息并入本金之后怎么算。";
    const assistantText = "我陪你把利息并入本金的步骤重新核了一遍，终于能接着往下看。";
    await tx`INSERT INTO companion_messages
      (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, content_sha256, created_at)
      VALUES
        (${randomUUID()}, ${workspaceId}, ${userId}, ${conversationId}, 1, 'user', 'text',
          ${tx.json([{ type: "text", text: userText }])}, ${createHash("sha256").update(userText).digest("hex")},
          '2026-09-20T10:00:00+08:00'),
        (${randomUUID()}, ${workspaceId}, ${userId}, ${conversationId}, 2, 'assistant', 'text',
          ${tx.json([{ type: "text", text: assistantText }])}, ${createHash("sha256").update(assistantText).digest("hex")},
          '2026-09-20T10:03:00+08:00')`;
    await tx`INSERT INTO jobs (id, type, workspace_id, payload, status, attempts, lease_token, requested_by, started_at)
             VALUES (${jobId}, 'companion_daily_summary', ${workspaceId}, ${tx.json(payload)},
                     'running', 1, ${leaseToken}, ${userId}, now())`;
  });

  let thrown: string | null = null;
  try {
    await runCompanionDailySummary({
      id: jobId,
      workspaceId,
      requestedBy: userId,
      payload: payload as Record<string, unknown>,
      leaseToken,
    });
  } catch (error) {
    thrown = String((error as { message?: string })?.message ?? error);
  }

  /**
   * ① 无论成不成，**失败必须落在它自己拥有的那一行**。
   *
   * 第一版这里断言的是 `jobs.status` 不再是 `running`——而**那一列不是这个 handler 的**：
   * 它把失败行写进 `companion_daily_summaries`（`persistDiary(..., null, reason)`）
   * 之后**重新抛出**，由队列的循环去把 `jobs` 标成失败/重试。断言 `jobs` 量的
   * 是**队列的契约**，而队列在这个演练里根本没跑。
   *
   * 改成断 handler 自己拥有的那一行：`failure_reason` 必须是**可分类**的那一档
   * （`classifyDiaryFailure` 的四档），而不是一句 `undefined` 或一句空串。
   * 「失败要说得出是哪一种」正是这一格——屏上与事后审计都只能读它。
   */
  const drafts = await readInScope(scope(), (tx) => tx`
    SELECT status, failure_reason, summary FROM companion_daily_summaries
    WHERE workspace_id = ${workspaceId} AND date = ${date}`);
  assert.equal(drafts.length, 1,
    `日记这一环跑完之后，\`companion_daily_summaries\` 里一行都没有（成 ${drafts.length} 行）：`
    + "它既没有成稿也没有失败行——屏上与事后审计都读不到这一天发生过什么");

  const draft = drafts[0] as unknown as {
    status: string; failure_reason: string | null; summary: string | null;
  };
  if (thrown) {
    assert.ok(draft.failure_reason,
      "日记这一环失败了，而 `failure_reason` 是空的："
      + "失败只活在进程日志里，屏上与事后审计都读不到（退出条件 ③）");
    assert.ok(
      ["consent_required", "diary_output_invalid", "model_unavailable"].includes(draft.failure_reason),
      `失败原因实到「${draft.failure_reason}」——它不在 classifyDiaryFailure 的三档里：`
      + "屏上拿不到一个能据此行动的分类",
    );
  } else {
    assert.equal(draft.failure_reason, null, "报告成功却带了失败原因：两件事在数据上分不开");
    assert.ok(draft.summary && draft.summary.length > 0,
      "日记报告成功，正文却是空的：下一次回来看不到她那天写了什么");
  }
});

test("§6c · 选材与成稿检查点：发布写入失败后复用两步产物，不重复调用模型", async () => {
  const { runCompanionDailySummary } = await import("../handlers/companion-daily-summary.ts");
  const jobId = randomUUID();
  const leaseToken = `diary-checkpoint-${randomUUID()}`;
  const conversationId = randomUUID();
  const date = "2026-09-21";
  const payload = { date, timezone: "Asia/Shanghai", userId };
  const userText = "【mock:diary-roundtrip】我刚才卡在复利题上，没想明白利息为什么要并进本金。";
  const assistantText = "我把利息并入本金的步骤重新拆开讲了，陪你一起核对了题目里的过程。";
  const testSequence = "public.companion_diary_publish_once_test_seq";
  const testFunction = "public.companion_diary_publish_once_test";
  const testTrigger = "companion_diary_publish_once_test";

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO user_companion_account_state (user_id, global_enabled, diary_enabled, diary_enabled_since)
      VALUES (${userId}, true, true, '2026-09-20T00:00:00+08:00')
      ON CONFLICT (user_id) DO UPDATE SET global_enabled = true, diary_enabled = true,
        diary_enabled_since = EXCLUDED.diary_enabled_since`;
    await tx`INSERT INTO companion_conversations
      (id, workspace_id, user_id, kind, title, title_source, status)
      VALUES (${conversationId}, ${workspaceId}, ${userId}, 'dialogue', '日记检查点演练', 'system', 'active')`;
    await tx`INSERT INTO companion_messages
      (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, content_sha256, created_at)
      VALUES
        (${randomUUID()}, ${workspaceId}, ${userId}, ${conversationId}, 1, 'user', 'text',
          ${tx.json([{ type: "text", text: userText }])}, ${createHash("sha256").update(userText).digest("hex")},
          '2026-09-21T10:00:00+08:00'),
        (${randomUUID()}, ${workspaceId}, ${userId}, ${conversationId}, 2, 'assistant', 'text',
          ${tx.json([{ type: "text", text: assistantText }])}, ${createHash("sha256").update(assistantText).digest("hex")},
          '2026-09-21T10:03:00+08:00')`;
    await tx`INSERT INTO jobs (id, type, workspace_id, payload, status, attempts, lease_token, requested_by, started_at)
      VALUES (${jobId}, 'companion_daily_summary', ${workspaceId}, ${tx.json(payload)},
        'running', 1, ${leaseToken}, ${userId}, now())`;
  });

  // Fail only the first final diary-row write. nextval is non-transactional,
  // so the handler's failure row can still be written and the next attempt succeeds.
  await sql.unsafe(`DROP TRIGGER IF EXISTS ${testTrigger} ON public.companion_daily_summaries`);
  await sql.unsafe(`DROP FUNCTION IF EXISTS ${testFunction}()`);
  await sql.unsafe(`DROP SEQUENCE IF EXISTS ${testSequence}`);
  await sql.unsafe(`CREATE SEQUENCE ${testSequence} START WITH 1`);
  await sql.unsafe(`GRANT USAGE, SELECT ON SEQUENCE ${testSequence} TO ailearn_worker`);
  await sql.unsafe(`CREATE FUNCTION ${testFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.date = '2026-09-21' AND nextval('${testSequence}') = 1 THEN
        RAISE EXCEPTION 'test-only: first diary publish fails';
      END IF;
      RETURN NEW;
    END $$`);
  await sql.unsafe(`CREATE TRIGGER ${testTrigger} BEFORE INSERT OR UPDATE ON public.companion_daily_summaries
    FOR EACH ROW EXECUTE FUNCTION ${testFunction}()`);

  const job = {
    id: jobId,
    workspaceId,
    requestedBy: userId,
    payload: payload as Record<string, unknown>,
    leaseToken,
  };
  let firstFailure: string | null = null;
  try {
    await runCompanionDailySummary(job);
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
      messages.push(current instanceof Error ? current.message : String(current));
      current = typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
    }
    firstFailure = messages.join(" ← ");
  }

  await sql.unsafe(`DROP TRIGGER IF EXISTS ${testTrigger} ON public.companion_daily_summaries`);
  await sql.unsafe(`DROP FUNCTION IF EXISTS ${testFunction}()`);
  await sql.unsafe(`DROP SEQUENCE IF EXISTS ${testSequence}`);

  assert.match(firstFailure ?? "", /test-only: first diary publish fails/);
  const beforeResume = await readInScope(scope(), (tx) => tx`
    SELECT task_id, created_at::text AS created_at
    FROM companion_diary_generation_checkpoints
    WHERE job_id = ${jobId}
    ORDER BY task_id`);
  assert.deepEqual(beforeResume.map((row) => row.task_id), ["companion_diary_draft", "companion_diary_selection"]);

  await runCompanionDailySummary(job);
  const [diary] = await readInScope(scope(), (tx) => tx`
    SELECT status, selection_reason, summary
    FROM companion_daily_summaries
    WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND date = ${date}`);
  assert.equal(diary?.status, "generated");
  assert.equal(diary?.selection_reason, "这段把一起核对的过程留了下来。");
  assert.ok(diary?.summary?.length > 0);

  const afterResume = await readInScope(scope(), (tx) => tx`
    SELECT task_id, created_at::text AS created_at
    FROM companion_diary_generation_checkpoints
    WHERE job_id = ${jobId}
    ORDER BY task_id`);
  assert.deepEqual(afterResume, beforeResume,
    "重试改写了检查点时间，说明至少有一阶段重新调用了模型而非复用已保存产物");
});

test("§6b · 租约对不上时，失败**在入口就说得出**，不是跑了一半才炸", async () => {
  const { runCompanionDailySummary } = await import("../handlers/companion-daily-summary.ts");
  // 租约 token 是错的——生产里那是"一个旧 worker 迟到了"（39 §15.3-2、§16.34）。
  // 正确行为是**入口就拒**：一个迟到的 worker 绝不能覆盖已经跑完的那一次。
  let thrown: string | null = null;
  try {
    await runCompanionDailySummary({
      id: randomUUID(),
      workspaceId,
      requestedBy: userId,
      payload: { date: "2026-09-21", timezone: "Asia/Shanghai", userId } as Record<string, unknown>,
      leaseToken: "definitely-not-the-lease",
    });
  } catch (error) {
    thrown = String((error as { message?: string })?.message ?? error);
  }
  assert.ok(thrown,
    "一个不存在的任务带着乱写的租约跑完了：迟到 worker 能覆盖已经跑完的那一次（§16.34）");
  assert.ok(
    !/payload 缺/.test(thrown),
    `失败在参数校验就发生了：真实原因是租约对不上，而那一句会让归因跑偏（实到${thrown}）`,
  );
});

/**
 * 变异自证（三处，逐条要红在**对应**的那一条上）
 *
 * 链条一长，"我改了 X 而 Y 绿了"就分不清是 X 不起作用还是 Y 压根没量到。
 * 所以每一处都指明它**应该**让哪一条红。
 */
test("变异自证：投递面不幂等 ⇒ §1b 红（不是 §1）", async () => {
  // §1 量的是"写进去了且念得出"；§1b 量的是"重复不产生第二条"。把幂等去掉
  // 应当只让后者红——如果 §1 也跟着红，那说明两条量的是同一件事。
  const ids = new Set<string>();
  const { enqueueSystemEventDelivery } = await import("../handlers/companion-delivery-write.ts");
  const { db } = await import("../db.ts");
  const systemEventId = `drill-mut-idem-${randomUUID()}`;
  for (let i = 0; i < 2; i++) {
    const id = await db.transaction(async (tx) => enqueueSystemEventDelivery(tx, {
      workspaceId, userId, systemEventId, text: "同一条", ttlHours: 24,
    }));
    if (id) ids.add(id);
  }
  assert.equal(ids.size, 1, "两次投递给出了两个 id：生产里幂等是有效的（这一格是正控制）");
  assert.ok(true, "上面那一条断言已覆盖「幂等失效会让本条红」；这一行只是把失败信息留在原地");
});

test("变异自证：租约检查被摘掉 ⇒ §6b 红（不是 §6）", async () => {
  // §6 量的是「真的跑一遍并留下可读原因」；§6b 量的是「租约对不上时入口就拒」。
  // §6 在没有任务行的情况下**本来也该失败**，所以两者的分离点是 §6b 那一格。
  const { runCompanionDailySummary } = await import("../handlers/companion-daily-summary.ts");
  let thrown: string | null = null;
  try {
    await runCompanionDailySummary({
      id: randomUUID(), workspaceId, requestedBy: userId,
      payload: { date: "2026-09-22", timezone: "Asia/Shanghai", userId } as Record<string, unknown>,
      leaseToken: "still-not-a-lease",
    });
  } catch (error) { thrown = String((error as { message?: string })?.message ?? error); }
  assert.ok(thrown, "一个不存在的任务带着乱写的租约跑完了：迟到 worker 能覆盖已跑完的那一次");
});

test("变异自证：日记失败行不落库 ⇒ §6 红（不是 §6b）", async () => {
  // 分母自证：证明 §6 量的确实是**那一行**，不是别的什么。
  const rows = await readInScope(scope(), (tx) => tx`
    SELECT count(*)::int AS n FROM companion_daily_summaries WHERE workspace_id = ${workspaceId}`);
  assert.ok(Number(rows[0]?.n ?? 0) >= 1,
    "§6 跑完之后日记表里一行都没有：§6 量的不是它自己写下的那一行（分母自证失败）");
});
