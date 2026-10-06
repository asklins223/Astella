/**
 * Procedural 手册（40 §4.6.10，验收 A69）。
 *
 * ## 为什么这一节值得单独钉
 *
 * 它是 40 §4.5.2 五层用途里**唯一一个此前完全没有实现**的层。
 * 更要紧的是它有两种失败形状，而且都不会报错：
 *
 * - **手册收进 prompt 的全是正文** —— 目录形同虚设，上下文被手册吃满，
 *   而合同要的正是「默认只注入目录」。
 * - **按 ID 展开时不校验版本** —— 用户纠正之后，她还在按旧版做事，
 *   而且「她读的是哪一版」这个问题永远没人能回答。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSqlExecutor } from "@astella/agent-host";

import {
  PLAYBOOK_CATALOG_LIMIT,
  readPlaybookById,
  renderPlaybookCatalog,
  retrievePlaybookCatalog,
  type PlaybookCatalogEntry,
} from "../companion-playbooks.ts";

const entry = (over: Partial<PlaybookCatalogEntry> = {}): PlaybookCatalogEntry => ({
  playbookId: "11111111-1111-1111-1111-111111111111",
  playbookKey: "讲机制先举例",
  title: "讲机制先举例",
  triggerCondition: "对方第一次接触一个陌生概念",
  version: 1,
  epistemicStatus: "supported",
  ...over,
});

test("目录渲染**不含正文**——步骤与例外不在目录里", () => {
  // 这是 §4.6.10「默认只注入目录」的机械部分。目录里只有标题与触发条件；
  // 正文只能经 companion_read_playbook 展开。
  const rendered = renderPlaybookCatalog([entry()]);
  assert.match(rendered, /讲机制先举例/);
  assert.match(rendered, /对方第一次接触一个陌生概念/);
  // 这两个词只在正文里，正文不该出现在目录
  assert.ok(!/步骤/.test(rendered), "目录里出现了「步骤」");
  assert.ok(!/例外/.test(rendered), "目录里出现了「例外」");
});

test("目录告诉模型**怎么展开**，而不是让它猜", () => {
  const rendered = renderPlaybookCatalog([entry()]);
  assert.match(rendered, /companion_read_playbook/,
    "目录必须说明按 ID 展开的入口，否则模型只会直接照着目录猜着做");
  assert.match(rendered, /不相关就别读/,
    "§4.6.10「条件匹配且与用户目标有关时按需读取」——不相关时不许读");
});

test("空目录渲染成空串——不留一段「暂无手册」的废话进 prompt", () => {
  assert.equal(renderPlaybookCatalog([]), "");
});

test("编号与顺序稳定，便于模型说「第 2 条」", () => {
  const rendered = renderPlaybookCatalog([
    entry({ title: "甲" }),
    entry({ title: "乙", playbookId: "22222222-2222-2222-2222-222222222222" }),
  ]);
  assert.match(rendered, /^1\. 甲/m);
  assert.match(rendered, /^2\. 乙/m);
});

test("争议状态在目录里就标出来——依据被用户纠正过的手册不能装作没事", () => {
  // 遗忘/修订经 0348 的触发器把 epistemic_status 降为 disputed。
  // 目录是模型唯一默认看到的东西，所以这里必须能看见。
  const rendered = renderPlaybookCatalog([entry({ epistemicStatus: "disputed" })]);
  assert.match(rendered, /依据已被用户纠正/);
});

test("有据的与暂定的不加额外噪音", () => {
  const rendered = renderPlaybookCatalog([
    entry({ epistemicStatus: "supported" }),
    entry({ epistemicStatus: "tentative", playbookId: "33333333-3333-3333-3333-333333333333" }),
  ]);
  assert.ok(!rendered.split("\n")[1]?.includes("依据已被用户纠正"));
});

test("目录条数有硬上限——它是要进 prompt 的", () => {
  // §4.6.10 明确「不造无界文件浏览器」。目录无界就等于把手册全量塞进上下文。
  assert.ok(PLAYBOOK_CATALOG_LIMIT > 0 && PLAYBOOK_CATALOG_LIMIT <= 64,
    `目录上限 ${PLAYBOOK_CATALOG_LIMIT} 不合理：要么没界，要么大到吃掉上下文`);
});

test("【自证】判据认得出「目录里塞正文」这个真实退化", () => {
  const leaky = [
    "（表达与协作手册）",
    "1. 讲机制先举例｜触发：第一次接触｜步骤：先给例子｜例外：他已经懂了",
  ].join("\n");
  assert.match(leaky, /步骤：/, "自证样本没造好：退化目录确实带正文");
  // 正确渲染里这两个词一次都不该出现。
  const good = renderPlaybookCatalog([entry()]);
  assert.ok(!/步骤|例外/.test(good), "自证：正确的目录确实不含正文");
});

/* ------------------------------------------------------------------ *
 * 以下从**真实形状的 SQL 行**出发，而不是从目录条目出发。
 *
 * 只测 `renderPlaybookCatalog` 会漏掉真正坏掉的那一段：条目上的认识状态是谁给的。
 * 如果从行投影过来时把 `epistemic_status` 写死成 `supported`，
 * 上面所有渲染判据全绿，而争议的方法照样进目录、被照着做下去。
 * ------------------------------------------------------------------ */

const SCOPE = { workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };
const METHOD_ID = "33333333-3333-4333-8333-333333333333";

/** `SELECT p.*,s.*,…sources_current` 的返回形状。 */
const methodRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: METHOD_ID, playbook_key: "preference:讲机制先举例", version: 3,
  title: "讲机制先举例", trigger_condition: "对方第一次接触一个陌生概念",
  steps: ["先给一个日常类比"], exceptions: ["他已经懂了"],
  evidence: [{ memoryId: "44444444-4444-4444-8444-444444444444", memoryRevision: 2 }], capability_refs: [],
  method_state: "active", epistemic_status: "supported", user_controlled: true, author: "user",
  change_reason: "用户确认采用这个方法。", source_run_id: null, source_run_revision: null,
  created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-02T00:00:00.000Z",
  sources_current: true,
  consulted_count: "2", helpful_count: "1", unhelpful_count: "0", last_consulted_at: null,
  ...over,
});

/** 假 SQL 端口：第一次 SELECT 回给定行，之后的（记账写入）回空。 */
const fakeTx = (rows: Record<string, unknown>[]): AgentSqlExecutor => {
  let calls = 0;
  return { execute: async () => (++calls === 1 ? rows : []) };
};

test("目录条目的认识状态来自数据库那一行，不是在渲染时编的", async () => {
  const catalog = await retrievePlaybookCatalog(fakeTx([methodRow()]), SCOPE);
  assert.deepEqual(catalog.map(item => item.epistemicStatus), ["supported"],
    "数据库里写着 supported，目录却说成别的");
  assert.equal(catalog[0]?.version, 3, "目录丢了版本：按 ID 展开时没有可核对的那一版");
  assert.equal(catalog[0]?.playbookId, METHOD_ID, "目录丢了稳定 ID");
  assert.ok(!/依据已被用户纠正/.test(renderPlaybookCatalog(catalog)),
    "有据的方法被标成争议了");
});

test("active 但依据已被纠正的方法：既不进目录，也读不出正文", async () => {
  // 生命周期（active）与认识状态（disputed）是两列；只盯前一列就会把它当成已确认可用。
  const disputed = methodRow({ epistemic_status: "disputed" });
  assert.deepEqual(await retrievePlaybookCatalog(fakeTx([disputed]), SCOPE), [],
    "依据已被用户纠正的方法出现在可自动采用的目录里");
  assert.equal(await readPlaybookById(fakeTx([disputed]), SCOPE, METHOD_ID, 3), null,
    "active 但依据已被纠正的方法，按当前版本读出了正文");
  assert.equal(await readPlaybookById(fakeTx([methodRow({ method_state: "disabled" })]), SCOPE, METHOD_ID, 3), null,
    "用户已停用的方法被读出了正文");
  assert.equal(await readPlaybookById(fakeTx([methodRow({ epistemic_status: "tentative" })]), SCOPE, METHOD_ID, 3), null,
    "依据尚未核实的方法被读出了正文");
});

test("依据站得住的方法按当前版本能展开正文，并带上它的认识状态", async () => {
  const body = await readPlaybookById(fakeTx([methodRow()]), SCOPE, METHOD_ID, 3);
  assert.ok(body, "已确认且依据精确的方法读不到正文");
  assert.equal(body!.epistemicStatus, "supported");
  assert.equal(body!.version, 3, "展开出来的正文没有落回目录里那个版本");
  // 版本必须核对：手册随用户纠正升版，拿着上一版来读不能悄悄拿到新内容。
  assert.equal(await readPlaybookById(fakeTx([methodRow()]), SCOPE, METHOD_ID, 2), null,
    "拿着旧版本读到了当前正文：「她读的是哪一版」就永远答不出来");
});