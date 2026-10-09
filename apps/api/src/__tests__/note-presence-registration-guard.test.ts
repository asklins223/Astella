import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * 在场登记发生在**哪一步**的形状守卫。
 *
 * 行为用例能证明"登记与销号本身是对的"，但证不了"它发生在两道拒绝之后"：
 * 把 `openNotePresenceSlot` 挪到 `shareScope` 那一档之前，所有行为用例照样绿，
 * 而界面上会出现「作者还没共享出去的那一篇，在别人那一排里挂着作者的名字」。
 * 这一条只能在源码里看顺序，所以它是一份守卫，不是行为测试。
 */

const SOURCE = join(new URL("..", import.meta.url).pathname, "modules", "note", "collaboration.ts");

test("在场登记排在共享那一档与并发额度之后", () => {
  const source = readFileSync(SOURCE, "utf8");
  const start = source.indexOf("async onAuthenticate");
  const end = source.indexOf("async onLoadDocument", start);
  assert.ok(start > -1 && end > start, "onAuthenticate 不见了，这条守卫读不到任何东西");
  const authenticate = source.slice(start, end);
  const shareGate = authenticate.indexOf('throw new Error("not_shareable")');
  const quotaGate = authenticate.indexOf('throw new Error("too_many_open_documents")');
  const register = authenticate.indexOf("openNotePresenceSlot(");
  assert.ok(shareGate > -1 && quotaGate > -1 && register > -1, "共享那一档、并发额度与在场登记三个都得在 onAuthenticate 里");
  assert.ok(shareGate < register, "私有笔记的连接**先被拒**才登记：否则没共享出去的那一篇会出现在别人的在场里");
  assert.ok(quotaGate < register, "被额度拒掉的连接不该留下名字");
});
