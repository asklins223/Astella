import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeSummaryChain, type SummaryChainNode } from "../turn/companion-dialogue-store.ts";
import {
  renderConversationSummary,
} from "../context/companion-summarizer.ts";

/**
 * 方案 44 §5.2：只取最新一份摘要会把更早的覆盖索引丢掉。
 * 这条判定是纯函数，所以「链上有没有洞」可以脱离数据库直接验收。
 */
const node = (over: Partial<SummaryChainNode> & Pick<SummaryChainNode, "id" | "depth" | "coverage_from_seq" | "coverage_through_seq">): SummaryChainNode => ({
  revision: 1,
  parent_summary_id: null,
  summary: { title: "一段" },
  coverage_source_hash: "a".repeat(64),
  ...over,
} as SummaryChainNode);

test("44 §5.2：接续链回溯后真实覆盖起点比链头自己那一段更早", () => {
  const view = summarizeSummaryChain([
    node({ id: "c", depth: 1, coverage_from_seq: "30", coverage_through_seq: "48" }),
    node({ id: "b", depth: 2, parent_summary_id: "a", coverage_from_seq: "12", coverage_through_seq: "29" }),
    node({ id: "a", depth: 3, parent_summary_id: null, coverage_from_seq: "3", coverage_through_seq: "11" }),
  ]);
  assert.equal(view.head?.id, "c");
  assert.equal(view.depth, 3);
  // 不能拿链头自己的 from 当作「摘要盖到多早」。
  assert.equal(view.effectiveCoverageThroughSeq, "48");
  assert.equal(view.effectiveCoverageFromSeq, "3");
  assert.deepEqual(view.gaps, [], "首尾相接的链没有洞");
});

test("44 §5.2：链上跳过一次压缩时如实报出没盖住的区间", () => {
  const view = summarizeSummaryChain([
    node({ id: "c", depth: 1, coverage_from_seq: "30", coverage_through_seq: "48" }),
    // 20..29 这一段没有任何摘要——上一次压缩输出不合规被跳过了。
    node({ id: "a", depth: 2, parent_summary_id: null, coverage_from_seq: "3", coverage_through_seq: "19" }),
  ]);
  assert.deepEqual(view.gaps, [{ fromSeq: "20", throughSeq: "29" }]);
  assert.equal(view.effectiveCoverageFromSeq, "3");
});

test("44 §5.2：只取最新一份而不回溯，就会谎报更早的覆盖", () => {
  const head = node({ id: "c", depth: 1, coverage_from_seq: "30", coverage_through_seq: "48" });
  const naive = summarizeSummaryChain([head]);
  assert.equal(naive.effectiveCoverageFromSeq, "30");
  const traced = summarizeSummaryChain([
    head,
    node({ id: "a", depth: 2, parent_summary_id: null, coverage_from_seq: "3", coverage_through_seq: "29" }),
  ]);
  assert.equal(traced.effectiveCoverageFromSeq, "3");
});

test("44 §5.2：相邻区间（through + 1 = from）不算洞", () => {
  const view = summarizeSummaryChain([
    node({ id: "b", depth: 1, coverage_from_seq: "20", coverage_through_seq: "29" }),
    node({ id: "a", depth: 2, parent_summary_id: null, coverage_from_seq: "3", coverage_through_seq: "19" }),
  ]);
  assert.deepEqual(view.gaps, []);
});

test("44 §5.2：链上只有链头时，缺口判定仍然成立（不伪造更早的覆盖）", () => {
  const view = summarizeSummaryChain([node({ id: "solo", depth: 1, coverage_from_seq: "5", coverage_through_seq: "9" })]);
  assert.equal(view.depth, 1);
  assert.equal(view.effectiveCoverageFromSeq, "5");
  assert.deepEqual(view.gaps, []);
  assert.deepEqual(summarizeSummaryChain([]).head, null);
});

test("a skipped message inside a snapshot remains an explicit coverage gap", () => {
  const view = summarizeSummaryChain([node({ id: "head", depth: 1, coverage_from_seq: "1", coverage_through_seq: "9",
    coverage_manifest: { uncovered: [{ fromSeq: 4, throughSeq: 4 }] } })]);
  assert.deepEqual(view.gaps, [{ fromSeq: "4", throughSeq: "4" }]);
});

test("actual inherited ranges report gaps without treating unrelated summaries as read", () => {
  // This pure fold receives a real ancestor chain. Siblings are excluded by the
  // database reader; the PostgreSQL review regression verifies that boundary.
  const view = summarizeSummaryChain([
    node({ id: "new", depth: 1, parent_summary_id: "mid", coverage_from_seq: "440", coverage_through_seq: "541" }),
    node({ id: "mid", depth: 2, parent_summary_id: "root", coverage_from_seq: "217", coverage_through_seq: "321" }),
    node({ id: "root", depth: 3, parent_summary_id: null, coverage_from_seq: "1", coverage_through_seq: "9" }),
  ]);
  assert.equal(view.head?.id, "new");
  assert.equal(view.effectiveCoverageThroughSeq, "541");
  assert.equal(view.effectiveCoverageFromSeq, "1");
  assert.deepEqual(view.gaps, [
    { fromSeq: "322", throughSeq: "439" },
    { fromSeq: "10", throughSeq: "216" },
  ]);
});

test("44 §5.5：摘要盖到 541、回放从 561 起，注入块要点名中间那 19 条", () => {
  const block = renderConversationSummary(
    { title: "一段方言笑话", keyEvents: ["讲过两回笑话"] },
    {
      coverageVerified: true,
      coverageGaps: [{ fromSeq: "542", throughSeq: "560" }, { fromSeq: "322", throughSeq: "439" }],
    },
  );
  assert.match(block!, /更早还有 2 段没有任何摘要覆盖/);
  // 最近的那一段排在第一个——她这一轮最可能谈到的就是刚被挤出窗口的那些。
  assert.match(block!, /消息 542–560/);
  assert.match(block!, /companion_observe/);
});

test("44 §5.5：注入块带上覆盖缺口，并给出**怎么取回**——只说有洞等于把边界推给日志", () => {
  const block = renderConversationSummary(
    { title: "聊过三次复习计划", keyEvents: ["排了周五"], followUps: ["要不要换成周末"] },
    { coverageVerified: true, coverageGaps: [{ fromSeq: "20", throughSeq: "29" }] },
  );
  assert.match(block!, /更早还有 1 段没有任何摘要覆盖/);
  assert.match(block!, /别把摘要当成读过/);
  // 入口必须具体到工具与参数，否则模型知道「有洞」却不知道怎么补。
  assert.match(block!, /companion_observe/);
  assert.match(block!, /fromSeq/);
  assert.match(block!, /20/);
  assert.ok(block!.endsWith("</conversation_summary>"));
});

test("44 §4.4：没有缺口时不说缺口——正常回答不固定插入截断声明", () => {
  const block = renderConversationSummary({ title: "一次讨论" }, { coverageVerified: true });
  assert.ok(!block!.includes("没有任何摘要覆盖"));
  // 没有洞就不提取回入口：那是正常情况，不是限制。
  assert.ok(!block!.includes("companion_observe"));
});

// ─── 44 §4.4：注入上限是容量，不再是截断点 ──────────────────────────────

const fullSummary = {
  title: "桌宠功能调试与用户偏好设置",
  keyEvents: Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 件事：把偏好改成了语音优先`),
  followUps: Array.from({ length: 8 }, (_, i) => `待办 ${i + 1}：确认周末复习要不要继续`),
  userPreferences: Array.from({ length: 6 }, (_, i) => `偏好 ${i + 1}：希望回答简短一点`),
};

test("summary rendering never drops optional facts to meet a character target", () => {
  const block = renderConversationSummary(fullSummary, { coverageVerified: true })!;
  for (const value of [...fullSummary.keyEvents, ...fullSummary.followUps, ...fullSummary.userPreferences]) assert.ok(block.includes(value));
  assert.ok(block.endsWith("</conversation_summary>"));
  for (const maxChars of [1, 260, 400]) assert.equal(renderConversationSummary(fullSummary, { coverageVerified: true, maxChars }), null);
});

test("44 §4.4：没有可选项时也能成立（只有标题与边界声明）", () => {
  const block = renderConversationSummary({ title: "只有标题" }, { coverageVerified: false });
  assert.match(block!, /消息边界无法核实/);
  assert.match(block!, /只有标题/);
});

// ─── 44 §3.3：撤权／删除／纠正向摘要的失效传播 ─────────────────────────────

/**
 * `readConversationSummaryChain` 的判据靠**查询形状**钉住，而不是靠结果——它跑在
 * 实库上，本地单测只能确认「读取侧真的带了有效性条件」。真正的读侧断言要等实库。
 */
test("44 §3.3：读取侧按区间级失效标记，不再拿会话修订号做等值比较", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const source = readFileSync(
    fileURLToPath(new URL("../turn/companion-dialogue-store.ts", import.meta.url)),
    "utf8",
  );
  // 会话级等值比较（0384）把「改过任意一条消息」当成「所有旧摘要都不作数」：
  // 实库里那条 565 条的会话改过 3 次消息，15 份摘要 13 份读不到，而 prompt 里
  // 连「这一段没读过」都不说。失效现在由触发器按被碰到的 seq 点名盖章。
  assert.doesNotMatch(source, /verified_context_revision\s*=\s*(?:c|conv)\.context_revision/,
    "读侧不许再拿会话修订号做等值比较——那是一刀切，不是判定");
  assert.match(source, /s\.invalidated_at IS NULL/, "缺判据仍然不算通过：没盖章才读得到");
  // 三份 coverage 列非空照旧要求（注释写着 content-verified 却从不复核，是 44 §2 的缺口）。
  assert.match(source, /s\.coverage_from_seq IS NOT NULL/);
  assert.match(source, /s\.coverage_through_seq IS NOT NULL/);
  assert.match(source, /s\.coverage_source_hash IS NOT NULL/);
  // 范围校验落在会话上，读的仍然是本人名下的那一个会话。
  assert.match(source, /c\.user_id = s\.user_id/);
});

test("0433：改写与删除消息的触发器往下调用那支，只给被碰到的区间盖作废标记", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const migration = readFileSync(
    fileURLToPath(new URL("../../../../../apps/api/src/db/migrations/"
      + "0433_conversation_summary_range_scoped_invalidation.sql", import.meta.url)),
    "utf8",
  );
  assert.match(migration, /p_seq BETWEEN coverage_from_seq AND coverage_through_seq/);
  // 会话修订号照旧前进：提交侧那道「折叠在途时内容变了」的围栏依赖它。
  assert.match(migration, /SET context_revision = context_revision \+ 1/);
  // 触发器调用出去的普通函数照查 EXECUTE（触发器那一层不查），api 与 worker 两条写路径都要有。
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.astella_invalidate_covered_conversation_summaries\(uuid, bigint\) TO astella_api, astella_worker/);
});

test("44 §3.3：写入侧在同一事务里记录并复核修订号", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const summarizer = readFileSync(
    fileURLToPath(new URL("../context/companion-summarizer.ts", import.meta.url)),
    "utf8",
  );
  const store = readFileSync(
    fileURLToPath(new URL("../turn/companion-dialogue-store.ts", import.meta.url)),
    "utf8",
  );
  // 读来源到提交之间若有人改写消息，这份覆盖已经不成立。锁是 FOR UPDATE：
  // FOR SHARE 之间不冲突，两个并发提交会同时通过父围栏（见 store 的注释）。
  assert.match(summarizer, /commitRevision !== contextRevision/);
  assert.match(summarizer, /FOR UPDATE/);
  // 复核过的那个值就是写进去的那个：SQL 在 store 的 upsertCommittedSummary 里。
  assert.match(summarizer, /verifiedContextRevision: commitRevision/);
  assert.match(store, /verified_context_revision/);
});
