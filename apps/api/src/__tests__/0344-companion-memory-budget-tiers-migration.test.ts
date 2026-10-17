import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0344_companion_memory_budget_tiers.sql", import.meta.url),
  "utf8",
);
// 0344 之后 0430 用 `CREATE OR REPLACE` 整块替换了同一个函数体：钉住 0344 里那三行
// 闸门，守的是**已经不再执行**的定义——真正生效的那一份必须一起读。
const residentCapacity = readFileSync(
  new URL("../db/migrations/0430_companion_memory_resident_capacity_follows_prompt_budget.sql", import.meta.url),
  "utf8",
);
const memoryService = readFileSync(
  new URL("../modules/companion-conversation/memory/memory-service.ts", import.meta.url),
  "utf8",
);
// 注入侧（伴星提示词组装）声明常驻容量的那两处常数：写侧闸门必须等于它算出来的数。
const orchestrator = readFileSync(
  new URL("../../../../workers/ai-worker/src/handlers/context/companion-context-orchestrator.ts", import.meta.url),
  "utf8",
);
const roleGrants = readFileSync(
  new URL("../../../../infra/postgres/roles.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

const journalIdx = (tag: string) => journal.entries.find((entry) => entry.tag === tag)?.idx;

test("0344 adds separately auditable resident, active, and archived memory tiers", () => {
  assert.ok(journal.entries.some((entry) =>
    entry.idx === 343 && entry.tag === "0344_companion_memory_budget_tiers"));
  assert.match(migration, /ADD COLUMN budget_tier text NOT NULL DEFAULT 'active'/);
  assert.match(migration, /CHECK \(budget_tier IN \('resident', 'active', 'archived'\)\)/);
  assert.match(migration, /CREATE TABLE public\.assistant_memory_budget_events/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE UPDATE, DELETE, TRUNCATE ON public\.assistant_memory_budget_events/);
});

test("0430 is the definition that actually runs: same function, later in the journal", () => {
  const overruledIdx = journalIdx("0344_companion_memory_budget_tiers");
  const effectiveIdx = journalIdx("0430_companion_memory_resident_capacity_follows_prompt_budget");
  assert.ok(overruledIdx !== undefined && effectiveIdx !== undefined,
    "0430 没进 journal 就等于本机与 CI 跑的是两份不同的常驻档闸门");
  assert.ok(effectiveIdx > overruledIdx,
    "0430 必须排在 0344 之后：CREATE OR REPLACE 只有后手才改得动生效定义");
  assert.match(residentCapacity, /CREATE OR REPLACE FUNCTION public\.astella_move_companion_memory_budget_tier_v1\(/);
  assert.match(residentCapacity, /p_actor_id uuid DEFAULT NULL/);
});

test("the effective resident gate stays serialized, scoped, and reversible", () => {
  assert.match(residentCapacity, /pg_advisory_xact_lock\([\s\S]*?companion-memory-budget:/);
  assert.match(residentCapacity, /FOR UPDATE/);
  assert.match(residentCapacity, /current_setting\('app\.workspace_id', true\)[\s\S]*?current_setting\('app\.user_id', true\)/);
  assert.match(residentCapacity, /'suggestedDowngrades', suggestions/);
  assert.match(residentCapacity, /actor_type, actor_id/);
  assert.match(residentCapacity, /CURRENT_USER = 'astella_api'[\s\S]*?p_actor_type <> 'user'/);
  assert.match(residentCapacity, /CURRENT_USER = 'astella_worker'[\s\S]*?p_actor_type = 'user'/);
  // 授权不随 CREATE OR REPLACE 重置，但仍只有 0344 写过一次：它必须在，否则服务调不到这个函数。
  assert.match(migration, /astella_move_companion_memory_budget_tier_v1/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.astella_move_companion_memory_budget_tier_v1[\s\S]*?FROM PUBLIC/);
});

test("resident admission is gated on the one declared token budget, not on counts or bytes", () => {
  assert.match(residentCapacity, /resident_tokens \+ requested_tokens > 6400/);
  // 条数与字节本来就是 token 的代理；留着它们就等于让一个谁都没声明过的名额决定
  // "她能不能记住这条"——第 7 条明明还装得下却被拒，就是这么来的。
  assert.doesNotMatch(residentCapacity, /resident_items \+ 1 >/,
    "条数不能再当常驻档闸门：产品上限是 200 字一条，装满 6,400 tok 本来就要 32 条");
  assert.doesNotMatch(residentCapacity, /resident_bytes \+ requested_bytes >/,
    "字节数不能再当闸门：它是 token 的代理，两把尺子必然互相打架");
  assert.doesNotMatch(residentCapacity, /resident_tokens \+ requested_tokens > 320/,
    "写侧 320 与注入侧 6,400 不是一个数时，拒绝理由是假的");

  // 满额回执只能声明那一条真存在的预算：limits 里只有 tokenEstimate。
  assert.match(residentCapacity, /'limits', jsonb_build_object\(\s*'tokenEstimate', 6400\s*\)\s*,/);
  assert.doesNotMatch(residentCapacity, /'limits', jsonb_build_object\([^)]*'items'/,
    "limits 再报 items 就是告诉用户有一个并不存在的条数上限");
  assert.doesNotMatch(residentCapacity, /'limits', jsonb_build_object\([^)]*'byteCount'/,
    "limits 再报 byteCount 同上：字节不是名额");

  // 三处必须读出同一个数，否则"容量满了"这句话不可信。
  const sqlTokens = Number(residentCapacity.match(
    /resident_tokens \+ requested_tokens > (\d+)/)?.[1]);
  const tsTokens = Number(memoryService.match(
    /COMPANION_MEMORY_RESIDENT_BUDGET_V1 = \{\s*tokenEstimate: ([\d_]+)/)?.[1]?.replace(/_/g, ""));
  assert.equal(sqlTokens, 6400, "生效的常驻档闸门读数不是 6,400");
  assert.equal(tsTokens, 6400, "服务层声明的常驻预算读数不是 6,400");
  assert.equal(tsTokens, sqlTokens,
    "SQL 闸门与 memory-service 的常驻预算不是同一个数：接口告诉用户的剩余名额和她真正被拒的判据会对不上");

  const injectedBudget = Number(orchestrator.match(
    /COMPANION_MEMORY_CONTEXT_ESTIMATE_BUDGET = ([\d_]+)/)?.[1]?.replace(/_/g, ""));
  const injectedShare = Number(orchestrator.match(
    /RESIDENT_MEMORY_BUDGET_SHARE = ([\d.]+)/)?.[1]);
  assert.equal(Math.floor(injectedBudget * injectedShare), sqlTokens,
    "准入闸门与注入侧声明的常驻容量脱钩：她被拒的那条位置其实还空着，或者已经塞不下还被放行");
});

test("role bootstrap keeps memory budget events append-only and restores the exact move function grants", () => {
  assert.match(roleGrants, /assistant_memory_budget_events/);
  assert.match(roleGrants, /astella_move_companion_memory_budget_tier_v1\(uuid,uuid,uuid,text,text,uuid\)/);
  const apiExecuteAllowlist = roleGrants
    .split("AND has_function_privilege('astella_api'")[1]
    ?.split("RAISE EXCEPTION 'API has unexpected function EXECUTE privileges:")[0] ?? "";
  assert.match(apiExecuteAllowlist, /astella_move_companion_memory_budget_tier_v1/);
  assert.match(roleGrants, /Worker has unexpected function EXECUTE privileges/);
  assert.match(roleGrants, /Required function EXECUTE grants are missing/);
});
