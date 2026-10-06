/**
 * 方法行 → DTO 的认识状态回归（纯函数 + 假 SQL 端口，无数据库）。
 *
 * ## 为什么这一节值得单独钉
 *
 * 库里 `method_state`（生命周期）与 `epistemic_status`（认识状态）是**两列**，
 * 0348 与 0374 特意把它们拆开。读侧一旦合成一个字段——或者干脆默认成 `supported`——
 * 就会出现最安静的那种失败：依据已被用户纠正的手册仍然自称「已确认可用」，
 * 照着做下去没有任何一处会报错。所以下面每条断言都从**真实形状的行**出发。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { listAgentMethods, projectAgentMethod, readAgentMethod, recordAgentMethodOffered, type AgentMethodRow } from "../methods.ts";
import type { AgentSqlExecutor } from "../store.ts";

const SCOPE = { workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };
const METHOD_ID = "33333333-3333-4333-8333-333333333333";
const MEMORY_ID = "44444444-4444-4444-8444-444444444444";

/** `SELECT p.*,s.*,…sources_current` 的返回形状：列名就是库里的下划线列名。 */
function row(over: Partial<AgentMethodRow> = {}): AgentMethodRow {
  return {
    id: METHOD_ID, playbook_key: "preference:讲机制先举例", version: 3,
    title: "讲机制先举例", trigger_condition: "对方第一次接触一个陌生概念",
    steps: ["先给一个日常类比"], exceptions: ["他已经懂了"],
    evidence: [{ memoryId: MEMORY_ID, memoryRevision: 2 }], capability_refs: [],
    method_state: "active", epistemic_status: "supported", user_controlled: true, author: "user",
    change_reason: "用户确认采用这个方法。", source_run_id: null, source_run_revision: null,
    created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-02T00:00:00.000Z",
    sources_current: true,
    consulted_count: "2", helpful_count: "1", unhelpful_count: "0", last_consulted_at: null,
    ...over,
  };
}

/** 假 SQL 端口：第一次 SELECT 回给定行，其余（记账 INSERT）回空；同时留下渲染后的 SQL 文本。 */
function fakeTx(rows: AgentMethodRow[]) {
  const dialect = new PgDialect();
  const queries: string[] = [];
  const tx: AgentSqlExecutor = {
    execute: async query => {
      queries.push(dialect.sqlToQuery(query).sql);
      return queries.length === 1 ? rows : [];
    },
  };
  return { tx, queries };
}

test("认识状态照实投影：库里的 disputed 不会被读成 supported", () => {
  const method = projectAgentMethod(row({ epistemic_status: "disputed" }));
  assert.equal(method.epistemicStatus, "disputed", "争议的方法被投影成了有据");
  assert.equal(method.state, "active", "生命周期与认识状态是两列，不能互相顶替");
  // 两列一起动才是常态；这里单看认识状态也不能放过它。
  assert.equal(method.availability, "source_changed",
    "依据已被用户纠正的方法仍自称可采用：它会被照着做下去，而且不会报错");
});

test("tentative / disputed / disabled 都不是「已确认可用」", () => {
  const availability = (over: Partial<AgentMethodRow>) => projectAgentMethod(row(over)).availability;
  assert.equal(availability({}), "available", "夹具前提：已确认且依据精确的方法应当可采用");
  assert.equal(availability({ epistemic_status: "tentative" }), "pending",
    "依据还没核的方法被当成了已确认可采用：一次整理不该直接升为稳定经验");
  assert.equal(availability({ epistemic_status: "disputed" }), "source_changed");
  assert.equal(availability({ method_state: "disabled", epistemic_status: "disputed" }), "disabled",
    "停用是用户自己的决定：它该被读成停用，而不是被依据争议盖过去");
  assert.equal(availability({ method_state: "candidate", epistemic_status: "tentative" }), "pending");
  assert.equal(availability({ sources_current: false }), "source_changed");
});

test("目录围栏两道都在：SQL 按认识状态收紧，读侧再按可采用筛一次", async () => {
  const usable = row({ id: "55555555-5555-4555-8555-555555555555", playbook_key: "preference:可用" });
  const { tx, queries } = fakeTx([
    row({ epistemic_status: "disputed" }),
    usable,
    row({ id: "66666666-6666-4666-8666-666666666666", epistemic_status: "tentative" }),
  ]);
  const catalog = await listAgentMethods(tx, SCOPE, true);
  assert.deepEqual(catalog.map(method => method.epistemicStatus), ["supported"],
    "active+disputed 或 tentative 的方法混进了可自动采用的目录");
  // 读侧那道是兜底；SQL 里那道挡住的是「一条不合格的行先占走 LIMIT 名额」。
  assert.match(queries[0]!, /method_state='active' AND p\.epistemic_status='supported'/,
    "目录 SQL 没有按认识状态收紧：暂定或争议的方法会先占掉目录上限");
});

test("读前核对：active 但依据有争议的方法，按当前版本也读不出正文", async () => {
  const disputed = fakeTx([row({ epistemic_status: "disputed" })]);
  assert.equal(await readAgentMethod(disputed.tx, SCOPE, METHOD_ID, 3), null,
    "active 但依据已被纠正的方法读出了正文：争议状态被绕过，读取前核对失效");
  assert.equal(disputed.queries.length, 1, "读不到就不该再记账一次咨询");

  const supported = fakeTx([row()]);
  const method = await readAgentMethod(supported.tx, SCOPE, METHOD_ID, 3);
  assert.equal(method?.epistemicStatus, "supported", "依据精确的方法读出来却没有认识状态");
});

// ─── 方案 44 §6.3：三个阶段各自计数，阅读次数不能冒充采用 ──────────────────

test("44 §6.3：目录被提供不进 consultedCount——它只说明她看见过", async () => {
  const { tx, queries } = fakeTx([]);
  await recordAgentMethodOffered(tx, SCOPE, {
    methods: [{ methodId: METHOD_ID, revision: 3 }],
    kind: "agent_goal", contextId: "run-1", contextRevision: 2, sourceKey: "goal:run-1:2",
  });
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /companion_method_uses/);
  // 写进去的阶段必须是 offered；写成 read 就等于把「看见过」记成「读过」。
  assert.match(queries[0]!, /stage/);
});

test("44 §6.3：统计按阶段分开，consulted 只算读过正文的那些", () => {
  const source = readFileSync(new URL("../methods.ts", import.meta.url), "utf8");
  assert.match(source, /FILTER \(WHERE stage='offered'\) AS offered_count/);
  assert.match(source, /FILTER \(WHERE stage IN \('read','adopted'\)\) AS consulted_count/);
  assert.match(source, /FILTER \(WHERE stage='adopted'\) AS adopted_count/);
  // 旧的 count(*) 口径会把 offer 也当成阅读，正是 §6.3 点名禁止的那件事。
  assert.ok(!/count\(\*\) AS consulted_count/.test(source),
    "退回 count(*) 会让「目录被提供」冒充「被阅读」");
});

test("44 §6.3：只有读过或采用过的使用记录才收得到质量评价", () => {
  const migration = readFileSync(
    new URL("../../../../apps/api/src/db/migrations/0386_method_use_stage.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /CHECK \(feedback IS NULL OR stage IN \('read', 'adopted'\)\)/,
    "没读过正文的人判不了这条做法好不好");
  assert.match(migration, /CHECK \(stage IN \('offered', 'read', 'adopted'\)\)/);
  // 存量行都是阅读记录，默认值必须保持它们的语义不变。
  assert.match(migration, /ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'read'/);
});

test("44 §6.4：保存完整派生关系，只把**计数**按来源归并", () => {
  const source = readFileSync(new URL("../methods.ts", import.meta.url), "utf8");
  assert.match(source, /groupAgentMethodEvidenceOrigins\(/);
  assert.match(source, /reconcileEvidenceEpistemicStatus\(/);
  // 「这条记忆派生自哪次运行」只有库知道，归并前必须查出来。
  assert.match(source, /source_run_id/);
  // evidence 保完整——折掉记忆引用会让用户遗忘/纠正的传播路径断掉。
  assert.match(source, /const evidence = parsed;/);
  // 归并结果单独存，供计数用。
  assert.match(source, /evidence_origins/);
  assert.match(source, /\$\{epistemicStatus\},\$\{input\.author\}/);
});

test("44 §6.4：证据传播仍按 memoryId 找到派生方法——不能把记忆引用折掉", () => {
  const migration = readFileSync(
    new URL("../../../../apps/api/src/db/migrations/0374_agent_growth_methods.sql", import.meta.url),
    "utf8",
  );
  // 用户遗忘或纠正一条记忆时，靠这个匹配把派生方法标成需要重新核对。
  assert.match(migration, /evidence @> jsonb_build_array\(jsonb_build_object\('memoryId'/);
  const source = readFileSync(new URL("../methods.ts", import.meta.url), "utf8");
  // 写进库的必须是完整引用；折成「只留最具体的一条」会让上面那条匹配失效。
  assert.ok(!/const evidence = grouping\.refs/.test(source),
    "把 evidence 折成归并结果 = 用户遗忘不再传递到派生经验");
});

test("44 §6.4：没有归并回执的旧行退回上界，不把支持数凭空算小", () => {
  const source = readFileSync(new URL("../methods.ts", import.meta.url), "utf8");
  assert.match(source, /function readEvidenceIndependentCount/);
  assert.match(source, /return row\.evidence\?\.length \?\? 0/);
});

test("44 §2：步骤与例外来自这次真实运行，不是能力目录", () => {
  const source = readFileSync(new URL("../methods.ts", import.meta.url), "utf8");
  assert.match(source, /planMethodStepsFromRun\(/);
  assert.match(source, /const stepPlan = planMethodStepsFromRun/);
  // 写进库的必须是这次运行的提炼结果。
  assert.match(source, /JSON\.stringify\(stepPlan\.steps\)/);
  assert.match(source, /JSON\.stringify\(\[\.\.\.stepPlan\.exceptions/);
  // 一次都没走通就不硬凑一条做法。
  assert.match(source, /if \(!stepPlan\.contributes\) throw new AgentStoreError\(422,"method_source_empty"/);
});
