import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * P2-15 逐字副本收敛的**棘轮**：搜索投影的 upsert 只能有一处实现。
 *
 * ## 为什么这一处要单独钉死
 *
 * 收敛本身没有难度——把重复的函数体抽到 `lib/search-index-upsert.ts` 就行了。
 * 有难度的是**它会长回来**：任何时候有人要改冲突键（`workspaceId + objectType +
 * `objectId`）或 upsert 语义，在两个文件里各写一遍是最自然的事。
 *
 * ## 冲突键为什么必须只有一处
 *
 * 搜索索引的冲突键决定了"同一篇笔记"这个身份。两处各写一遍，一旦改了其中一处的
 * 键，症状是**同一篇笔记在搜索结果里出现两条**，或者反过来——**改完正文搜到的
 * 还是旧内容**。这两种都不报错，只能靠 drift 检测端点事后发现。
 *
 * 所以这里钉的不是"代码长什么样"，是"**这段语义只能有一处**"。
 */

const API_ROOT = new URL("..", import.meta.url).pathname;
const LIB = join(API_ROOT, "lib", "search-index-upsert.ts");

/** 冲突键只允许在**语义模块**里拼装。 */
const SOLE_OWNER = LIB;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/**
 * 能判定"这里**自己拼了冲突键**"的代码特征。
 *
 * 注意它只认 `target: [searchDocuments.…]` 这种**内联数组**。
 * 走共享常量的写法是 `target: [...SEARCH_DOCUMENT_CONFLICT_TARGET]`，
 * 不含 `searchDocuments.` 字样，所以天然不匹配——判据要区分的正是这两种。
 */
const FINGERPRINT =
  /\.onConflictDoUpdate\(\{[\s\S]{0,240}target:\s*\[\s*searchDocuments\.workspaceId/;

test("搜索投影的冲突键只在一处被拼装（内联 target 的写法已绝迹）", () => {
  const offenders: string[] = [];
  for (const file of walk(API_ROOT)) {
    if (file === SOLE_OWNER) continue;
    if (FINGERPRINT.test(readFileSync(file, "utf8"))) offenders.push(file);
  }
  // 批量重建那条（modules/search/service.ts）用的是 `excluded.*` 语义，
  // 判据刻意**不**匹配它——那是另一件事（整批重灌，不是请求路径的单条投影）。
  // 但如果哪天它也内联拼键了，这里会把它算进来，那正是要抓的。
  assert.deepEqual(
    offenders,
    [],
    "这些文件自己内联拼了搜索文档的冲突键，必须改成从 "
    + "lib/search-index-upsert.ts 的 SEARCH_DOCUMENT_CONFLICT_TARGET 取："
    + offenders.map((f) => f.replace(API_ROOT, "")).join(", ")
    + "\n冲突键多写一处，后果是「同一篇笔记出现两条」或「搜到的还是旧正文」——"
    + "两者都不报错，只能靠 drift 检测事后发现。",
  );
  // 反过来：共享模块自己**必须**还持有这处拼装，否则判据就成了空跑
  assert.ok(
    /target:\s*\[\s*\.\.\.SEARCH_DOCUMENT_CONFLICT_TARGET/.test(readFileSync(SOLE_OWNER, "utf8")),
    "共享模块自己反而不拼键了——那本文件与三处调用方之间的契约断了",
  );
});

test("两个调用方都经由共享实现，而不是各写一份", () => {
  // 光钉住冲突键不够：还要确认两边**真的**走那一份。
  // 只检查薄壳里出现调用名，是因为一个文件可以"调用了共享函数，同时自己还留着一份死代码"。
  for (const rel of ["modules/note/search-projection.ts", "modules/source/service.ts"]) {
    const source = readFileSync(join(API_ROOT, rel), "utf8");
    assert.ok(
      source.includes("upsertSearchProjection("),
      rel + " 没有调用共享的 upsertSearchProjection——两处可能又各写了一份",
    );
    assert.ok(
      !FINGERPRINT.test(source),
      rel + " 里仍然内联着冲突键——薄壳之外还有一份实现",
    );
  }
  // 第三处走的是共享常量（执行模型不同：没有外层事务，不该被并进 savepoint 那一路）
  // 2026-09-30（B3）：search-index.ts 只有一个消费者，已归位到 modules/import/。
// 判据的对象是「第三份逐字副本有没有取共享常量」，不是它在哪个目录。
const STANDALONE = join(API_ROOT, "modules", "import", "search-index.ts");
const standalone = readFileSync(STANDALONE, "utf8");
  assert.ok(
    standalone.includes("SEARCH_DOCUMENT_CONFLICT_TARGET"),
    "modules/import/search-index.ts 没有从共享常量取冲突键——第三份逐字副本还活着",
  );
  assert.ok(
    !/target:\s*\[\s*searchDocuments\./.test(standalone),
    "modules/import/search-index.ts 里仍然内联着冲突键",
  );
});

test("【自证】特征串真的会认出来：造一份旧式内联实现必须被抓", () => {
  // 判据只认 `target: [searchDocuments.…]` 这种**内联数组**。
  // 这里照收敛之前的写法手写一份：它是"如果有人把代码搬回去"会出现的形状，
  // 判据必须认得出它，否则上面两条检查在真实回归面前会跑空。
  const oldStyle = `
    await tx.insert(searchDocuments)
      .values(docs)
      .onConflictDoUpdate({
        target: [searchDocuments.workspaceId, searchDocuments.objectType, searchDocuments.objectId],
        set: { title: sql\`excluded.title\` },
      });`;
  assert.ok(
    FINGERPRINT.test(oldStyle),
    "自证样本没造好：旧式内联拼键的写法竟然没被特征串认出——"
    + "那上面两条检查在真实回归面前会跑空",
  );

  // 收敛后的真实代码**不该**再内联拼键（自证不该改动磁盘上的文件）
  for (const rel of [
    "lib/search-index-upsert.ts",
    "modules/import/search-index.ts",
    "modules/note/search-projection.ts",
    "modules/source/service.ts",
    "modules/search/service.ts",
  ]) {
    const text = readFileSync(join(API_ROOT, rel), "utf8");
    assert.ok(
      !FINGERPRINT.test(text),
      rel + " 里仍���内联拼着冲突键——收敛没有真正生效",
    );
  }
});
