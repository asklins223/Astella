/**
 * **每一条拓扑边都必须带上 `decidable`**，而且它的值只能来自**那一份**规则
 * （39d W8-2；§11.3）。
 *
 * ## 它是被一次真实回归带出来的
 *
 * W8-2 把 `decidable` 从 `.default(false)` 改成**必填**——理由是「缺这一格会被读成
 * 不可表态，而症状是**所有按钮都消失**、没有任何报错」。
 * 改完只修了两个夹具，**漏了 `topology-repository.ts`**：那儿有五处 `edges.push({…})`
 * 直接构造边，于是一个 typecheck 错在 HEAD 上躺了好几轮没人认领
 * （那个文件的属主刚收工，这一格就没人认领了）。
 *
 * 必填是对的：**可选格**的读法会编译过、而在缺格的那条边上读到 `undefined`，
 * 屏上就是「她对这条关系没有表态」而不是「不可表态」——**两件事长得一样**。
 *
 * ## 为什么判据钉「值来自同一份规则」而不是钉「值是 true/false」
 *
 * 钉字面量会出现两份判据：这一条说 `sourced_from` 是 `false`，另一条说
 * `DECIDABLE_RELATION_EDGE_KINDS_V2` 里有什么。改其中一份，另一份就红。
 * 钉**「它调的是那一份」**，规则改了这里跟着走，而**改错了值两处一起红**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { relationEdgeIsDecidableV2 } from "../modules/understanding-v3/personal-relation-decision-service.ts";

const REPO = resolve(import.meta.dirname, "..", "..");
const REPO_SRC = readFileSync(
  resolve(REPO, "src/modules/understanding-v3/topology-repository.ts"), "utf8",
);
/** 只判代码，不判注释（台账 §3 纪律：源码形状判据要判代码）。 */
const CODE = REPO_SRC
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

test("每一处 `edges.push` 都带上了 `decidable`", () => {
  // 逐个 push 块切出来看，而不是数出现次数——数次数量的是"我写了几个字"，
  // 不是"每条边都有没有"。
  const blocks = [...CODE.matchAll(/edges\.push\(\{[\s\S]*?\}\);/g)].map((m) => m[0]);
  assert.ok(blocks.length >= 5, `只找到 ${blocks.length} 处 edges.push，判据可能指错了地方`);
  for (const block of blocks) {
    assert.match(
      block,
      /decidable:\s*relationEdgeIsDecidableV2\(/,
      `这一条边没有 decidable，或它的值不是来自那一份规则：\n${block.slice(0, 160)}`,
    );
  }
});

test("规则本身：只有 `relates_to` 可表态，血缘与证据边不可", () => {
  // §11.3：「材料血缘与教学关系使用不同表达」——`sourced_from`／`supersedes`／
  // `contains_note` 说的是**材料怎么来的**，不是任何人的看法，所以没有「我不这么认为」；
  // `supported_by` 指向具体证据，同理。
  for (const kind of ["sourced_from", "supersedes", "contains_note", "supported_by"]) {
    assert.equal(relationEdgeIsDecidableV2(kind), false, `${kind} 被判成可表态了：血缘与证据边没有「我不这么认为」这一档`);
  }
  assert.equal(relationEdgeIsDecidableV2("relates_to"), true, "relates_to 不可表态：W8-2 那一整格就没有入口了");
  // 未知的种类**不得**默认成可表态——那会让将来新增的一族边默认长出按钮。
  assert.equal(relationEdgeIsDecidableV2("将来新增的那种"), false, "未知种类被放行了：新增一族边会默认长出表态按钮");
});

/** 变异自证：去掉任意一处的 decidable，上面第一条必须红。 */
test("判据对「删掉某一处 decidable」灵敏", () => {
  const mutated = CODE.replace(/decidable:\s*relationEdgeIsDecidableV2\("sourced_from"\),\s*/, "");
  assert.notEqual(mutated, CODE, "变异造不出差异 ⇒ 判据恒真（那句话的形状变了，先改判据再改实现）");
  const blocks = [...mutated.matchAll(/edges\.push\(\{[\s\S]*?\}\);/g)].map((m) => m[0]);
  const missing = blocks.filter((b) => !/decidable:\s*relationEdgeIsDecidableV2\(/.test(b));
  assert.equal(missing.length, 1, `变异没有正好打掉一处（实到 ${missing.length} 处）：判据量错了对象`);
});
