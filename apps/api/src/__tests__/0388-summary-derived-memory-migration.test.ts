import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0388_summary_derived_memory.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

// 方案 44 §3.3：「旧摘要不能恢复失效授权或被遗忘内容」。
// 手册那一侧早就处理了（0374），摘要与记忆是同一种派生关系却漏了这一侧：
// 方向只有「摘要 → 记忆」，没有反向引用，于是用户的遗忘被摘要一句一句 undo 掉。
test("0388 records which memory a summary produced, and forgets with it", () => {
  assert.ok(journal.entries.some((entry) => entry.idx === 384 && entry.tag === "0388_summary_derived_memory"));
  assert.match(migration, /ADD COLUMN IF NOT EXISTS derived_memory_id uuid/);
  assert.match(migration, /ailearn_invalidate_summary_on_derived_memory_change/);
  assert.match(migration, /AFTER UPDATE OR DELETE ON public\.assistant_memory_items/);
});

test("0388 marks the summary stale — it stops being injected, rather than being injected with a caveat", () => {
  assert.match(migration, /SET status = 'stale'/);
  // stale 不在读取侧认领的两个状态里（见 companion-dialogue-store 的链读取），
  // 所以它**立刻**不再出现在对话上下文里。
  const readPath = readFileSync(
    new URL("../../../../workers/ai-worker/src/handlers/companion-dialogue-store.ts", import.meta.url),
    "utf8",
  );
  assert.match(readPath, /status IN \('candidate', 'confirmed'\)/);
  assert.ok(!/status IN \('candidate', 'confirmed', 'stale'\)/.test(readPath),
    "stale 必须落在读取侧认领之外，否则失效的摘要仍会被注入");
  assert.match(migration, /CHECK \(status IN \('candidate', 'confirmed', 'rejected', 'stale'\)\)/);
});

test("0388 only fires when the memory really became unusable", () => {
  // 用户自己记下的、或仍有效的那条记忆不该反过来打掉摘要。
  assert.match(migration, /NEW\.dismissed_at IS NOT NULL/);
  assert.match(migration, /NEW\.archived_at IS NOT NULL/);
  assert.match(migration, /NEW\.revision <> OLD\.revision/);
  assert.match(migration, /NEW\.content <> OLD\.content/);
  assert.match(migration, /NEW\.epistemic_status IN \('disputed', 'superseded'\)/);
  // 幂等：已经 stale 的不再重复写。
  assert.match(migration, /AND s\.status <> 'stale'/);
});

test("0388 scopes the invalidation to the same workspace and user", () => {
  assert.match(migration, /s\.workspace_id = COALESCE\(NEW\.workspace_id, OLD\.workspace_id\)/);
  assert.match(migration, /s\.user_id = COALESCE\(NEW\.user_id, OLD\.user_id\)/);
});

test("摘要器写入反向引用——只有列没有写入方，等于没做", () => {
  const source = readFileSync(
    new URL("../../../../workers/ai-worker/src/handlers/companion-summarizer.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /derived_memory_id/);
  assert.match(source, /UPDATE conversation_summaries/);
});

test("0388 的 status 取值集合是从事实凑出来的，不是猜的", () => {
  // 集合 = 「代码里真的写过的」 ∪ 「读取侧真的认领的」。
  const summarizer = readFileSync(
    new URL("../../../../workers/ai-worker/src/handlers/companion-summarizer.ts", import.meta.url),
    "utf8",
  );
  const allowed = new Set(["candidate", "confirmed", "rejected", "stale"]);

  // 写入侧：只看 conversation_summaries 那条 INSERT —— 同一个文件里还有记忆的 INSERT，
  // 它的 'pending' 是 embedding_status，不是这里的 status（第一版正则太宽，误报过一次）。
  const summaryInsert = summarizer.slice(
    summarizer.indexOf("INSERT INTO conversation_summaries"),
    summarizer.indexOf("ON CONFLICT (workspace_id, user_id, conversation_id, source_run_id)"),
  );
  assert.ok(summaryInsert.length > 0, "没找到摘要的 INSERT");
  const written = [...summaryInsert.matchAll(/,\s*'([a-z_]+)',\s*now\(\),\s*now\(\)\)/g)].map(m => m[1]!);
  assert.deepEqual(written, ["candidate"], `摘要 INSERT 的 status 应只有 candidate，实际：${written.join("/")}`);
  for (const value of written) assert.ok(allowed.has(value), `写入侧出现集合外的 status：${value}`);

  // 读取侧：读路径认领的状态必须在集合内——漏一个，那份摘要会**静默**不可见。
  const chain = readFileSync(
    new URL("../../../../workers/ai-worker/src/handlers/companion-dialogue-store.ts", import.meta.url),
    "utf8",
  );
  // 只看**摘要表**的 s./p. 前缀：同一文件里还有 turn run 的状态过滤
  // （cancelled_run.status IN ('cancelled','superseded')），那是另一张表的另一件事。
  for (const match of chain.matchAll(/\b[sp]\.status IN \(([^)]*)\)/g)) {
    for (const value of match[1]!.matchAll(/'([a-z_]+)'/g)) {
      assert.ok(allowed.has(value[1]!), `读取认领了集合外的 status：${value[1]}`);
    }
  }
  const retrieval = readFileSync(
    new URL("../../../../workers/ai-worker/src/handlers/companion-summary-retrieval.ts", import.meta.url),
    "utf8",
  );
  for (const value of retrieval.match(/\bs\.status IN \(([^)]*)\)/)?.[1]?.matchAll(/'([a-z_]+)'/g) ?? []) {
    assert.ok(allowed.has(value[1]!), `跨会话检索认领了集合外的 status：${value[1]}`);
  }
});

test("0388 明说这一列原先没有取值约束——不要误以为它一直在", () => {
  assert.match(migration, /原先\*\*没有\*\*任何取值约束/);
});
