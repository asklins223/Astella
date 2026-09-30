import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_OPEN_DOCUMENTS_PER_USER,
  closeUserDocumentSlot,
  noteCollaboration,
  openDocumentCountFor,
  openUserDocumentSlot,
} from "../modules/note/collaboration.ts";

/**
 * P1-14：常驻文档数必须封顶。
 *
 * ## 收口前的状态
 *
 * `note/collaboration.ts` 配了 `debounce` 与 `quiet`，**没有任何内存上限**。
 * 审计建议的 `maxDirectConnections` 在 Hocuspocus 4.7 里**不存在**
 * （该版本的 Server 配置项没有它，node_modules 全量也搜不到这个名字），
 * 所以那半条建议按原文不可执行。
 *
 * 真正能封住的是两件事：
 *   1. `unloadImmediately: true` —— 最后一条连接断开就卸文档。
 *      4.7 的默认值已经是 true，但那是**别人的默认值**；写出来才能被测、
 *      也才能让读代码的人知道「doc 数由什么封顶」。
 *   2. 按「人 × 空间」计的**并发文档**额度 —— 封住「同一个人同时连着很多篇」。
 *
 * 额度逻辑导出成可测的纯函数（`openUserDocumentSlot` / `closeUserDocumentSlot`），
 * 是因为它一旦写错，后果是「额度单调增长直到谁都连不上」，而那种 bug 在
 * 集成层面要连很多次 socket 才看得见。
 *
 * ## 额度记文档而不是连接
 *
 * 同一篇开两个标签页是正常用法，记连接会把它当两格；记文档则只占一格。
 * 引用计数是为了让「最后一格」断开时才真正释放。
 */

const SRC = join(new URL("..", import.meta.url).pathname, "modules", "note", "collaboration.ts");
const user = "user-memory-bound-probe";
const doc = (n: number) => `note-${n}`;

/**
 * 全部断开。
 *
 * 每篇要 close **两次**：测试里故意让 doc(0) 开过两条连接（多标签页），
 * 只 close 一次会留下一格，于是"额度会单调耗尽"那条断言测到的是夹具残留
 * 而不是实现问题。
 */
function releaseAll(u: string) {
  // 0..63 覆盖"开满额度"那几篇；500/999 是"额度用完还能重开"那条用的，
  // 漏掉它们会让下一条用例测到的是上一条残留的额度。
  for (let i = 0; i < 64; i += 1) {
    closeUserDocumentSlot(u, doc(i));
    closeUserDocumentSlot(u, doc(i));
  }
  for (const n of [500, 999]) {
    closeUserDocumentSlot(u, doc(n));
    closeUserDocumentSlot(u, doc(n));
  }
  assert.equal(openDocumentCountFor(u), 0, "releaseAll 之后必须干净，否则下面几条测的是残留");
}

test("额度按文档计：同一篇开两条连接只占一格", () => {
  assert.equal(openDocumentCountFor(user), 0);
  assert.equal(openUserDocumentSlot(user, doc(0)), true);
  assert.equal(openUserDocumentSlot(user, doc(0)), true, "同一篇再开一条应当放行");
  assert.equal(openDocumentCountFor(user), 1, "两条连接在**同一篇**上，只占一格");
  // 关掉一条还占着；关掉最后一条才释放
  closeUserDocumentSlot(user, doc(0));
  assert.equal(openDocumentCountFor(user), 1, "还剩一条连接，仍占一格");
  closeUserDocumentSlot(user, doc(0));
  assert.equal(openDocumentCountFor(user), 0, "最后一条断了才释放");
});

test("开满额度后第 N+1 篇被拒（这才是内存上限生效的样子）", () => {
  for (let i = 0; i < MAX_OPEN_DOCUMENTS_PER_USER; i += 1) {
    assert.equal(openUserDocumentSlot(user, doc(i)), true, `第 ${i + 1} 篇应当放行`);
  }
  assert.equal(openDocumentCountFor(user), MAX_OPEN_DOCUMENTS_PER_USER);
  assert.equal(openUserDocumentSlot(user, doc(999)), false, "超额度必须被拒");
  assert.equal(openDocumentCountFor(user), MAX_OPEN_DOCUMENTS_PER_USER, "被拒的那次不占额度");
  // 已在额度内的文档继续开连接仍然放行（多标签页不是滥用）
  assert.equal(openUserDocumentSlot(user, doc(0)), true);
  releaseAll(user);
  assert.equal(openDocumentCountFor(user), 0, "全部断开后必须回到 0——否则额度会单调耗尽");
});

test("额度按人隔离：A 用满了不影响 B", () => {
  for (let i = 0; i < MAX_OPEN_DOCUMENTS_PER_USER; i += 1) openUserDocumentSlot(user, doc(i));
  assert.equal(openUserDocumentSlot(user, doc(999)), false);
  assert.equal(openUserDocumentSlot("other-user", doc(0)), true, "另一个人应当照常放行");
  assert.equal(openUserDocumentSlot("other-user", doc(1)), true);
  releaseAll(user);
  closeUserDocumentSlot("other-user", doc(0));
  closeUserDocumentSlot("other-user", doc(1));
});

test("额度用完还能重新打开（归还后不是永久拉黑）", () => {
  for (let i = 0; i < MAX_OPEN_DOCUMENTS_PER_USER; i += 1) openUserDocumentSlot(user, doc(i));
  assert.equal(openUserDocumentSlot(user, doc(500)), false);
  closeUserDocumentSlot(user, doc(0));
  assert.equal(openUserDocumentSlot(user, doc(500)), true, "腾出一格就该能再用");
  releaseAll(user);
});

test("unloadImmediately 被显式写成 true（不依赖库的默认值）", () => {
  const source = readFileSync(SRC, "utf8");
  assert.match(source, /unloadImmediately:\s*true/,
    "unloadImmediately 必须显式为 true——4.7 的默认值恰好也是 true，"
    + "但那是别人的默认值，库一改就静默开始漏常驻文档");
});

test("onDisconnect 钩子接上了释放（否则额度只增不减）", () => {
  // 读源码而不是问实例：onDisconnect 是**传给构造函数的配置**上的钩子，
  // 它不会挂在 Hocuspocus 实例上（第一版去问实例，于是恒为 undefined）。
  const source = readFileSync(SRC, "utf8");
  assert.match(source, /onDisconnect\(\{ context \}\)/, "onDisconnect 钩子不见了");
  assert.match(
    source,
    /onDisconnect[\s\S]{0,300}closeUserDocumentSlot\(context\.userId, context\.noteId\)/,
    "onDisconnect 没有调用 closeUserDocumentSlot——额度就只增不减："
    + "开着 8 篇用一天，最后谁都连不上",
  );
  assert.ok(noteCollaboration, "noteCollaboration 实例应当能构造出来（否则上面的配置没接上）");
});

test("超额度是拒绝连接而不是排队（排队等于把内存上限推迟成连接数）", () => {
  const source = readFileSync(SRC, "utf8");
  const start = source.indexOf("async onAuthenticate");
  const end = source.indexOf("async onLoadDocument", start);
  const auth = source.slice(start, end);
  assert.match(auth, /throw new Error\("too_many_open_documents"\)/, "超额度必须抛错断开");
  assert.doesNotMatch(auth, /await new Promise|setTimeout/,
    "这里出现了等待或排队——那会让内存上限退化成连接数上限");
});
