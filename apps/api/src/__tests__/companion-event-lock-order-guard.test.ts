import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * 伴星事件链的**取锁顺序守卫**（2026-10-14 死锁后补）。
 *
 * ## 它挡的是哪次真事故
 *
 * dev 库实测两例 `deadlock detected`（postgres 容器日志）：用户发一句话，turn 直接
 * `INTERNAL_ERROR`、run 被标 failed，界面表现是"她没回"。成因是同一件事的两种取锁序：
 *
 *   A 序：先锁 `companion_conversations`（拿 `next_event_seq`），再 INSERT
 *         `companion_stream_events`——而这张表的 AFTER INSERT 触发器会顺手
 *         `UPDATE companion_turn_runs`，于是**在看不见的地方**又拿了一次 run 行锁。
 *   B 序：先锁 `companion_turn_runs` 做活性检查，再回去拿会话计数器。
 *
 * A、B 并发即 AB-BA。修法是把全仓统一到 B 序（`@astella/shared/companion-lock-order`）。
 *
 * ## 判据为什么是「逐处声明锚点对」，而不是一条全局正则
 *
 * 我一开始试过「全文第一个 run 锁必须在第一个会话锁之前」，它有两种系统性误报：
 *   1. `SELECT … FROM companion_turn_runs … JOIN companion_conversations … FOR UPDATE OF r`
 *      只锁 run 行，但正则会把 JOIN 里的 conversations 当成会话锁；
 *   2. `companion-proposal-expiry.ts` 里 `appendActionExpiredEventsBatch`（碰会话计数器）
 *      在**文件**里定义于 `reclaimExpiredCompanionProposals` 之前，可事务里的执行顺序
 *      恰恰是后者先取锁。
 * 文件顺序 ≠ 事务顺序，所以判据必须落到「同一事务里谁先」——即每个写入点各自声明
 * 「run 锁的形状」与「会话锁的形状」，断言前者先出现。声明本身就是文档：
 * 打开失败列表的人能直接看到这一处该是什么顺序。
 *
 * ## 棘轮
 *
 * 凡是**写会话行**（`UPDATE companion_conversations` / `.update(companionConversations)`）
 * 的文件都必须登记进 `SITES`。新增写入点必须同时声明它的取锁顺序——这正是本守卫要的
 * 那个决定，而不是让它在死锁发生后才被发现。
 */

const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;

type LockOrderSite = {
  /** 仓库相对路径。 */
  file: string;
  /** run 行锁的形状（在事务里应当先出现）。 */
  runLock?: RegExp;
  /**
   * 这个文件**只锁会话行、从不碰 run 行**——没有对可成环，因此不需要 run 锁。
   * 置真时必须同时断言「真的没碰 run 行」，防止它悄悄变成 A 序。
   */
  conversationsOnly?: boolean;
  /** 会话行锁的形状。 */
  conversationLock: RegExp;
  /** 这一处为什么安全——写给人看的，改顺序时先改这里。 */
  why: string;
};

/** `FOR UPDATE OF r` 只锁 r 指向的表；r 是 companion_turn_runs 时不会碰会话行。 */
const SITES: LockOrderSite[] = [
  // ─── worker ───────────────────────────────────────────────────────────────
  {
    file: "workers/ai-worker/src/handlers/companion-agent-events.ts",
    runLock: /lockCompanionRunForEventWrite\(/,
    conversationLock: /UPDATE\s+companion_conversations/,
    why: "appendAgentEvent 写的是 agent.tool（会触发器），必须先锁 run 行",
  },
  {
    file: "workers/ai-worker/src/handlers/companion-agent-proposal.ts",
    runLock: /lockCompanionRunForEventWrite\(/,
    conversationLock: /UPDATE\s+companion_conversations/,
    why: "建言事务先锁 run，围栏 UPDATE 与计数器都在其后",
  },
  {
    file: "workers/ai-worker/src/handlers/companion-followup-suggestions-job.ts",
    runLock: /lockCompanionRunForEventWrite\(/,
    conversationLock: /UPDATE\s+companion_conversations/,
    why: "追问建议先锁 run；末尾还要写 last_event_seq",
  },
  {
    file: "workers/ai-worker/src/handlers/companion-dialogue-deltas.ts",
    runLock: /UPDATE\s+companion_turn_runs/,
    conversationLock: /UPDATE\s+companion_conversations/,
    why: "流式增量本就先做活性检查再分配 seq",
  },
  {
    file: "workers/ai-worker/src/handlers/companion-dialogue-stream.ts",
    runLock: /UPDATE\s+companion_turn_runs/,
    conversationLock: /UPDATE\s+companion_conversations/,
    why: "整段流式收尾同样先锁 run",
  },
  {
    file: "workers/ai-worker/src/handlers/companion-thinking-stream.ts",
    runLock: /UPDATE\s+companion_turn_runs/,
    conversationLock: /UPDATE\s+companion_conversations/,
    why: "思考流写 assistant.thinking（会触发器），先锁 run",
  },
  {
    file: "workers/ai-worker/src/handlers/companion-dialogue-store.ts",
    runLock: /UPDATE\s+companion_turn_runs/,
    conversationLock: /UPDATE\s+companion_conversations/,
    why: "状态帧/取消/失败收尾几个事务都是先锁 run 再分配 seq",
  },
  {
    file: "workers/ai-worker/src/handlers/companion-dialogue.ts",
    runLock: /UPDATE\s+companion_turn_runs/,
    conversationLock: /UPDATE\s+companion_conversations/,
    why: "轮次收尾先锁 run 再写会话",
  },
  {
    file: "workers/ai-worker/src/handlers/companion-participation-tools.ts",
    runLock: /UPDATE\s+companion_turn_runs/,
    conversationLock: /UPDATE\s+companion_conversations/,
    why: "相处偏好写入先确认 run 活着再分配 seq",
  },
  {
    file: "workers/ai-worker/src/handlers/companion-dialogue-failure-retention.ts",
    runLock: /SELECT id FROM companion_turn_runs[\s\S]{0,400}?FOR UPDATE/,
    conversationLock: /UPDATE\s+companion_conversations/,
    why: "失败留档第一句就是 run 行的 SELECT … FOR UPDATE（行号看着 conv 在前，事务顺序不是）",
  },
  {
    file: "workers/ai-worker/src/handlers/companion-initiative.ts",
    runLock: /INSERT\s+INTO\s+companion_turn_runs/,
    conversationLock: /UPDATE\s+companion_conversations/,
    why: "主动交流新建的是**新** run 行，不锁任何已存在的 run 行，构不成 AB-BA",
  },
  {
    file: "workers/ai-worker/src/handlers/companion-summarizer.ts",
    conversationsOnly: true,
    conversationLock: /SELECT id FROM companion_conversations[\s\S]{0,240}?FOR UPDATE/,
    why: "摘要提交只锁会话行（父围栏要串行化读链头→插入），从不碰 run 行，故无对可成环",
  },
  // ─── api ──────────────────────────────────────────────────────────────────
  {
    file: "apps/api/src/modules/companion-conversation/learning-action-bridge.ts",
    runLock: /lockCompanionConversationWaitingRuns\(/,
    conversationLock: /SELECT id, kind, status FROM companion_conversations/,
    why: "建言与确认两条链都在锁会话行 FOR UPDATE 之前先锁待确认的 run 行",
  },
  {
    file: "apps/api/src/modules/companion-conversation/turn/companion-proposal-expiry.ts",
    runLock: /lockCompanionConversationWaitingRuns\(/,
    conversationLock: /await appendActionExpiredEventsBatch\(tx,/,
    why: "回收先锁本会话的待确认 run 行，再发 action.expired 事件（碰计数器）",
  },
  {
    file: "apps/api/src/modules/companion-conversation/turn/companion-cancel.ts",
    runLock: /\.update\(companionTurnRuns\)/,
    conversationLock: /\.update\(companionConversations\)/,
    why: "取消先落 cancel_requested，再写 turn.cancelled 事件",
  },
  {
    file: "apps/api/src/modules/companion-conversation/turn/companion-cancelled-retention.ts",
    runLock: /SELECT id FROM companion_turn_runs[\s\S]{0,400}?FOR UPDATE/,
    conversationLock: /UPDATE\s+companion_conversations/,
    why: "留档第一句是 run 行的 SELECT … FOR UPDATE（认领）",
  },
  {
    file: "apps/api/src/modules/companion-conversation/turn/turn-service.ts",
    runLock: /\.update\(companionTurnRuns\)/,
    conversationLock: /\.update\(companionConversations\)/,
    why: "发轮先把旧 run 置 superseded（含 reclaim 内的 run 锁），再分配会话 seq",
  },
  {
    file: "apps/api/src/modules/companion-conversation/memory/continuous-history-service.ts",
    runLock: /FROM companion_turn_runs r\s*\n\s*JOIN companion_conversations c ON c\.id = r\.conversation_id[\s\S]{0,300}?FOR UPDATE OF r/,
    conversationLock: /SELECT id FROM companion_conversations\s*\n\s*WHERE workspace_id/,
    why: "清理要 DELETE run 行，所以先 FOR UPDATE OF r 锁住它们，再锁会话行",
  },
];

test("每个写会话行的文件都登记在册（棘轮：新增写入点必须同时声明取锁顺序）", () => {
  const roots = ["workers/ai-worker/src", "apps/api/src", "packages/agent-host/src"];
  const pattern = /UPDATE\s+companion_conversations|\.update\(\s*companionConversations\s*\)/;
  const declared = new Set(SITES.map((site) => site.file));
  const offenders: string[] = [];
  for (const root of roots) {
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "__tests__") continue;
          // live-tests/ 是一次性评测探针（自己造夹具、跑完即弃），不进生产取锁路径。
          if (entry.name === "live-tests") continue;
          walk(rel);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.includes(".test.")) continue;
        // 集成测试自带夹具与隔离库，不参与生产取锁顺序。
        if (rel.includes("integration-tests")) continue;
        if (!pattern.test(readFileSync(join(REPO_ROOT, rel), "utf8"))) continue;
        if (!declared.has(rel)) offenders.push(rel);
      }
    };
    walk(root);
  }
  assert.deepEqual(offenders, [],
    `这些文件在写 companion_conversations，却没声明自己的取锁顺序：\n${offenders.join("\n")}\n`
    + "请在 SITES 里登记，并写清 run 行锁与会话行锁各是什么形状、谁先。");
});

/** run 行被写的形状——用于「只锁会话」档的反向断言。 */
const RUN_WRITE = /UPDATE\s+companion_turn_runs|\.update\(\s*companionTurnRuns\s*\)|INSERT\s+INTO\s+companion_turn_runs|DELETE\s+FROM\s+companion_turn_runs|insertStreamEvent\(/;

for (const site of SITES) {
  test(`${site.file} 的事务里，run 行锁先于会话行锁`, () => {
    const source = readFileSync(join(REPO_ROOT, site.file), "utf8");
    const conversationLock = site.conversationLock.exec(source);
    assert.ok(conversationLock, `${site.file} 里找不到会话行锁——守卫的扫描范围要跟着代码搬走`);

    if (site.conversationsOnly) {
      // 「只锁会话」是一条**反向**判据：一旦这个文件开始碰 run 行，它就可能成环，
      // 必须改登记成 run-first，而不是继续躲在这一档里。
      assert.equal(RUN_WRITE.test(source), false,
        `${site.file} 现在会碰 run 行/写事件了，却还登记在「只锁会话」档。`
        + `改登记成 run-first 并写清顺序。这一处的理由是：${site.why}`);
      return;
    }

    assert.ok(site.runLock, `${site.file} 必须声明 run 行锁的形状`);
    const conversationIndex = conversationLock.index;
    // 只认**在会话行锁之前**出现的 run 锁：全文第一处可能在别的事务里。
    const runLock = [...source.matchAll(new RegExp(site.runLock.source, "g"))]
      .find((match) => (match.index ?? 0) < conversationIndex);
    assert.ok(runLock,
      `${site.file} 里，会话行锁之前没有 run 行锁——这一处就是 A 序：`
      + "它会先锁会话行、再（直接或经触发器）锁 run 行，与「先锁 run 再拿会话计数器」"
      + "的路径并发即 AB-BA 死锁（2026-10-14 dev 库实测两例，用户那一轮直接 INTERNAL_ERROR）。"
      + `这一处原本的理由是：${site.why}`);
  });
}

/**
 * 四表全序的第二段：`companion_action_proposals` 必须先于 `companion_agent_tool_calls`。
 *
 * 第一段（run → conversations）挡住的是那两例已观测死锁；这一段挡的是**同一条 proposal
 * 的作废**——cancel（用户取消）、invalidateSupersededRunProposals（新消息 supersede）、
 * reclaim（TTL 过期）三条路径都会把 proposal 置 expired 并作废它的审计行。三条里只要
 * 有一条先拿 tool_calls、其余先拿 proposals，同一条 run 上就是 AB-BA。
 * 2026-10-14 那轮只审了 run/会话两表，漏了这一对。
 */
const PROPOSAL_SITES: Array<{ file: string; proposalFirst: RegExp; toolCallFirst: RegExp; why: string }> = [
  {
    file: "apps/api/src/modules/companion-conversation/turn/companion-cancel.ts",
    proposalFirst: /UPDATE\s+companion_action_proposals/,
    toolCallFirst: /UPDATE\s+companion_agent_tool_calls/,
    why: "取消时作废 proposal 与其审计行，proposals 先",
  },
  {
    // 这个文件里 `terminateProposalSideEffects` 在 line 60 **定义**、在 reclaim 里
    // 才**调用**——按全文文本比顺序会把"定义在前"误判成反序。所以锚点用**调用处**。
    file: "apps/api/src/modules/companion-conversation/turn/companion-proposal-expiry.ts",
    proposalFirst: /UPDATE\s+companion_action_proposals/,
    toolCallFirst: /await terminateProposalSideEffects\(/,
    why: "回收先 UPDATE proposal，再调用作废审计行的函数，proposals 先，与 cancel 同向",
  },
  {
    file: "apps/api/src/modules/companion-conversation/learning-action-bridge.ts",
    proposalFirst: /FROM companion_action_proposals[\s\S]{0,200}?FOR UPDATE/,
    toolCallFirst: /UPDATE\s+companion_agent_tool_calls/,
    why: "确认路径先锁 proposal 行（FOR UPDATE），再动审计行",
  },
];

for (const site of PROPOSAL_SITES) {
  test(`${site.file} 的事务里，proposals 先于 tool_calls`, () => {
    const source = readFileSync(join(REPO_ROOT, site.file), "utf8");
    const toolCallFirst = site.toolCallFirst.exec(source);
    assert.ok(toolCallFirst, `${site.file} 里找不到 tool_calls 写点——守卫要跟着代码搬`);
    const toolIndex = toolCallFirst.index;
    const proposalLock = [...source.matchAll(new RegExp(site.proposalFirst.source, "g"))]
      .find((match) => (match.index ?? 0) < toolIndex);
    assert.ok(proposalLock,
      `${site.file} 里，tool_calls 写点之前没有 proposals 锁——这就是 TOOL→PROP 反序：`
      + "cancel / invalidate / reclaim 三条作废路径只要有一条反向，同一条 proposal 上就 AB-BA。"
      + `这一处的理由是：${site.why}`);
  });
}

test("invalidateSupersededRunProposals 函数体内，proposals 先于 tool_calls", () => {
  const source = readFileSync(join(REPO_ROOT, "apps/api/src/modules/companion-conversation/turn/companion-proposal-expiry.ts"), "utf8");
  const start = source.indexOf("export async function invalidateSupersededRunProposals(");
  assert.ok(start > 0, "找不到 invalidateSupersededRunProposals");
  // 取到函数体结束（下一行顶格的 }）。
  const end = source.indexOf("\n}", start);
  const body = source.slice(start, end > 0 ? end : source.length);
  const prop = body.search(/UPDATE\s+companion_action_proposals/);
  const tool = body.search(/UPDATE\s+companion_agent_tool_calls/);
  assert.ok(prop >= 0 && tool >= 0, "函数体里两条 UPDATE 都要能找到");
  assert.ok(prop < tool,
    "invalidateSupersededRunProposals 内部是 TOOL→PROP 反序：它是 supersede 时的作废路径，"
    + "与 cancel.ts 的作废段是同一件事的两种触发，次序必须一致，否则同一条 run 上 AB-BA。");
});

test("turn-service 建轮路径在锁会话行之前先锁 run 行（drizzle .for(\"update\") 也算锁）", () => {
  const source = readFileSync(join(REPO_ROOT, "apps/api/src/modules/companion-conversation/turn/turn-service.ts"), "utf8");
  // 这一条是 2026-10-14 那轮的**误判**：当时只比 441/522 两处 UPDATE 的行号，
  // 漏了建轮事务开头那句 drizzle 的 `.for("update")`——它才是本事务的第一把会话锁。
  const convLock = source.indexOf('.for("update")');
  assert.ok(convLock > 0, "找不到建轮路径的会话行锁");
  assert.match(source.slice(0, convLock), /lockCompanionConversationLifecycleRuns\(/,
    "建轮事务第一句必须先锁本会话的 run 行：它随后要 supersede 在跑的 run、"
    + "reclaim 待确认的 run，两者都是 run 行锁；不预锁就是「先会话后 run」的 A 序，"
    + "与所有流式路径并发即 AB-BA（2026-10-14 同一形状）。");
});

test("run 锁 helper 与它挡的事故留在同一处声明", () => {
  const source = readFileSync(join(REPO_ROOT, "packages/shared/src/companion-lock-order.ts"), "utf8");
  // 规约本体不能被悄悄挪走：helper、事故日期、两种序的名字都要在。
  assert.match(source, /lockCompanionRunForEventWrite/);
  assert.match(source, /lockCompanionConversationWaitingRuns/);
  assert.match(source, /lockCompanionConversationLifecycleRuns/);
  assert.match(source, /2026-10-14/);
  assert.match(source, /companion_archive_process_event/);
  assert.match(source, /FOR NO KEY UPDATE/);
});
