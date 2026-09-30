/**
 * 星图三层展开**读侧**的判据（39d W8-1、W8-3；39 §11.2、§11.4、§11.5、§16.12）。
 *
 * 判据分两半，理由写在各自那一段的注释里：
 *  - **纯函数那一半**（作答形态、反馈、目标状态、limit）：能对着函数直接验的，
 *    就不要去读源码。
 *  - **源码形状那一半**：判的是"**这一发不许问哪张表、哪一列**"——那是纯函数
 *    看不见的决定，而且正是最容易悄悄回退的地方（多查一次 `relations` 就多一个
 *    关系的出处；少判一次 `locked` 就把草稿当成她做过的回答）。
 *
 * **先剥注释再判**：这一份里每条判据的正对照本身就是源码里的一句注释
 * （比如"这一发不许自己查 relations"），不剥掉的话判据会因为**注释里那句话**
 * 而恒红或恒绿。W7-3 刀三踩过这个坑。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  answerOfDeepeningV3,
  feedbackOfDeepeningV3,
  objectivePersonalStateForDeepeningV3,
  resolveNoteDeepeningLimit,
  NOTE_DEEPENING_MAX_LIMIT,
} from "../note-deepening-service.ts";

const here = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/** 去掉块注释与行注释，让判据只读**代码**不读**注释**。 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const SERVICE = codeOnly(here("../note-deepening-service.ts"));
const ROUTES = codeOnly(here("../routes.ts"));

// ── 纯函数那一半 ────────────────────────────────────────────────────────

test("§11.2：结构化作答没有'一句可念的回答'，那一格如实是空的", () => {
  // 正对照：散文与语音真的给出文本。
  assert.deepEqual(answerOfDeepeningV3({ kind: "text", text: "  索引把扫描范围降下来了  " }), {
    form: "prose",
    text: "索引把扫描范围降下来了",
  });
  assert.deepEqual(answerOfDeepeningV3({ kind: "voice", confirmedTranscript: "先看扫描了多少行" }), {
    form: "voice_transcript",
    text: "先看扫描了多少行",
  });
  // 结构性那几档：形态说清是结构化，**文本是 null**。
  for (const payload of [
    { kind: "choice", selectedOptionId: "b", interactionRefs: [] },
    { kind: "ordering", orderedTokenIds: ["a"], interactionRefs: [] },
    { kind: "matching", assignments: [], interactionRefs: [] },
    { kind: "true_false", answer: true, interactionRefs: [] },
  ]) {
    const out = answerOfDeepeningV3(payload);
    assert.equal(out.form, "structured");
    assert.equal(out.text, null,
      "写成'用户选择了 B'是让屏上多一句系统自己造的句子（§11.2 不伪造）");
  }
  // 认不出的负载不猜：形态 none、文本 null。
  assert.deepEqual(answerOfDeepeningV3({ kind: "something_new" }), { form: "none", text: null });
  assert.deepEqual(answerOfDeepeningV3(null), { form: "none", text: null });
});

test("§11.2 反馈：只带给人看的那一句，没有理由就不列", () => {
  const out = feedbackOfDeepeningV3([
    { rubricItemId: "r1", facet: "explain", verdict: "partial", userFacingReason: "结果规模那一半还没有自己的例子。" },
    { rubricItemId: "r2", facet: "explain", verdict: "not_assessable", userFacingReason: "   " },
    { rubricItemId: "r3", facet: "explain", verdict: "认识不出的新判词", userFacingReason: "这句不认。" },
    { rubricItemId: "r4", facet: "explain", verdict: "covered", userFacingReason: "  讲到了。  " },
  ]);
  assert.deepEqual(out.map((item) => item.verdict), ["partial", "covered"]);
  assert.equal(out[0].reason, "结果规模那一半还没有自己的例子。");
  // 私有 rubric / 私有标准答案一个字都不带（§13.2）。
  assert.equal(Object.keys(out[0]).sort().join(","), "reason,verdict");
  // 非数组不猜。
  assert.deepEqual(feedbackOfDeepeningV3(null), []);
  assert.deepEqual(feedbackOfDeepeningV3("partial"), []);
});

test("§11.4：目标状态与拓扑那份**同一条优先级**，到期不等于没学会", () => {
  const base = {
    lifecycle: "active", hasActiveRun: false, reviewDue: false,
    scheduled: false, basisUpdated: false, hasCanonical: false,
  } as const;
  assert.equal(objectivePersonalStateForDeepeningV3(base), "unvalidated");
  assert.equal(objectivePersonalStateForDeepeningV3({ ...base, hasCanonical: true }), "stable");
  assert.equal(objectivePersonalStateForDeepeningV3({ ...base, reviewDue: true }), "due_review");
  assert.equal(objectivePersonalStateForDeepeningV3({ ...base, scheduled: true }), "scheduled");
  assert.equal(objectivePersonalStateForDeepeningV3({ ...base, basisUpdated: true }), "outdated");
  assert.equal(objectivePersonalStateForDeepeningV3({ ...base, hasActiveRun: true }), "learning");
  // 归档与被取代盖过一切：这两档是生命周期，不再是"她学得怎么样"。
  assert.equal(objectivePersonalStateForDeepeningV3({ ...base, hasActiveRun: true, lifecycle: "archived" }), "archived");
  assert.equal(objectivePersonalStateForDeepeningV3({ ...base, hasActiveRun: true, lifecycle: "superseded" }), "superseded");
});

test("§11.5：limit 越界与非法值都落到一个可预期的档，并封顶", () => {
  assert.equal(resolveNoteDeepeningLimit(undefined), 200);
  assert.equal(resolveNoteDeepeningLimit("abc"), 200);
  assert.equal(resolveNoteDeepeningLimit("0"), 200);
  assert.equal(resolveNoteDeepeningLimit("-5"), 200);
  assert.equal(resolveNoteDeepeningLimit("12"), 12);
  assert.equal(resolveNoteDeepeningLimit(String(NOTE_DEEPENING_MAX_LIMIT + 1)), NOTE_DEEPENING_MAX_LIMIT,
    "上限是一道真闸：一个越大的数会一次性把整张表搬进内存");
});

// ── 源码形状那一半：这一发不许问什么 ──────────────────────────────────────

test("§11.5：记录被截断时如实回报，不静默少列", () => {
  // `limit + 1` 那条纪律：**取到 limit+1 行**才能知道有没有超限。少取一行
  // 就永远看不到"还有更多"，而屏上那句"一共 N 条"就成了这一页的条数。
  assert.match(SERVICE, /const page = bounded\(artifactRows, limit\)/,
    "记录那一页必须走探针封顶");
  assert.match(SERVICE, /recordsComplete: page\.complete/,
    "截断事实要原样交出去，屏上才拿得到'不许报总数'的那一格");
  assert.doesNotMatch(SERVICE, /recordsComplete:\s*true\b/,
    "恒为 true 等于永远敢报总数——那正是 §11.5「截断数据明确说明」的反面");
});

test("§12.3 / §11.2：只读 locked 作答——草稿不是她做过的回答", () => {
  assert.match(SERVICE, /eq\(learningArtifacts\.status,\s*"locked"\)/,
    "少了这一条，保存到一半的草稿会作为一条'真实回答'出现在证据详情里");
});

test("§11.3：关系只有**一个出处**——这一发不许自己再读一遍 relations", () => {
  // 两条 `relations` 的出处（W8-2 的投影与这里自己查 revision.relations）会在
  // 本人收起一条关系时给出两个不同答案，而且没有任何错误。
  assert.doesNotMatch(SERVICE, /relations:\s*learningObjectiveRevisionsV2\.relations/,
    "关系由拓扑快照那一处给出（route 把已叠好表态的边传进来）；"
    + "这一发再读一次 relations 就是第二个出处");
  assert.match(SERVICE, /snapshotEdges/,
    "读法要认 route 传进来的那份已投影的边");
});

test("§11.4：「独立 / 借助」只从暴露记录判，不拿评估器的判词反推", () => {
  // `partial` / `missing` 说的是"**讲到了没有**"，不是"**有没有人帮**"。
  // 拿它当「借助」就是把一句关于题面的判词改写成一句关于她本人的话。
  assert.match(SERVICE, /learningExposuresV2/,
    "「有人帮过」有直接的凭据：答案揭示／证据揭示的暴露记录");
  const axisBlock = SERVICE.slice(
    SERVICE.indexOf("let independentCount = 0"),
    SERVICE.indexOf("let independentCount = 0") + 2000,
  );
  assert.doesNotMatch(axisBlock, /verdict/,
    "独立/借助那一段不许读 rubric 判词——那是'讲到了没有'，不是'有没有人帮'");
});

test("§16.20：别人的私有目标不进这一篇的层二", () => {
  assert.match(SERVICE, /visibleObjectivesCondition\(ctx\.userId/,
    "只读成员看到的路径与可见性一致（§16.20）");
  assert.match(SERVICE, /visibleNotesCondition\(ctx\.userId/,
    "笔记本体也要过可见性");
});

test("§16.13：轮次那一读点自带可见性判据，不靠函数开头的顺序", () => {
  // 开头那次 `visibleNotesCondition` 挡的是"能不能展开这一篇"；**轮次那一行**
  // 挡的是"那一轮记下的问题句会不会在失权之后仍然被念出来"（§16.13「失权后不能
  // 靠旧快照继续学」）。顺序一变它就静默失效，而功能测试全绿。
  const at = SERVICE.indexOf(".from(noteLearningRounds)");
  assert.ok(at > 0, "读不到轮次那一读点 ⇒ 这条判据空转");
  const window = SERVICE.slice(Math.max(0, at - 900), at + 900);
  assert.match(window, /visibleNotesCondition\(ctx\.userId\)/,
    "轮次那一读点没带笔记可见性判据：失权之后那一轮的问题句仍会被念出来");
  assert.match(window, /innerJoin\(notes/,
    "判据要跟着 note_id 走（join 进来），而不是只在这一发开头查一次");
});

test("§11.2：读不到就是读不到——不回一份'空的那一份'", () => {
  assert.match(SERVICE, /throw new NoteNotReadableV3\(\)/,
    "空的那一份与'这一篇真的什么都没有'在屏上长得一样");
  assert.match(ROUTES, /instanceof NoteNotReadableV3[\s\S]{0,120}404/,
    "读不到要回 404，而不是 200 + 空内容");
});

test("§11.2：有正文的笔记无需制卡即可展开——读侧不拿卡片当闸门", () => {
  // 正对照：卡片是**读出来**的一格（可选卡片 / 打开相应卡片），不是读这一篇的前置。
  assert.match(SERVICE, /cardId: objectiveId \? cardByObjective\.get\(objectiveId\) \?\? null : null/,
    "卡片要作为一条可空的链接出现在记录里（§11.2 第三行'可选卡片'）");

  // **判据钉在"最终投影的那一份入参"上，而不是通篇不许出现 `cardByObjective`**——
  // `cardByObjective` 在记录与目标那两格里本来就该出现（那是"可选卡片"这一格），
  // 只有当它决定**读回来什么**时才是把制卡当前提。所以判据圈定的是
  // `buildNoteDeepeningV3({ ... })` 的实参块：那一块里出现 `cardByObjective`
  // 就说明"有没有卡"正在决定这一篇的形状。
  const callAt = SERVICE.indexOf("return buildNoteDeepeningV3({");
  assert.ok(callAt > 0, "读不到最终投影的入参块 ⇒ 这条判据空转");
  const block = SERVICE.slice(callAt, SERVICE.indexOf("});", callAt));
  assert.ok(block.length > 0, "投影入参块读不到 ⇒ 这条判据空转");
  assert.doesNotMatch(block, /cardByObjective|cardRows|learningCardsV2/,
    "`有没有卡` 出现在最终投影的入参里：以制卡当前提，正是 §11.2 删掉的那个门槛（§16.12）");

  assert.match(SERVICE, /hasBody: Boolean\(note\.currentVersionId\)/,
    "「有正文」判的是当前版本，不是'有没有制过卡'");
});
