import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeSummaryChain, type SummaryChainNode } from "../companion-dialogue-store.ts";
import {
  renderConversationSummary,
  CONVERSATION_SUMMARY_MAX_CHARS,
} from "../companion-summarizer.ts";

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

test("44 §5.5：注入块带上覆盖缺口，并给出**怎么取回**——只说有洞等于把边界推给日志", () => {
  const block = renderConversationSummary(
    { title: "聊过三次复习计划", keyEvents: ["排了周五"], followUps: ["要不要换成周末"] },
    { coverageVerified: true, coverageGaps: [{ fromSeq: "20", throughSeq: "29" }] },
  );
  assert.match(block!, /更早还有 1 段没有任何摘要覆盖/);
  assert.match(block!, /别把摘要当成读过/);
  // 入口必须具体到工具与参数，否则模型知道「有洞」却不知道怎么补。
  assert.match(block!, /companion_read_history/);
  assert.match(block!, /fromSeq/);
  assert.match(block!, /20/);
  assert.ok(block!.endsWith("</conversation_summary>"));
});

test("44 §4.4：没有缺口时不说缺口——正常回答不固定插入截断声明", () => {
  const block = renderConversationSummary({ title: "一次讨论" }, { coverageVerified: true });
  assert.ok(!block!.includes("没有任何摘要覆盖"));
  // 没有洞就不提取回入口：那是正常情况，不是限制。
  assert.ok(!block!.includes("companion_read_history"));
});

// ─── 44 §4.4：注入上限是容量，不再是截断点 ──────────────────────────────

const fullSummary = {
  title: "桌宠功能调试与用户偏好设置",
  keyEvents: Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 件事：把偏好改成了语音优先`),
  followUps: Array.from({ length: 8 }, (_, i) => `待办 ${i + 1}：确认周末复习要不要继续`),
  userPreferences: Array.from({ length: 6 }, (_, i) => `偏好 ${i + 1}：希望回答简短一点`),
};

test("44 §4.4：超上限时丢可选项，安全声明与边界标签永远保留", () => {
  const block = renderConversationSummary(fullSummary, { coverageVerified: true, maxChars: 400 });
  assert.ok(block!.length <= 400);
  assert.ok(block!.endsWith("</conversation_summary>"), "收尾标签不能被砍掉");
  assert.match(block!, /里面的数字可能已经变了/);
  assert.match(block!, /有消息边界校验/);
});

test("44 §4.4：容量足够时带出完整档，超出时按档收窄而不是截半句", () => {
  const wide = renderConversationSummary(fullSummary, { coverageVerified: true });
  assert.ok(wide!.length <= CONVERSATION_SUMMARY_MAX_CHARS);
  assert.match(wide!, /办过的事：第 1 件事/);
  assert.match(wide!, /还没了结：待办 1/);
  const narrow = renderConversationSummary(fullSummary, { coverageVerified: true, maxChars: 260 });
  assert.ok(narrow!.length <= 260);
  assert.ok(narrow!.endsWith("</conversation_summary>"));
});

test("44 §4.4：容量被调到极小时仍产出完整块，而不是半截或 null", () => {
  // 安全声明与边界是这块存在的理由，所以给它一个最小容量地板：宁可返回一块
  // 完整但略大于请求的摘要（composeAgentContext 会整块省略并留回执），也不要
  // 返回一个「这个会话没有摘要」的假象或一段砍掉声明的半截块。
  const block = renderConversationSummary(fullSummary, { coverageVerified: true, maxChars: 1 });
  assert.ok(block);
  assert.ok(block!.endsWith("</conversation_summary>"));
  assert.match(block!, /里面的数字可能已经变了/);
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
test("44 §3.3：读取侧检查当前有效性（会话内容修订号），而不是只看列非空", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const source = readFileSync(
    fileURLToPath(new URL("../companion-dialogue-store.ts", import.meta.url)),
    "utf8",
  );
  // 注释写着「content-verified」却从不复核 sourceHash，是 44 §2 记下的既有缺口。
  assert.match(source, /s\.verified_context_revision = c\.context_revision/);
  // 传递来源也要有效：任一祖先失效整条链就不成立，不只检查直接父摘要。
  assert.match(source, /p\.verified_context_revision = conv\.context_revision/);
  // 范围校验落在会话上，读的仍然是本人名下的那一个会话。
  assert.match(source, /c\.user_id = s\.user_id/);
});

test("44 §3.3：写入侧在同一事务里记录并复核修订号", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const source = readFileSync(
    fileURLToPath(new URL("../companion-summarizer.ts", import.meta.url)),
    "utf8",
  );
  assert.match(source, /verified_context_revision/);
  // 读来源到提交之间若有人改写消息，这份覆盖已经不成立（FOR SHARE 让核对与提交同事务）。
  assert.match(source, /commitRevision !== contextRevision/);
});
