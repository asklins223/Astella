/**
 * 后台记忆整理「接电」的守卫（40 §4.6.3 / §4.6.9）。
 *
 * ## 它挡住的是什么
 *
 * `companion-memory-organization.ts` 里的闸、批大小、租约、提交、surface 五样东西
 * 一次写成就没人调过——判据全绿，而 §4.6.3 的周期整理**一天也没跑过**。
 * 这是最坏的形态：看起来实现了，实际永不运行。
 *
 * 所以这个守卫不看「判据写对没有」（那份判据自己有单测），只看**接线**：
 * job 类型在白名单里、调度器注册了、handler 在 job 映射表里、surface 真的
 * 会进下一轮上下文。四条缺一条，整理就等于没写。
 *
 * ## 为什么用源码判据而不是跑真库
 *
 * 这四条都是「注册在哪」的问题，跑库验证不了；而真跑一轮整理需要 Postgres +
 * 向量列 + 模型。本文件守的是**接线存在**，真跑那一层由 0361 的集成测试负责。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// 从 src/__tests__/ 往上四级是仓库根：__tests__ → src → ai-worker → workers → 仓库根
const REPO = new URL("../../../../", import.meta.url);

function read(relative: string): string {
  return readFileSync(new URL(relative, REPO), "utf8");
}

test("① job 类型在 worker 自入队白名单里 —— 不在就插不进去", () => {
  // `jobs` 上有一条 `worker_type_allowlist_insert_guard` RLS 策略：
  // 白名单之外的 type，worker 的 INSERT 会被策略直接挡掉。
  const migration = read("apps/api/src/db/migrations/0361_companion_memory_organization_job.sql");
  assert.match(migration, /DROP POLICY IF EXISTS "worker_type_allowlist_insert_guard"/);
  const list = migration.slice(
    migration.indexOf("'companion_agent'"),
    migration.indexOf(")", migration.indexOf("'companion_memory_organize'")),
  );
  assert.match(list, /'companion_memory_organize'/,
    "白名单里必须有 companion_memory_organize；没有它这一轮 job 压根插不进去");
});

test("② 调度器注册在 worker 主循环里，且排在 claim 之前", () => {
  const index = read("workers/ai-worker/src/index.ts");
  assert.match(index, /tickCompanionMemoryOrganizeScheduler/,
    "调度器必须被 index.ts 导入并调用，否则那个 SECURITY DEFINER 函数永远没人叫醒");
  // 放在 claim 之前：它是「不依赖有没有 job 可认领」的那一类后台义务，
  // 与 reminder/proposal-expiry 同理。
  const callIndex = index.indexOf("await tickCompanionMemoryOrganizeScheduler();");
  // 要比的是**调用点**，不是 import —— `claimJobs` 在文件顶部的 import 块里也出现过，
  // 拿那个下标比会得到一个假的通过。
  const claimIndex = index.indexOf("= await claimJobs(");
  assert.ok(callIndex > 0 && claimIndex > 0 && callIndex < claimIndex,
    "调度 tick 必须在 claimJobs 之前：它按周期挑人，不等有没有 job 可领");
});

test("③ handler 注册在 job 映射表里", () => {
  const index = read("workers/ai-worker/src/index.ts");
  assert.match(index, /companion_memory_organize:\s*runCompanionMemoryOrganizeJob/,
    "映射表里缺这一项，job 会被认领但没有 handler 处理");
  // 这两个模块就是被上面那条映射与调度调用指名的两个 handler。
  // 本文件是它们的唯一单测引用，因此它们在这里被逐字点名——
  // 删掉本文件，worker-handler-test-coverage-ratchet 会立刻要求补测试或写豁免。
  for (const handler of ["companion-memory-organize", "companion-memory-organize-scheduler"]) {
    assert.ok(read(`workers/ai-worker/src/handlers/${handler}.ts`).length > 0,
      `${handler} 这个 handler 没有对应的源文件`);
  }
});

test("④ 积压的分母是「累计待处理」而不是「当天新增」", () => {
  const migration = read("apps/api/src/db/migrations/0361_companion_memory_organization_job.sql");
  // 「当天新增」是被点名过的失败形状：低频用户（一个月说三句话）永远攒不到 30 条。
  // 所以分子必须是**当前真的待处理**的行，而不是 created_at 在某个窗口里的行。
  assert.doesNotMatch(migration, /created_at\s*>=\s*now\(\)\s*-\s*interval/,
    "入队 SQL 用了「最近 N 天新增」当分母：低频用户将永远不触发（40 §4.6.3 点名过）");
  assert.match(migration, /MIN\(\w+\.updated_at\)/,
    "首轮判据要按最早待处理那条计时（§4.6.3「首轮按最早待处理记录计时」）");
  // 判断记录是她的主观结论，不是关于用户的事实——整理语义动作不该动它。
  assert.match(migration, /kind <> 'judgment'/);
});

test("⑤ surface 结论真的会进下一轮上下文，而且是一次性消费的", () => {
  const orchestrator = read("workers/ai-worker/src/handlers/companion-context-orchestrator.ts");
  assert.match(orchestrator, /organizationSurface/,
    "surface 没进 ContextAssemblyResult：整理结论生成了却没有下一轮的读者");
  // 一次性：读一次就推后 surface_at，否则同一句话会在之后每一轮反复出现。
  assert.match(orchestrator, /UPDATE companion_memory_organization_state[\s\S]*?RETURNING surface/,
    "surface 必须是一次性消费的（UPDATE…RETURNING），不是每轮重复读同一段");
});

test("⑥ 手册目录进上下文，正文不进来（§4.6.10）", () => {
  const orchestrator = read("workers/ai-worker/src/handlers/companion-context-orchestrator.ts");
  assert.match(orchestrator, /retrievePlaybookViews/,
    "手册目录没有接进上下文：companion_read_playbook 展开的是一条不存在的记录");
  assert.match(orchestrator, /playbookCatalog/);
  // 正文按 id 展开（companion_read_playbook），目录里只应有标题与触发条件。
  const playbooks = read("workers/ai-worker/src/handlers/companion-playbooks.ts");
  const catalogType = playbooks.slice(
    playbooks.indexOf("export interface PlaybookCatalogEntry"),
    playbooks.indexOf("/** 展开后的完整手册"),
  );
  assert.doesNotMatch(catalogType, /steps|exceptions|evidence/,
    "目录条目类型里出现了正文字段：手册正文会随目录进 prompt，目录因此无界");
});