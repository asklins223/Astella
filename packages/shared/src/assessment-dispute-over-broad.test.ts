/**
 * 复核结论的**第四档**「原判过宽」（39d W5-5；39 §14.2，2026-09-27 由三档扩为四档）。
 *
 * ## 为什么要有这一档
 *
 * 真模型实测遇到过这一种：原判 `covered`，原回答其实只有「记不清了。」，复核逐条判
 * `missing`。三档里它无处可归——落进 `undetermined` 是**另一句话**：
 *
 *  - `undetermined` ＝ **复核自己也判不准**（§14.2「不强行选一方」）；
 *  - `over_broad` ＝ **复核可靠地说原判把没答对的算成了答对**。
 *
 * 用户该做的两件事完全不同：前者可以补充说明再等一次复核，后者该回原回答重看。
 * 把两者合成一档，等于对用户说「系统还没想清楚」，而系统其实想清楚了。
 *
 * ## 与 `corrected` 严格对称
 *
 *  - `corrected`：**全部**逐条变化都是升档 ⇒ 原判**偏严**（说没达成，实际达成了）
 *  - `over_broad`：**全部**逐条变化都是降档 ⇒ 原判**过宽**（说达成了，实际没达成）
 *
 * 混在一起的那一档仍是 `undetermined`——升档与降档同时出现时，"之差"指向两个方向，
 * 强行选一边就是 §14.2 明写不许的事。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  decideDisputedObservationV2,
  decideRecheckOutcomeV2,
  decideRecheckVerdictDiffV2,
  assessmentDisputeRecheckOutcomeV2Schema,
} from "./assessment-dispute-rules-v2.ts";

type Pair = { rubricItemId: string; verdict: string };

const v = (id: string, verdict: string): Pair => ({ rubricItemId: id, verdict: "covered" === verdict ? "covered" : verdict });

test("全降档 ⇒ 原判过宽（与「全升档 ⇒ 原判偏严」严格对称）", () => {
  // 原判说 u2 达成，复核说没达成；u1/u3 不变。
  const rechecked: Pair[] = [v("u1", "covered"), v("u2", "missing"), v("u3", "covered")];
  const diff = decideRecheckVerdictDiffV2({
    originalVerdicts: [v("u1", "covered"), v("u2", "covered"), v("u3", "covered")],
    recheckedVerdicts: rechecked,
  });
  assert.equal(diff.derivation, "over_broad",
    "原判 u2 说达成、复核说没达成，且 u1/u3 未变 ⇒ 这是原判过宽，不是「判不出来」");
  assert.equal(diff.upgradedUnitIds.length, 0, "这一档不该有任何升档");
  assert.deepEqual([...diff.notCoveredUnitIds], ["u2"]);

  // 对照：全升档仍然是 corrected（别把既有那一档改坏）
  const upgraded = decideRecheckVerdictDiffV2({
    originalVerdicts: [v("u1", "missing"), v("u2", "missing"), v("u3", "missing")],
    recheckedVerdicts: [v("u1", "covered"), v("u2", "covered"), v("u3", "covered")],
  });
  assert.equal(upgraded.derivation, "corrected", "全升档那一档被改坏了");
});

test("升档与降档混在一起 ⇒ 仍然是「仍无法判断」，不许硬选一边（§14.2 末句）", () => {
  const mixed = decideRecheckVerdictDiffV2({
    originalVerdicts: [v("u1", "covered"), v("u2", "missing")],
    recheckedVerdicts: [v("u1", "missing"), v("u2", "covered")],
  });
  assert.equal(mixed.derivation, "undetermined",
    "一个升一个降时「之差」指向两个方向，强行选一边就是 §14.2 不许的事");
});

test("逐条 id 对不齐 ⇒ 仍是「仍无法判断」（连之差都算不出来）", () => {
  const mismatch = decideRecheckVerdictDiffV2({
    originalVerdicts: [v("u1", "covered"), v("u2", "covered")],
    recheckedVerdicts: [v("u1", "missing")],
  });
  assert.equal(mismatch.shapeMismatch, true);
  assert.equal(mismatch.derivation, "undetermined");
});

/**
 * ⚠️ 这一档在排期上**绝不能**走 `use_as_is`。
 *
 * `use_as_is` 的字面意思是「原判站得住，照用」。而 `over_broad` 恰恰是原判被复核
 * **否定**了——照用等于让一个已被推翻的「这是独立表现」去推进复习间隔，
 * 那是把系统自己的错误变成用户的进度。
 */
test("原判过宽不许 use_as_is：它必须扣住结论，且 reasonCode 与「判不出来」分开", () => {
  const overBroad = decideDisputedObservationV2({
    hasLiveDispute: true, recheckOutcome: "over_broad", correctionAlreadyApplied: false,
  });
  const undetermined = decideDisputedObservationV2({
    hasLiveDispute: true, recheckOutcome: "undetermined", correctionAlreadyApplied: false,
  });
  assert.notEqual(overBroad.action, "use_as_is",
    "原判过宽走了 use_as_is：已被复核否定的判定会推进复习间隔");
  assert.equal(overBroad.action, "withhold_conclusion", "原判过宽应当扣住这一次观察的结论");
  // 与 undetermined 都扣住，但屏上要说得出来是两件事
  assert.notEqual(overBroad.reasonCode, undetermined.reasonCode,
    "两档共用一个 reasonCode ⇒ 屏上把「原判过宽」显示成「还没想清楚」");
  assert.equal(undetermined.reasonCode, "recheck_undetermined");
  assert.ok(overBroad.reasonCode.includes("too_broad"), `reasonCode 要能读出「过宽」，实际是 ${overBroad.reasonCode}`);
});

test("原判过宽**不是** apply_correction_once：没有可升档的东西就没有可写的更正", () => {
  const out = decideDisputedObservationV2({
    hasLiveDispute: true, recheckOutcome: "over_broad", correctionAlreadyApplied: false,
  });
  assert.notEqual(out.action, "apply_correction_once",
    "更正那一档的含义是「把原判改成达成」；全降档没有可升档的东西，写不出那种更正");
});

test("第三档的处置没有被这一刀改坏（回归： upheld 仍 use_as_is、corrected 仍只应用一次）", () => {
  assert.equal(
    decideDisputedObservationV2({ hasLiveDispute: true, recheckOutcome: "upheld", correctionAlreadyApplied: false }).action,
    "use_as_is",
  );
  assert.equal(
    decideDisputedObservationV2({ hasLiveDispute: true, recheckOutcome: "corrected", correctionAlreadyApplied: false }).action,
    "apply_correction_once",
  );
  assert.equal(
    decideDisputedObservationV2({ hasLiveDispute: true, recheckOutcome: "corrected", correctionAlreadyApplied: true }).action,
    "withhold_conclusion",
    "更正只许应用一次：第二次进来必须是「已经应用过」，否则同一次更正会被消费两次",
  );
});

test("四档在公开合同上都要能被说出名字——缺一档就有一个状态无法表达", () => {
  const parsed = assessmentDisputeRecheckOutcomeV2Schema.options;
  assert.equal(parsed.length, 4, `公开合同只有 ${parsed.length} 档：${parsed.join(",")}`);
  for (const expected of ["upheld", "corrected", "over_broad", "undetermined"]) {
    assert.ok(parsed.includes(expected as never), `公开合同里没有 ${expected} 这一档`);
  }
});

test("模型自述与逐条之差对不上时，仍记「仍无法判断」——但**之差本身**说的那一档要保留在 derivation 里", () => {
  // 模型自述 upheld，逐条之差说 over_broad：落库那一档必须是 undetermined
  // （自述不是证据），而 derivation 要如实记成 over_broad，让理由能说清差在哪。
  const out = decideRecheckOutcomeV2({
    claimed: "upheld",
    originalVerdicts: [v("u1", "covered"), v("u2", "covered")],
    recheckedVerdicts: [v("u1", "covered"), v("u2", "missing")],
  });
  assert.equal(out.outcome, "undetermined", "照抄模型自述会造出假回执");
  assert.equal(out.derivation, "over_broad", "derivation 必须记逐条之差推出来的那一档");
  assert.equal(out.disagrees, true);
  assert.ok(out.disagreementNote.length > 0, "不一致时要交回一句能接在理由后面的说明");
  // 自述与之差一致时，落库那一档就是之差那一档
  const agree = decideRecheckOutcomeV2({
    claimed: "over_broad",
    originalVerdicts: [v("u1", "covered")],
    recheckedVerdicts: [v("u1", "missing")],
  });
  assert.equal(agree.outcome, "over_broad", "自述与逐条之差一致时，这一档要能直接落库");
  assert.equal(agree.disagrees, false);
});

/**
 * 变异自证：**把第四档从源码里删掉**，这几条必须红。
 *
 * 为什么是源码级：第四档最可能的死法不是"实现写错"，而是有一天有人做
 * "简化"——把 `over_broad` 那个分支删掉，让全降档落回 `undetermined`，
 * 顺便把枚举与 CHECK 也收窄。那一刀**编译得过、单测可能也过**（因为其它三档
 * 都还在），而症状是对用户说"系统还没想清楚"、实际系统已经想清楚了。
 * 行为判据在那种改法下依然自洽，只有**断言那一档还存在于源码里**才抓得住。
 */
test("变异自证：把第四档从源码删掉，这几处判据必须同时失效", () => {
  const source = readFileSync(new URL("./assessment-dispute-rules-v2.ts", import.meta.url), "utf8");

  // 正控制：三处都在
  assert.match(source, /derivation: "over_broad"/, "正控制失败：之差推导里没有第四档");
  assert.match(source, /recheckOutcome === "over_broad"/, "正控���失败：排期处置里没有第四档");
  assert.match(source, /"over_broad",\s*"undetermined"/, "正控制失败：公开合同的枚举里没有第四档");

  // 变异①：删掉之差推导里那一整个分支
  const droppedDerivation = source.replace(
    /\n  \/\/ 全是降档[\s\S]*?notCoveredUnitIds: notCovered \};(?=\n)/,
    "",
  );
  assert.notEqual(droppedDerivation, source, "变异①造不出差异 ⇒ 判据恒真（正则指错了地方）");
  assert.ok(!/derivation: "over_broad"/.test(droppedDerivation), "变异①没有真的删掉那个分支");

  // 变异②：让第四档走 use_as_is（把系统自己的错误变成用户的进度）
  const useAsIs = source.replace(
    /if \(input\.recheckOutcome === "over_broad"\) \{[\s\S]*?\n  \}/,
    'if (input.recheckOutcome === "over_broad") {\n    return { action: "use_as_is", suspendsArtifactReuse: true, reasonCode: "recheck_upheld" };\n  }',
  );
  assert.notEqual(useAsIs, source, "变异②造不出差异 ⇒ 判据恒真");
  assert.ok(!/recheck_original_too_broad/.test(useAsIs), "变异②没有真的把第四档改成 use_as_is");

  // 变异③：把公开合同收窄回三档
  const threeStates = source.replace(/"over_broad",\s*/g, "");
  assert.notEqual(threeStates, source, "变异③造不出差异 ⇒ 判据恒真");
  assert.equal(
    assessmentDisputeRecheckOutcomeV2Schema.options.length,
    4,
    "正控制：枚举当前应当是四档（变异③只改源码文本，不改已 import 的运行时对象，所以这里只确认正控制）",
  );
});
