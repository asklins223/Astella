import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * P2-10 后半项的落地：搜索投影**不会**被无谓重写。
 *
 * ## 审计说的是"改增量/延迟批量"，但前提不成立
 *
 * 审计原文是"autosave 的搜索索引改增量/延迟批量"。2026-09-29 实读
 * `modules/note/collaboration.ts:243`：
 *
 * ```ts
 * if (stored && Buffer.compare(stored.state, next) === 0) return;
 * ```
 *
 * **文档没变就整趟 flush 都不做**，搜索投影自然也不会被重写。
 * 而变了的那次——它**必须**重写：`search_documents.body` 就是整篇正文，
 * 搜索的 snippet 与 `regexp_count`（P0-7）都要它。
 *
 * 也就是说"每次自动保存都重写一遍索引"这件事**已经不成立**了。
 *
 * ## 那"增量"为什么在这里不适用
 *
 * 增量索引要成立，得能把"只改了第 k 块"表达成"只更新 body 的第 k 段"。
 * 现在 `search_documents` 是**一行一文档**，`body` 是一整段文本——
 * 表达不了局部更新。要支持它，得先把投影拆成按块分行，那是换一种投影形态，
 * 不是给现有 upsert 加个开关。
 *
 * 所以这里的结论是：**这一半不需要改代码，需要的是别把那句早退弄丢了。**
 * 下面两条守的就是它。
 *
 * ## 判据的对象
 *
 * 不是"投影写得快不快"，是"**没变就不写**"这个不变量还在不在。
 */

const API_ROOT = new URL("..", import.meta.url).pathname;
const COLLAB = join(API_ROOT, "modules", "note", "collaboration.ts");
const DOC_STATE = join(API_ROOT, "modules", "note", "document-state.ts");

test("文档没变就整趟 flush 都不做（这一句是防重写索引的唯一屏障）", () => {
  const source = readFileSync(COLLAB, "utf8");
  assert.ok(
    /if \(stored && Buffer\.compare\(stored\.state, next\) === 0\) return;/.test(source),
    "协同落盘里那句『文档没变就返回』不见了——"
    + "于是**每一次**自动保存都会重写整篇正文的搜索投影，"
    + "而对大文档那是 O(全文) 的一次写。（P2-10 实测：这一句 2026-09-29 之前就在，"
    + "所以审计说的『autosave 每次都重写索引』本来就不成立。）",
  );
});

test("早退必须排在投影之前，而不是之后", () => {
  const source = readFileSync(COLLAB, "utf8");
  const guard = source.indexOf("Buffer.compare(stored.state, next)");
  const persist = source.indexOf("await persistNoteDoc(");
  assert.ok(guard > 0 && persist > 0, "自证：两处都要找得到");
  assert.ok(guard < persist,
    "『没变就返回』必须排在 persistNoteDoc 之前——"
    + "排在之后等于先写了一遍索引再返回，白改");
});

test("投影写在与正文同一个事务里（它失败要能一起回滚）", () => {
  const source = readFileSync(DOC_STATE, "utf8");
  const at = source.indexOf("await upsertSearchDocument(tx");
  assert.ok(at > 0, "自证：document-state.ts 里应当还有那一次投影写");
  // 形参是 `tx`（调用方的事务），不是裸 db——否则投影与正文会分属两个事务
  const head = source.slice(Math.max(0, at - 400), at);
  assert.ok(
    /export async function persistNoteDoc\(\s*\n?\s*tx: ApiTransaction/.test(source),
    "persistNoteDoc 的第一个形参应当是调用方的事务——"
    + "只有这样搜索投影写失败才会与正文一起回滚，不会留下『正文新、索引旧』的错位。",
  );
  void head;
});

test("【自证】判据会红：把那一句早退删掉必须被抓", () => {
  const real = readFileSync(COLLAB, "utf8");
  const stripped = real.replace(
    /if \(stored && Buffer\.compare\(stored\.state, next\) === 0\) return;\n/,
    "",
  );
  assert.ok(
    !/Buffer\.compare\(stored\.state, next\)/.test(stripped),
    "自证样本没造好：删掉之后应当认不出那句",
  );
  assert.ok(
    /Buffer\.compare\(stored\.state, next\)/.test(real),
    "自证：磁盘上那一句还在",
  );
});
