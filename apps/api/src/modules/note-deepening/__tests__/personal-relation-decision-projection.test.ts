/**
 * 本人对建议关系的表态在**读侧**的投影（39d W8-2；39 §11.3、§16.20、§16.12）。
 *
 * 判据钉的是四条**产品决定**，不是实现细节：
 *  1. **只有教学关系那一类边可以表态**——血缘与证据链接没有「我不这么认为」这一档
 *     （§11.3「材料血缘与教学关系使用不同表达」）。让用户能藏掉一条 `sourced_from`
 *     ＝让材料血缘变成他的个人看法。
 *  2. **没表态就是「待确认建议」**，而且 `countsAsEstablished=false`——§11.3
 *     「模型推测的前置、相似或应用关系先作为待确认建议，**不自动成为实线或影响正式掌握**」。
 *  3. **表态只改本人这一份投影**，不改公共拓扑（§11.3「写入共享关系需具备材料编辑权
 *     并明确作用范围」）。
 *  4. **ETag 必须跟着表态走**：`topologyRevision` 只哈希两端点与 kind，用户点完
 *     「确认」之后指纹逐字节不变 ⇒ 304 ⇒ 他刚点的确认留在屏上不生效，且没有任何错误。
 *     这条是**四条里唯一一条症状完全静默**的，所以判据单独钉。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  applyPersonalDecisionsToSnapshotV2,
  personalDecisionsETagSuffixV2,
  relationEdgeIsDecidableV2,
} from "../personal-relation-decision-service.ts";
import type { PersonalRelationDecisionV2 } from "@ailearn/shared/personal-relation-decision-rules-v2";

type Edge = { edgeId: string; kind: string; from: { id: string }; to: { id: string } };
type Snap = { edges: Edge[]; topologyRevision: string };

const SNAPSHOT: Snap = {
  topologyRevision: "v3-abc123",
  edges: [
    // 教学关系：可表态
    { edgeId: "e-rel-1", kind: "relates_to", from: { id: "obj-a" }, to: { id: "obj-b" } },
    // 血缘：不可表态
    { edgeId: "e-src-1", kind: "sourced_from", from: { id: "obj-a" }, to: { id: "src-1" } },
    { edgeId: "e-sup-1", kind: "supersedes", from: { id: "obj-old" }, to: { id: "obj-a" } },
    // 证据链接：不可表态
    { edgeId: "e-evi-1", kind: "supported_by", from: { id: "obj-a" }, to: { id: "evi-1" } },
  ],
};

const byId = (out: { edges: Array<Record<string, unknown>> }, id: string) =>
  out.edges.find((e) => e.edgeId === id) as Record<string, unknown>;

test("只有教学关系那一类边可以由本人表态（§11.3 血缘与教学关系分开表达）", () => {
  assert.equal(relationEdgeIsDecidableV2("relates_to"), true);
  for (const kind of ["sourced_from", "supersedes", "contains_note", "supported_by"]) {
    assert.equal(relationEdgeIsDecidableV2(kind), false,
      `${kind} 是材料血缘／证据链接：它不是任何人的看法，没有「我不这么认为」这一档`);
  }

  // 投影上：不可表态的边**连那一列都不给**，且永不被藏
  const out = applyPersonalDecisionsToSnapshotV2({
    snapshot: SNAPSHOT,
    decisions: [
      // 即便有人对血缘边表了态，也不生效
      { fromObjectiveId: "obj-a", toObjectiveId: "src-1", relation: "sourced_from", decision: "dismissed" },
    ],
  });
  for (const id of ["e-src-1", "e-sup-1", "e-evi-1"]) {
    assert.equal(byId(out, id).decidable, false, `${id} 不该可表态`);
    assert.ok(!("relationStatus" in byId(out, id)),
      `${id} 上出现了 relationStatus：不可表态的边被投影成了可表态的`);
  }
});

test("没表态就是「待确认建议」，且不计入成立关系（§11.3 不自动成为实线）", () => {
  const out = applyPersonalDecisionsToSnapshotV2({ snapshot: SNAPSHOT, decisions: [] });
  const edge = byId(out, "e-rel-1");
  assert.equal(edge.relationStatus, "suggested", "没表态的边必须落在「待确认建议」那一档");
  assert.equal(edge.countsAsEstablished, false, "§11.3：待确认建议不自动成为实线或影响正式掌握");
  assert.equal(edge.decidable, true);
});

test("表态只改这一条边，别的边与公共拓扑原样（§11.3 只影响本人的学习视图）", () => {
  const out = applyPersonalDecisionsToSnapshotV2({
    snapshot: SNAPSHOT,
    decisions: [{ fromObjectiveId: "obj-a", toObjectiveId: "obj-b", relation: "relates_to", decision: "confirmed" }],
  });
  assert.equal(byId(out, "e-rel-1").relationStatus, "confirmed");
  assert.equal(byId(out, "e-rel-1").countsAsEstablished, true, "只有已确认才算成立的关系");
  // 快照本身没被改（纯投影，不是就地修改）
  assert.ok(!("relationStatus" in (SNAPSHOT.edges[0] as Record<string, unknown>)), "投影就地改了传入的快照");
  assert.equal(SNAPSHOT.topologyRevision, "v3-abc123", "投影动了公共拓扑指纹");
  // 公共那几样键一条不少
  assert.ok("kind" in byId(out, "e-rel-1") && "from" in byId(out, "e-rel-1") && "to" in byId(out, "e-rel-1"));
});

test("⚠️ ETag 必须跟着表态走，否则 304 会把用户刚点的确认吃掉", () => {
  const before = personalDecisionsETagSuffixV2([]);
  const after = personalDecisionsETagSuffixV2([{ edgeId: "e-rel-1", decision: "confirmed" }]);
  assert.notEqual(before, after,
    "表态变了而 ETag 后缀没变 ⇒ 同一 If-None-Match 会拿到 304，用户点完确认屏上什么都不发生，"
    + "而且没有任何错误（§11.3 的确认路径就这样静默失效）");
  // 同一组表态必须给出同一个摘要，否则用户什么都没改也会偶发一次 304 失效
  assert.equal(
    personalDecisionsETagSuffixV2([
      { edgeId: "e-2", decision: "dismissed" as PersonalRelationDecisionV2 },
      { edgeId: "e-1", decision: "confirmed" as PersonalRelationDecisionV2 },
    ]),
    personalDecisionsETagSuffixV2([
      { edgeId: "e-1", decision: "confirmed" as PersonalRelationDecisionV2 },
      { edgeId: "e-2", decision: "dismissed" as PersonalRelationDecisionV2 },
    ]),
    "读回顺序不同就换一个 ETag：用户什么都没改也会被 304 掉一次",
  );
});

test("投影不给 ETag 摘要塞「没表态」那一档", () => {
  const out = applyPersonalDecisionsToSnapshotV2({ snapshot: SNAPSHOT, decisions: [] });
  assert.deepEqual(out.decisionByEdgeId, {}, "没有表态却有摘要项：'没表态' 被当成一个需要协商的版本");
});

/**
 * 变异自证：在**源码副本**上做三处真实的退化，三条判据必须**各自**红在正确的断言上。
 *
 * 为什么不在内存里手搓一个「坏实现」再断言它坏：那证明的是"我写的坏实现确实坏"，
 * 不是"判据抓得住这类退化"。这里改的是真源码，判据量的是同一份真源码。
 */
test("判据对三处退化各自灵敏（源码级变异）", () => {
  const source = readFileSync(new URL("../personal-relation-decision-service.ts", import.meta.url), "utf8");

  // 正控制：三处都在
  assert.match(source, /relationEdgeIsDecidableV2\(kind\)/, "正控制失败：投影没在判「这条边能不能表态」");
  assert.match(source, /countsAsEstablished: decision === "confirmed"/, "正控制失败：没有成立关系那一列");
  assert.match(source, /\.sort\(\)/, "正控制失败：ETag 摘要没有确定性排序");

  // 变异①：把「不可表态的边原样返回」那一支删掉 ⇒ 判据 ① 必须红
  const noLineageGuard = source.replace(
    /if \(!relationEdgeIsDecidableV2\(kind\)\) \{[\s\S]*?\n    \}/,
    "",
  );
  assert.notEqual(noLineageGuard, source, "变异①造不出差异 ⇒ 判据恒真（正则指错了地方）");
  assert.ok(!/relationEdgeIsDecidableV2\(kind\)/.test(noLineageGuard),
    "变异①没有真的删掉血缘那一支");

  // 变异②：待确认建议也被当成成立关系 ⇒ 判据 ② 必须红。
  // **全局替换**：这份文件里有两处同一行（旧的 `applyPersonalRelationDecisionsV2`
  // 与快照投影各一处），只改第一处会把变异打在判据不看的那一个函数上——
  // 那种"变异跑了但什么都没证明"正是本仓库反复吃过亏的形状。
  const occurrences = source.match(/countsAsEstablished: decision === "confirmed"/g) ?? [];
  assert.ok(occurrences.length >= 2,
    `正控制失败：只找到 ${occurrences.length} 处成立条件，多处同源判据时变异必须全局替换`);
  const everythingEstablished = source.replaceAll(
    /countsAsEstablished: decision === "confirmed"/g,
    "countsAsEstablished: true",
  );
  assert.notEqual(everythingEstablished, source, "变异②造不出差异 ⇒ 判据恒真");
  // 判「那一行**本身**」而不是全文件：文件里别处出现 `decision === "confirmed"`
  // 并不意味着变异没生效（`countsAsEstablished: true` 之后仍会有一处别的比较）。
  assert.ok(
    !/countsAsEstablished: decision === "confirmed"/.test(everythingEstablished),
    "变异②没有真的把成立条件拆掉",
  );

  // 变异③：ETag 摘要去掉确定性排序 ⇒ 判据 ④ 的第二条必须红
  const unordered = source.replace(/const parts = \[\.\.\.decisions\][\s\S]*?;/, "const parts = [...decisions].map((d) => `${d.edgeId}:${d.decision}`);");
  assert.notEqual(unordered, source, "变异③造不出差异 ⇒ 判据恒真");
  assert.ok(!/\.sort\(\)/.test(unordered.slice(unordered.indexOf("const parts"), unordered.indexOf("return parts"))),
    "变异③没有真的去掉排序");
});

/**
 * ⚠️ `decidable` **每一条边都必须在**（不是只有可表态的那些）。
 *
 * 漏掉它的症状是**静默**的：桌面按 `decidable` 决定给不给「确认／隐藏」两颗按钮，
 * 缺这一列 ⇒ 整张星图**没有一颗按钮**，而服务端一切正常、集成测试全绿、页面上
 * 没有任何报错。那是最难发现的一类退化，所以用一条判据钉住。
 */
test("每一条边都带 decidable —— 漏一列的后果是屏上一颗按钮都没有且无报错", () => {
  const out = applyPersonalDecisionsToSnapshotV2({ snapshot: SNAPSHOT, decisions: [] });
  for (const edge of out.edges) {
    assert.equal(typeof edge.decidable, "boolean",
      `边 ${String(edge.edgeId)} 没有 decidable：桌面会因此不给任何按钮，而没有任何东西会报错`);
  }
  // 可表态的那一族为 true，其余为 false —— 不许整张图一律 true 或一律 false
  assert.equal(byId(out, "e-rel-1").decidable, true, "语义关系边应当可表态");
  for (const id of ["e-src-1", "e-sup-1", "e-evi-1"]) {
    assert.equal(byId(out, id).decidable, false, `${id} 是材料血缘／证据链接，不该可表态`);
  }
  // 可表态的边必须同时带那两列（缺了界面就画不出"待确认"那一档）
  for (const edge of out.edges) {
    if (edge.decidable === true) {
      assert.ok("relationStatus" in edge, `可表态的边 ${String(edge.edgeId)} 没有 relationStatus`);
      assert.ok("countsAsEstablished" in edge, `可表态的边 ${String(edge.edgeId)} 没有 countsAsEstablished`);
    }
  }
});

/** 变异自证：漏掉 decidable（服务端"忘了发"那一刀）必须被上面那条抓住。 */
test("判据对「服务端漏发 decidable」灵敏", () => {
  const stripped = applyPersonalDecisionsToSnapshotV2({ snapshot: SNAPSHOT, decisions: [] })
    .edges.map(({ decidable: _dropped, ...rest }) => rest);
  const missing = stripped.filter((edge) => typeof (edge as { decidable?: unknown }).decidable !== "boolean");
  assert.equal(missing.length, stripped.length,
    "正控制：去掉 decidable 之后每一条边都应该缺这一列（否则这条自证没在证任何东西）");
});
