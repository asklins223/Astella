/**
 * 长会话上下文覆盖实测。
 *
 * 这里不假设"窗口应该多大"，而是用**对话侧与摘要侧同一批生产函数**，
 * 量出某一轮真实能看见什么：
 * - 原话回放（inline replay）带回哪一段 seq；
 * - 摘要接续链此刻会写到哪一段（摘要器自己的裁剪锚点）；
 * - 两段之间有没有"摘要没覆盖、原文也没回放"的那一层，以及它有多宽。
 *
 * 夹具是三天里 150 轮的真实长度分布（用户短、伴星长短相间），
 * 关键事实埋在早期轮次里，用序号追踪它到底还在不在她的上下文里。
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";

const CONN = testDatabaseUrl("DATABASE_URL");
const admin = postgres(CONN, { max: 3 });

const userId = randomUUID();
const workspaceId = randomUUID();
const conversationId = randomUUID();
const prefix = userId.slice(0, 8);

const {
  readCompanionReplayHistoryRows,
  readConversationSummaryChain,
  companionHistoryText,
  countCompanionHistoryMessages,
} = await import("../../../../workers/ai-worker/src/handlers/turn/companion-dialogue-store.ts");
const {
  boundCompanionRecentHistory,
  selectCompanionInteractiveReplayWindow,
  resolveRouteInputTokens,
  REPLAY_HISTORY_READ_ROWS,
} = await import("../../../../workers/ai-worker/src/handlers/context/companion-context-handoff.ts");
const {
  buildSummarizerSnapshot,
  resolveSummarizerInputTokens,
  resolveCompanionSummarizerTailAnchor,
  readSummarizerSourceRows,
} = await import("../../../../workers/ai-worker/src/handlers/context/companion-summarizer.ts");
const { closeDatabase: closeWorkerDatabase, withWorkerWorkspaceTransaction } =
  await import("../../../../workers/ai-worker/src/db.ts");

/** 埋在早期的一条评论级线索，用来追"三天前那句话今天还看得见吗"。 */
const EARLY_FACT_TURN = 3;
const EARLY_FACT = "我的猫叫 Momo，周四要带去复查，结果出来我要第一时间告诉你。";
const EARLY_TOPIC_TURN = 6;
const EARLY_TOPIC = "我在准备爵士钢琴的 transcribe，每天只练二十分钟。";

type Seeded = { seq: bigint; role: "user" | "assistant"; text: string; turn: number };
const seeded: Seeded[] = [];

function userTextFor(turn: number): string {
  if (turn === EARLY_FACT_TURN) return EARLY_FACT;
  if (turn === EARLY_TOPIC_TURN) return EARLY_TOPIC;
  if (turn % 17 === 0) return "今天有点累，随便聊两句。";
  if (turn % 5 === 0) return "那这一步具体怎么拆开做，你再讲讲。";
  return "继续吧，把刚才那段再往下推一点。";
}

function assistantTextFor(turn: number): string {
  // 真实长度分布：多数回复 120–260 字，每 23 轮有一篇长文（笔记／讲解）。
  if (turn % 23 === 0) return "我把这段整理成一份可以照着练的说明：\n" + "先听两遍主题句，记下重音落在哪个和弦上；然后按小节写下来，对照原曲核对；错的地方不要急着改，先标出来，最后一遍统一处理。".repeat(14);
  if (turn % 3 === 0) return "好，那就按二十分钟来安排，前五分钟热身，中间十分钟主攻一句，最后五分钟回头听一遍。";
  return "我在，慢慢来。";
}

async function seedTurns(turnCount: number, startedAt: Date): Promise<void> {
  const firstTurn = seeded.length / 2 + 1;
  await admin.begin(async (tx) => {
    for (let turn = firstTurn; turn <= turnCount; turn += 1) {
      for (const [offset, role, text] of [
        [0, "user", userTextFor(turn)] as const,
        [1, "assistant", assistantTextFor(turn)] as const,
      ]) {
        const seq = (turn - 1) * 2 + offset + 1;
        // 摊到三天：每 50 轮跨一天。
        const createdAt = new Date(startedAt.getTime() + Math.floor((seq - 1) / 100) * 24 * 3_600_000);
        await tx`
          INSERT INTO companion_messages
            (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, content_sha256, created_at)
          VALUES
            (${randomUUID()}, ${workspaceId}, ${userId}, ${conversationId}, ${seq},
             ${role}, 'text', ${tx.json([{ type: "text", text }])},
             ${createHash("sha256").update(text).digest("hex")}, ${createdAt})
        `;
        seeded.push({ seq: BigInt(seq), role, text, turn });
      }
    }
  });
  await admin`
    UPDATE companion_conversations
     SET next_message_seq = ${turnCount * 2 + 1}, last_message_at = now()
   WHERE id = ${conversationId}
  `;
}

/** 对话侧：这一轮真正进 prompt 的那一段原话。 */
async function measureInlineWindow() {
  return withWorkerWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const chain = await readConversationSummaryChain(tx, conversationId);
    const coverage = chain.head ? { fromSeq: chain.effectiveCoverageFromSeq, throughSeq: chain.effectiveCoverageThroughSeq, sourceSha256: chain.head.coverage_source_hash, uncovered: chain.gaps } : null;
    const rows = await readCompanionReplayHistoryRows(tx, conversationId, { coverage });
    const pool = rows.slice().reverse().map((row) => ({
      seq: row.seq,
      role: row.role as "user" | "assistant",
      text: companionHistoryText(row),
      createdAt: row.created_at,
      replyStatus: row.run_status,
    }));
    const visible = boundCompanionRecentHistory(pool);
    const window = selectCompanionInteractiveReplayWindow(
      visible,
      resolveRouteInputTokens(null, null), coverage,
    );
    const total = await countCompanionHistoryMessages(tx, conversationId, "9223372036854775807");
    return {
      takenCount: window.receipt.takenCount,
      usedTokens: window.receipt.usedTokens,
      capacityTokens: window.receipt.capacityTokens,
      omittedCount: window.receipt.omittedCount,
      uncoveredThroughSeq: window.receipt.uncoveredThroughSeq,
      oversizedSkipped: window.receipt.oversizedSkipped ?? [],
      inlineFromSeq: window.messages[0]?.seq ?? null,
      poolFromSeq: visible[0]?.seq ?? null,
      visiblePool: visible.length,
      totalMessages: Number(total),
      inlineText: window.messages.map((message) => message.text).join("\n"),
    };
  });
}

/** 摘要侧：摘要器现在跑的话，会写到哪一段（直接调生产那一条分页判据，不复刻规则）。 */
async function measureSummaryCoverage(previousCoverageThroughSeq: string | null) {
  return withWorkerWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const tailStartSeq = await resolveCompanionSummarizerTailAnchor(tx, conversationId);
    const chunkTokens = resolveSummarizerInputTokens(null);
    const sourceRows = await readSummarizerSourceRows(tx, {
      conversationId,
      chunkTokens,
      beforeSeq: tailStartSeq,
      previousCoverageThroughSeq,
    });
    const snapshot = buildSummarizerSnapshot(sourceRows.map((row) => ({
      id: row.id,
      seq: row.seq,
      role: row.role,
      contentSha256: row.content_sha256,
      blocks: row.blocks,
      pageContext: row.page_context,
      createdAt: row.created_at,
      replyStatus: row.run_status,
    })), chunkTokens, conversationId);
    return {
      tailAnchorSeq: tailStartSeq ?? null,
      previousCoverageThroughSeq,
      coverageFromSeq: snapshot.coverageFromSeq,
      coverageThroughSeq: snapshot.coverageThroughSeq,
      uncovered: snapshot.uncovered,
      transcript: snapshot.transcript,
    };
  });
}

/** 库里已经折到哪一段——夹具直接把上一份的边界读出来，不猜。 */
async function latestSummaryThroughSeq(): Promise<string | null> {
  const rows = await admin<{ coverage_through_seq: string | null }[]>`
    SELECT max(coverage_through_seq)::text AS coverage_through_seq
    FROM conversation_summaries WHERE conversation_id = ${conversationId}
  `;
  return rows[0]?.coverage_through_seq ?? null;
}

const report: string[] = [];
function log(line: string): void {
  report.push(line);
  console.log(line);
}

before(async () => {
  await admin`
    INSERT INTO users (id, email, password_hash, role)
    VALUES (${userId}, ${`longrun-gap-${prefix}@example.test`}, 'test-hash', 'owner')
  `;
  await admin`
    INSERT INTO workspaces (id, name, owner_id, workspace_type)
    VALUES (${workspaceId}, ${`longrun-gap-${prefix}`}, ${userId}, 'collaborative')
  `;
  await admin`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
  await admin`
    INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
    VALUES (${conversationId}, ${workspaceId}, ${userId}, 'inbox', '长会话覆盖实测', 'user', 'active')
  `;
});

after(async () => {
  await admin`DELETE FROM conversation_summaries WHERE conversation_id = ${conversationId}`;
  await admin`DELETE FROM companion_messages WHERE conversation_id = ${conversationId}`;
  await admin`DELETE FROM companion_conversations WHERE id = ${conversationId}`;
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await admin`DELETE FROM users WHERE id = ${userId}`;
  await admin.end({ timeout: 5 }).catch(() => {});
  await closeWorkerDatabase().catch(() => {});
});

test("连续 150 轮：量出原话回放、摘要覆盖与中间那层空洞", async () => {
  const startedAt = new Date(Date.now() - 3 * 24 * 3_600_000);
  const checkpoints = [10, 25, 50, 75, 100, 125, 150];
  log(`\n=== 长会话覆盖实测（摘要覆盖投影，读取页 ${REPLAY_HISTORY_READ_ROWS} 行）===`);
  log("轮次 | 库内消息 | 回放条数 | 回放seq区间 | 回放用量tok | 摘要覆盖到seq | 空洞条数 | 空洞字符");

  for (const turnCount of checkpoints) {
    await seedTurns(turnCount, startedAt);
    const inline = await measureInlineWindow();
    const summary = await measureSummaryCoverage(await latestSummaryThroughSeq());
    const through = summary.coverageThroughSeq ? BigInt(summary.coverageThroughSeq) : 0n;
    const inlineFrom = inline.inlineFromSeq ? BigInt(inline.inlineFromSeq) : through + 1n;
    const holeMessages = inlineFrom > through + 1n ? Number(inlineFrom - through - 1n) : 0;
    const holeChars = seeded
      .filter((row) => row.seq > through && row.seq < inlineFrom)
      .reduce((sum, row) => sum + row.text.length, 0);
    log(`${turnCount} | ${inline.totalMessages} | ${inline.takenCount} | ${inline.inlineFromSeq ?? "-"}..${inline.totalMessages} | ${inline.usedTokens} | ${summary.coverageThroughSeq ?? "无"} | ${holeMessages} | ${holeChars}`);
  }

  const inline = await measureInlineWindow();
  const summary = await measureSummaryCoverage(await latestSummaryThroughSeq());
  const through = BigInt(summary.coverageThroughSeq ?? "0");
  const inlineFrom = BigInt(inline.inlineFromSeq ?? "0");

  // 契约：摘要锚点必须来自**真正进 prompt 的那个裁剪点**。锚点比回放窗口新，
  // 中间那段就既没进摘要也没进回放。
  assert.ok(
    through + 1n >= inlineFrom,
    `摘要覆盖到 ${through}，可回放从 ${inlineFrom} 才开始：${Number(inlineFrom - through - 1n)} 条消息没人代表`,
  );
});

test("早期那条关键事实：不在回放里，就必须落在摘要链的连续覆盖内", async () => {
  const startedAt = new Date(Date.now() - 3 * 24 * 3_600_000);
  if (seeded.length < 300) await seedTurns(150, startedAt);
  const inline = await measureInlineWindow();
  const summary = await measureSummaryCoverage(await latestSummaryThroughSeq());
  const factSeq = seeded.find((row) => row.text === EARLY_FACT)?.seq ?? 0n;
  const topicSeq = seeded.find((row) => row.text === EARLY_TOPIC)?.seq ?? 0n;
  const through = BigInt(summary.coverageThroughSeq ?? "0");
  const chainFrom = BigInt(summary.coverageFromSeq ?? "0");

  log("\n=== 关键事实存活 ===");
  log(`第 3 轮 Momo 复查 seq=${factSeq}：inline=${inline.inlineText.includes("Momo")} 本次摘要切片=[${chainFrom}..${through}]`);
  log(`第 6 轮 爵士 transcribe seq=${topicSeq}：inline=${inline.inlineText.includes("transcribe")}`);
  log(`回放实际带回：${inline.takenCount} 条 / ${inline.usedTokens} tok（容量 ${inline.capacityTokens}），回执省略 ${inline.omittedCount} 条，未覆盖到 seq=${inline.uncoveredThroughSeq}`);

  // 这一条量的是**代表关系**：seq=5 那条不可能还在回放窗口里（窗口只带走最近 2,048 tok），
  // 那它必须落在"有人替她记着"的那一段里——也就是摘要接续链的有效覆盖。
  // 链是逐段往上折的，折进去的正文保不失真不在这一条的判据里（那要真模型，见 live-tests 的折叠探针）。
  const chainCoversFromOldest = chainFrom <= 1n || through + 1n === BigInt(inline.inlineFromSeq ?? "0");
  assert.ok(
    chainCoversFromOldest,
    `第 3 轮那句既不在回放（起点 seq=${inline.inlineFromSeq}），本次摘要也没接到会话开头（切片起点 ${chainFrom}）`,
  );
  assert.ok(through + 1n === BigInt(inline.inlineFromSeq ?? "0"),
    `摘要盖到 ${through}，回放却从 ${inline.inlineFromSeq} 起：中间 ${BigInt(inline.inlineFromSeq ?? "0") - through - 1n} 条没人代表`);
});

test("一条长回复把整个回放窗口挤掉：预算没用完，历史却归零", async () => {
  const startedAt = new Date(Date.now() - 3 * 24 * 3_600_000);
  await seedTurns(150, startedAt);
  // 最近一轮的助手回写成一篇长文（笔记／讲解是常态输出）。
  const longText = "这一份是完整的讲解稿：".concat("先建立句子的骨架，再往里填修饰与语气，最后朗读一遍确认停顿是否自然。".repeat(60));
  const seq = 301;
  await admin`
    INSERT INTO companion_messages
      (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, content_sha256, created_at)
    VALUES (${randomUUID()}, ${workspaceId}, ${userId}, ${conversationId}, ${seq},
            'assistant', 'text', ${admin.json([{ type: "text", text: longText }])},
            ${createHash("sha256").update(longText).digest("hex")}, now())
  `;
  await admin`UPDATE companion_conversations SET next_message_seq = 302 WHERE id = ${conversationId}`;
  seeded.push({ seq: BigInt(seq), role: "assistant", text: longText, turn: 151 });

  const inline = await measureInlineWindow();
  log("\n=== 尾部出现一篇长文之后 ===");
  log(`带回 ${inline.takenCount} 条 / 用掉 ${inline.usedTokens} tok（容量 ${inline.capacityTokens}，剩余 ${inline.capacityTokens - inline.usedTokens}）`);
  log(`回执说省略了 ${inline.omittedCount} 条，未覆盖到 seq=${inline.uncoveredThroughSeq}；库里实际 ${inline.totalMessages} 条，可见池 ${inline.visiblePool} 条`);

  assert.ok(inline.takenCount > 0,
    `尾部那篇长文一塞不下就整段清零：带回 ${inline.takenCount} 条，容量 ${inline.capacityTokens} 一条没用（她连自己上一句都看不见）`);
  assert.equal(inline.inlineText.includes("这一份是完整的讲解稿"), false,
    "整条超窗口的正文不该被剪进窗口——剪过的字她会照着说");
  assert.ok(inline.usedTokens <= inline.capacityTokens, "跳过超长那条之后仍然不许超预算");
});

/**
 * 折叠必须**接得上上一份摘要**（2026-10-14 的真实缺陷）。
 *
 * 判据按库里的形状给，不按理想化的均匀流给：那条 565 条的真实会话里，上一份摘要盖到
 * 321、本次折叠从 440 起，中间 119 条谁都不负责——而注入的摘要自称「更早那段对话」。
 * 旧的分页判据是「读出一段覆盖就停」，每轮最多折一页（100 条），回放裁剪点跑得比一页
 * 快时就会留下这种洞，所以前面那两条 150 轮的用例量不出来。
 */
test("上一份只盖到 100：本次折叠要接上它，不许从 201 起", async () => {
  const startedAt = new Date(Date.now() - 3 * 24 * 3_600_000);
  if (seeded.length < 300) await seedTurns(150, startedAt);
  const previousId = randomUUID();
  await admin`
    INSERT INTO conversation_summaries
      (id, workspace_id, user_id, conversation_id, summary,
       coverage_from_seq, coverage_through_seq, coverage_source_hash, verified_context_revision)
    VALUES (${previousId}, ${workspaceId}, ${userId}, ${conversationId},
            ${admin.json({ title: "最早那一段" })}, 1, 100, ${"a".repeat(64)}, 1)
  `;

  const previous = await latestSummaryThroughSeq();
  assert.equal(previous, "100", "夹具插进去的那一份要读得到");
  const summary = await measureSummaryCoverage(previous);
  const inline = await measureInlineWindow();
  const from = BigInt(summary.coverageFromSeq ?? "0");
  log("\n=== 折叠接得上上一份 ===");
  log(`上一份盖到 ${previous}；本次切片=[${summary.coverageFromSeq}..${summary.coverageThroughSeq}]，`
    + `回放从 ${inline.inlineFromSeq} 起，带回 ${inline.takenCount} 条 / ${inline.usedTokens} tok`);

  assert.ok(from <= 101n,
    `上一份盖到 100，本次切片却从 ${from} 起：中间 ${Number(from - 101n)} 条既没进摘要也没进回放`);
  assert.ok(BigInt(summary.coverageThroughSeq ?? "0") + 1n >= BigInt(inline.inlineFromSeq ?? "0"),
    `折叠完仍然有洞：摘要盖到 ${summary.coverageThroughSeq}，回放却从 ${inline.inlineFromSeq} 起`);

  // 把这一刀实际会写出的那一段插回去（测量只算不写），链读回来必须接得上。
  const foldedId = randomUUID();
  await admin`
    INSERT INTO conversation_summaries
      (id, workspace_id, user_id, conversation_id, summary,
       coverage_from_seq, coverage_through_seq, coverage_source_hash, verified_context_revision, parent_summary_id)
    VALUES (${foldedId}, ${workspaceId}, ${userId}, ${conversationId},
            ${admin.json({ title: "接上的那一段" })},
            ${summary.coverageFromSeq}, ${summary.coverageThroughSeq}, ${"b".repeat(64)}, 1, ${previousId})
  `;
  const chain = await withWorkerWorkspaceTransaction({ workspaceId, userId },
    tx => readConversationSummaryChain(tx, conversationId));
  assert.equal(chain.head?.coverage_through_seq, summary.coverageThroughSeq,
    "链头应当是刚折出来的那一份");
  assert.equal(chain.effectiveCoverageFromSeq, "1", "两段接起来要覆盖到会话开头");
  assert.deepEqual(chain.gaps, [], "接得上就不该有洞");

  await admin`DELETE FROM conversation_summaries WHERE id IN (${previousId}, ${foldedId})`;
});

/**
 * 库里已经存在的那种形状（2026-10-14 实测）：两份摘要都把手挂在最早那一份底下、
 * 中间 430 条谁都不负责。读取侧现在按覆盖区间读，所以这件事**必须报得出洞**——
 * 报不出来的话，注入的摘要就在自称「更早那段对话」。
 */
test("两份摘要之间断了 430 条：链读回来要报出这一格，不谎报全覆盖", async () => {
  const rootId = randomUUID();
  const headId = randomUUID();
  await admin`
    INSERT INTO conversation_summaries
      (id, workspace_id, user_id, conversation_id, summary,
       coverage_from_seq, coverage_through_seq, coverage_source_hash, verified_context_revision)
    VALUES (${rootId}, ${workspaceId}, ${userId}, ${conversationId},
            ${admin.json({ title: "最早那一份" })}, 1, 9, ${"c".repeat(64)}, 1)
  `;
  await admin`
    INSERT INTO conversation_summaries
      (id, workspace_id, user_id, conversation_id, summary,
       coverage_from_seq, coverage_through_seq, coverage_source_hash,
       verified_context_revision, parent_summary_id)
    VALUES (${headId}, ${workspaceId}, ${userId}, ${conversationId},
            ${admin.json({ title: "最近那一份" })}, 440, 541, ${"d".repeat(64)}, 1, ${rootId})
  `;
  const chain = await withWorkerWorkspaceTransaction({ workspaceId, userId },
    tx => readConversationSummaryChain(tx, conversationId));
  log("\n=== 断裂的链 ===");
  log(`depth=${chain.depth} 有效覆盖=[${chain.effectiveCoverageFromSeq}..${chain.effectiveCoverageThroughSeq}] `
    + `洞=${chain.gaps.map(gap => `${gap.fromSeq}–${gap.throughSeq}`).join(",") || "无"}`);

  assert.equal(chain.depth, 2, "两份都读回来了（不再沿父指针只走到最早那一份）");
  assert.equal(chain.head?.id, headId, "链头是覆盖最靠后的那一份");
  assert.deepEqual(chain.gaps, [{ fromSeq: "10", throughSeq: "439" }]);

  await admin`DELETE FROM conversation_summaries WHERE id IN (${rootId}, ${headId})`;
});

/**
 * 0433 的那道判定：改写一条消息，只作废**覆盖到它**的那几份摘要。
 *
 * 旧写法是拿会话修订号做等值比较——改一条就把这个会话所有旧摘要一起读不到。
 * 真实数据里那条 565 条的会话改过 3 次消息，15 份摘要 13 份因此消失，而 prompt
 * 里连「这一段没读过」都没有。
 */
test("改写一条消息：只有盖住它的那一份作废，其余照读", async () => {
  const earlyId = randomUUID();
  const touchedId = randomUUID();
  await admin`
    INSERT INTO conversation_summaries
      (id, workspace_id, user_id, conversation_id, summary,
       coverage_from_seq, coverage_through_seq, coverage_source_hash, verified_context_revision)
    VALUES (${earlyId}, ${workspaceId}, ${userId}, ${conversationId},
            ${admin.json({ title: "前一百条" })}, 1, 100, ${"e".repeat(64)}, 1)
  `;
  await admin`
    INSERT INTO conversation_summaries
      (id, workspace_id, user_id, conversation_id, summary,
       coverage_from_seq, coverage_through_seq, coverage_source_hash, verified_context_revision)
    VALUES (${touchedId}, ${workspaceId}, ${userId}, ${conversationId},
            ${admin.json({ title: "中间那一百条" })}, 101, 200, ${"f".repeat(64)}, 1)
  `;

  const revisionBefore = await admin<{ context_revision: string }[]>`
    SELECT context_revision::text FROM companion_conversations WHERE id = ${conversationId}`;
  // 改的是 seq=150 那一条——只有 101–200 那一份盖住它。走真实 UPDATE：0420 起
  // 触发器只认 `blocks`／`content_sha256` 这类内容列（`follow_up_prompts` 那种
  // 附带写入不该把整段历史判成过期）。
  await admin`
    UPDATE companion_messages
       SET blocks = ${admin.json([{ type: "text", text: "这一条被改写过了" }])},
           content_sha256 = ${createHash("sha256").update("这一条被改写过了").digest("hex")},
           edited_at = now()
     WHERE conversation_id = ${conversationId} AND seq = 150
  `;

  const stamped = await admin<{ id: string; invalidated: boolean }[]>`
    SELECT id, (invalidated_at IS NOT NULL) AS invalidated
    FROM conversation_summaries WHERE id IN (${earlyId}, ${touchedId})
  `;
  const byId = new Map(stamped.map(row => [row.id, row.invalidated]));
  log("\n=== 区间级失效 ===");
  log(`盖住 seq=150 的那一份作废=${byId.get(touchedId)}；没盖住的=${byId.get(earlyId)}`);
  assert.equal(byId.get(touchedId), true, "被碰到的那段必须作废——摘要不能再冒充原文");
  assert.equal(byId.get(earlyId), false, "没被碰到的段不许陪着一起消失");

  const revisionAfter = await admin<{ context_revision: string }[]>`
    SELECT context_revision::text FROM companion_conversations WHERE id = ${conversationId}`;
  assert.notEqual(revisionAfter[0]?.context_revision, revisionBefore[0]?.context_revision,
    "会话修订号照旧前进：折叠在途那道围栏依赖它");

  const chain = await withWorkerWorkspaceTransaction({ workspaceId, userId },
    tx => readConversationSummaryChain(tx, conversationId));
  assert.equal(chain.head?.id, earlyId, "读回来的链头应当是仍然有效的那一份");

  await admin`DELETE FROM conversation_summaries WHERE id IN (${earlyId}, ${touchedId})`;
});
