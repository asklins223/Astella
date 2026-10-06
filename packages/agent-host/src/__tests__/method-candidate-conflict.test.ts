import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";

import { upsertAgentMethodCandidate } from "../methods.ts";
import type { AgentSqlExecutor } from "../store.ts";

/**
 * 方案 44 §6.4：冲突**并存**，不静默丢弃。
 *
 * 要挡的那件事：`ON CONFLICT … DO UPDATE … WHERE NOT user_controlled` 条件不成立时
 * `RETURNING` 什么都不给，函数返回 `null`——那与「这次没有可用依据」长得一模一样。
 * 后台提炼撞上用户已确认的方法时，候选会悄无声息地消失，调用方也无从知道。
 *
 * 这里用一个按 SQL 内容分派的假端口把两条路径都走一遍：
 *   - 原键可写 → created/updated；
 *   - 原键被用户控制挡住 → 落到 `:alternate`，结果 coexisting。
 */

const SCOPE = { workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };
const MEMORY_ID = "33333333-3333-4333-8333-333333333333";
const dialect = new PgDialect();

/** 按 SQL 内容分派的假端口；`blockedKeys` 里的 playbook_key 写不进去（模拟 WHERE 不成立）。 */
function fakeTx(blockedKeys: Set<string>) {
  const written: string[] = [];
  const tx: AgentSqlExecutor = {
    execute: async (query) => {
      const { sql, params } = dialect.sqlToQuery(query);
      if (sql.includes("FROM assistant_memory_items") && sql.includes("source_run_id")) return [];
      if (sql.includes("FROM assistant_memory_items")) return [{ id: MEMORY_ID }];
      if (sql.includes("INSERT INTO companion_procedural_playbooks")) {
        // 绑定参数由 dialect 摊平：INSERT 的第一个参数就是 playbook_key。
        const playbookKey = String(params[0] ?? "unknown");
        if (blockedKeys.has(playbookKey)) return [];
        written.push(playbookKey);
        // version 1 = 本次新建；被挡住的那次不会走到这里。
        return [{ id: "44444444-4444-4444-8444-444444444444", version: 1 }];
      }
      return [];
    },
  };
  return { tx, written };
}

const input = {
  playbookKey: "agent-run:run-1:2",
  title: "先核对材料版本再展开",
  triggerCondition: "展开笔记内容时",
  steps: ["读当前版本的原文"],
  exceptions: ["当前要求优先"],
  evidence: [{ memoryId: MEMORY_ID, memoryRevision: 1 }],
  epistemicStatus: "supported" as const,
  author: "maintenance" as const,
};

test("44 §6.4：原键可写时如实报 created/updated，不改口径", async () => {
  const { tx, written } = fakeTx(new Set());
  const result = await upsertAgentMethodCandidate(tx, SCOPE, input);
  assert.equal(result?.outcome, "created");
  assert.deepEqual(written, [input.playbookKey]);
});

test("44 §6.4：原键被用户控制挡住时并存一份，而不是返回 null", async () => {
  const { tx, written } = fakeTx(new Set([input.playbookKey]));
  const result = await upsertAgentMethodCandidate(tx, SCOPE, input);
  assert.ok(result, "候选不该悄无声息地消失——那与「没有依据」分不开");
  assert.equal(result!.outcome, "coexisting");
  assert.deepEqual(written, [`${input.playbookKey}:alternate`],
    "并存键是稳定的：重复提炼更新同一行，不堆行");
});

test("44 §6.4：并存不覆盖用户那一份，也不把它标成争议", async () => {
  const { tx } = fakeTx(new Set([input.playbookKey]));
  await upsertAgentMethodCandidate(tx, SCOPE, input);
  const source = await import("node:fs").then(fs =>
    fs.readFileSync(new URL("../methods.ts", import.meta.url), "utf8"));
  // 原键的写入条件必须仍然挡住用户控制与已停用——并存是「另起一行」，不是「绕过它」。
  assert.match(source, /WHERE NOT companion_procedural_playbooks\.user_controlled/);
  assert.match(source, /AND companion_procedural_playbooks\.method_state NOT IN \('disabled','disputed'\)/);
  // 也不许顺手把用户那一份改成 disputed：那等于后台一次提炼就让用户的确认失效。
  assert.ok(!/SET[^`]*epistemic_status='disputed'[^`]*WHERE[^`]*user_controlled/.test(source),
    "标争议会让用户已确认的方法变成不可采用——那是「擅自覆盖」的另一种形状");
});

test("44 §6.4：两个键都被挡住时返回 null——那时确实什么都没写", async () => {
  const { tx, written } = fakeTx(new Set([input.playbookKey, `${input.playbookKey}:alternate`]));
  const result = await upsertAgentMethodCandidate(tx, SCOPE, input);
  assert.equal(result, null);
  assert.deepEqual(written, []);
});

// ─── 方案 44 §6.3：效果评价 vs 采用 ────────────────────────────────────────

test("44 §6.3：没读过正文的使用记录收不到评价，而且给的是可读的原因", async () => {
  const source = await import("node:fs").then(fs =>
    fs.readFileSync(new URL("../methods.ts", import.meta.url), "utf8"));
  // 0386 的 CHECK 也会挡住，但它报出来是一条约束错误——读的人不知道自己做错了什么。
  assert.match(source, /existing\.stage === "offered"/);
  assert.match(source, /method_use_not_read/);
  assert.match(source, /还没有被读过正文/);
  // 判定要在 UPDATE 之前，并且锁住那一行，避免判定与写入之间被改掉。
  assert.match(source, /SELECT stage FROM companion_method_uses[\s\S]{0,200}FOR UPDATE/);
});

test("44 §6.3：评价是效果、不是采用——记录反馈不得顺手把 stage 提成 adopted", async () => {
  const source = await import("node:fs").then(fs =>
    fs.readFileSync(new URL("../methods.ts", import.meta.url), "utf8"));
  const feedbackBody = source.slice(source.indexOf("feedback(scope: AgentScopeV1,useId"),
    source.indexOf("function projectUse"));
  assert.match(feedbackBody, /SET feedback=/);
  // 判据要盯的是**赋值**，不是出现「stage」这个词：`existing.stage === "offered"`
  // 里也含 `stage =`，用宽松的正则会把正确实现判成错的（第一版就是这么错的）。
  assert.ok(!/SET[^;]*stage\s*=\s*'adopted'/.test(feedbackBody),
    "§6.3 把「实际采用」与「后续效果」并列；在评价里提升 stage 就是把「他评价过」记成「他采用了」");
  assert.ok(!/stage\s*=\s*\$\{/.test(feedbackBody),
    "评价路径不得写 stage —— 那是采用记录的事");
});

test("44 §6.3：使用记录把阶段投影出来，三种阶段分得开", () => {
  const source = readFileSync(new URL("../methods.ts", import.meta.url), "utf8");
  assert.match(source, /stage:row\.stage === "offered" \|\| row\.stage === "adopted" \? row\.stage : "read"/);
});

test("44 §6.4：已停用的方法不并存孪生候选——停用是「别再给我这条」", async () => {
  const source = readFileSync(new URL("../methods.ts", import.meta.url), "utf8");
  // 「用户控制」= 这条归我管，内容没被否定 → 并存。
  // 「停用」= 别再给我这条 → 彻底。每次提炼造一份孪生只会让停用变成需要反复清理的事。
  assert.match(source, /if \(blocked\?\.method_state === "disabled"\) return null;/);
  // 判据是**顺序**：停用判定必须在并存尝试之前，否则停用挡不住孪生。
  // （并存那一行当然还在——它服务的是「用户控制/已争议」那条路，不是停用那条。）
  const disabledAt = source.indexOf('if (blocked?.method_state === "disabled") return null;');
  const coexistAt = source.indexOf("await write(`${input.playbookKey}${ALTERNATE_KEY_SUFFIX}`)");
  assert.ok(disabledAt > 0 && coexistAt > disabledAt,
    "停用判定必须排在并存尝试之前——顺序反了，停用就挡不住孪生候选");
  assert.ok(source.includes("SELECT method_state FROM companion_procedural_playbooks"),
    "要判断停用就得先把那一行的状态读出来");
});
