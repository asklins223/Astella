/**
 * W7-9 判据一：**伴星入口不另写制卡提示/判分/调度逻辑**（39 §12.2.1、§15.6；判据 §16.27）。
 *
 * ## 这一格今天**结构上成立**，但**没有任何判据钉住**
 *
 * 实读结论（2026-09-27）：`components/companion/` 整个目录里**没有** `reviewSchedules`、
 * `ensurePendingReviewSchedule`、`semanticSpecHash`、`candidateRevisionHash`、
 * `calculateDiscreteV2Schedule` 的任何一处；`apps/api/src/modules/companion-conversation/`
 * 里**没有** `createGenerationRunV2` / `generation-run-service` 的引用。伴星要制卡，走的
 * 是**同一个审核台**（`open-card-generation` 那条房间路径），不是自己另开一条。
 *
 * 这正是 W7-8 刀四/刀五那一类：**机制在，但没有判据钉住**。而它一旦破，后果是
 * **屏上读不出来**的：伴星自己写一套制卡提示，于是"同一篇笔记"在两个入口产出两套卡，
 * 而两套都各有各的哈希与判分——审核台上看不出任何异常。
 *
 * ## 第二条：伴星**不因写权限自动开始学习**
 *
 * §12.2.1 那一族：伴星可以提议、可以写，但**提议 ≠ 开始**。这一条今天也成立（没有那一格
 * 触发点），同样钉住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// 本文件在 apps/api/src/__tests__ 下，到仓库根是**四**层（__tests__ → src → api → apps → 根）。
// ⚠️ 这是我**第三次**数错这一类路径（另两次：W7-4 刀六的接线守卫、W7-4 刀八的用例）。
// 症状是 ENOENT；而**只检查读到的内容**的判据在路径不存在时会一路绿到底——
// 所以这类判据必须**先确认目录读得到**再谈内容。
const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const COMPANION_UI = join(REPO, "apps/desktop-client/src/renderer/src/components/companion");
const COMPANION_API = join(REPO, "apps/api/src/modules/companion-conversation");

/** 目录里全部 .ts / .tsx 的源码（递归）。 */
function sourcesIn(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourcesIn(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push({ file: full, text: readFileSync(full, "utf8") });
    }
  }
  return out;
}

test("W7-9 前置：两个目录都读得到（数错层级的症状是 ENOENT，而内容判据会一路绿）", () => {
  for (const dir of [COMPANION_UI, COMPANION_API]) {
    assert.ok(existsSync(dir), `读不到 ${dir}：这一份判据在数错的路径上会**一路绿到底**`);
  }
  assert.ok(sourcesIn(COMPANION_UI).length > 0, "伴星 UI 目录读得到却没有源文件：判据会变成空转");
});

test("W7-9 判据一：伴星不自己写制卡提示/判分/调度逻辑", () => {
  // 这五样是"另写一套"的**最小可判读集**：命中任何一样，就说明伴星有了自己的那一套。
  const forbidden = [
    "semanticSpecHash",
    "candidateRevisionHash",
    "candidateEvidenceBindingPlanHash",
    "calculateDiscreteV2Schedule",
    "ensurePendingReviewSchedule",
  ];
  const offenders: string[] = [];
  for (const { file, text } of sourcesIn(COMPANION_UI)) {
    for (const needle of forbidden) {
      if (text.includes(needle)) offenders.push(`${file}: ${needle}`);
    }
  }
  assert.deepEqual(offenders, [],
    "伴星里出现了制卡/调度的那几样，**后果是屏上读不出来的**："
    + "同一篇笔记在两个入口会产出两套卡，而两套各有各的哈希与判分，审核台上看不出异常。");
});

test("W7-9 判据一 正对照：伴星**不自己发起制卡 run**（它走同一个审核台）", () => {
  const offenders: string[] = [];
  for (const { file, text } of sourcesIn(COMPANION_API)) {
    for (const needle of ["createGenerationRunV2", "generation-run-service"]) {
      if (text.includes(needle)) offenders.push(`${file}: ${needle}`);
    }
  }
  assert.deepEqual(offenders, [],
    "伴星自己建制卡 run 了：它走的不再是同一个审核台，于是「两处口径一致」这件事失效。");
});

test("W7-9 判据二：伴星**不因写权限自动开始学习**", () => {
  // 「可以写」与「可以开始学」是两件事。这一格判的是：伴星那几处**没有**把两者连起来。
  // 命中下面任何一个名字，就是有人写了"拿到写权限就顺手开始"那一格。
  const autoStartMarkers = [
    "autoStartLearning",
    "autoStartRun",
    "startLearningOnWrite",
    "beginRunOnWrite",
  ];
  const offenders: string[] = [];
  for (const dir of [COMPANION_UI, COMPANION_API]) {
    for (const { file, text } of sourcesIn(dir)) {
      for (const marker of autoStartMarkers) {
        if (text.includes(marker)) offenders.push(`${file}: ${marker}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    "出现了「拿到写权限就顺手开始学」那一格：§12.2.1「可以提议、可以写，但提议 ≠ 开始」。");
});

/**
 * W7-9 刀二：**「情境制卡携带同一材料版本与目标范围进同一审核」今天没有生产者。**
 *
 * ## 实读结论（2026-09-27）
 *
 * 伴星的提议体（`createCompanionMenuProposal` 的 `body`）只有：
 * `conversationId` / `clientMessageId` / `candidateId` / `expectedContextRevision` /
 * `expectedPayloadSha256` / `sourceSurface`，而 `candidateId` 只有
 * `"learning_run_resume" | "learning_run_start"` **两档**——**没有制卡那一档**。
 *
 * 加上刀一那条（伴星侧没有任何 `createGenerationRunV2` 引用），合起来是：
 * **伴星今天根本无法发起制卡**。所以「携带同一材料版本与目标范围进同一审核」这一条
 * **没有生产者**，它不是"版本带错了"，而是**根本没有那条路**。
 *
 * ## 为什么值得写成判据
 *
 * 因为这一格**读起来像已完成**：伴星能提议、能写、审核台确实只有一个。可是"进同一审核"
 * 那一半**没有生产者**时，它看上去就等于"伴星制卡会走同一审核"——而那句话今天**不成立**。
 * **一个空缺被一句读起来像已完成的话盖住，比空缺本身更坏。**
 *
 * ## 这一格**怎么才算做完**
 *
 * 要么（甲）给 `candidateId` 加一档 `"card_generation"`，并让它携带**笔记版本 id** ＋
 * **目标范围**（§4.2 那三档之一），由 `createGenerationRunV2` 封进 `semanticSpecHash`；
 * 要么（乙）**明确不做**，并把这一条从台账上划掉——两条都算完，**停在"没做"不算**。
 */
test("W7-9 刀二：伴星的提议体**没有制卡那一档**（所以「进同一审核」没有生产者）", () => {
  const bridge = readFileSync(
    join(REPO, "apps/api/src/modules/companion-conversation/learning-action-bridge.ts"),
    "utf8",
  );
  // ⚠️ 第一版这里用的是 `bridge.match(...)`——**只取第一处**。而 `candidateId` 在这一份
  // 里有**两处**声明（`menuProposalRequestHash` 的行内类型与 `createCompanionMenuProposal`
  // 的 body 类型），而我只改了后一处——于是**变异没红，我差点以为判据成立**。
  // 现在匹配**全部**并逐处断言。教训同上一条：**判据要盯住"每一处"，不是"某一处"**。
  const declarations = [...bridge.matchAll(/candidateId:\s*([^\n;]+);/g)].map((m) => m[1]!);
  assert.ok(declarations.length >= 2,
    `只找到 ${declarations.length} 处 candidateId 声明（第一版只取第一处就绿了）：`
    + "这一格要按新形状重写");
  assert.ok(declarations.every((d) => d.includes("learning_run_start")),
    "candidateId 的形状变了：这一格要按新形状重写");
  const withCard = declarations.filter((d) => d.includes("card_generation"));
  assert.deepEqual(withCard, [],
    "伴星多了一档制卡提议——那**很好**，但它必须携带**笔记版本 id ＋ 目标范围**，"
    + "并由 createGenerationRunV2 封进 semanticSpecHash；否则「携带同一材料版本与目标范围」"
    + "这一条只是多了一个入口，而那一半仍然落空。");
});

test("W7-9 刀二 正对照：伴星**能**提议的仍然只有学习轮次那一族", () => {
  const bridge = readFileSync(
    join(REPO, "apps/api/src/modules/companion-conversation/learning-action-bridge.ts"),
    "utf8",
  );
  // 这一条是**反向**的：确保刀二那条不是因为"整段被删了"而绿。
  // ⚠️ 第一版用 `includes("createCompanionMenuProposal")`——**改名成
  // `createCompanionMenuProposalRenamed` 时它照样包含那个子串**，所以那条反向判据在
  // "整段被改名"面前不响。改成**词边界**。
  assert.match(bridge, /export async function createCompanionMenuProposal\s*[(<]/,
    "伴星的提议那一发不见了（或被改名了）：刀二那条会对着一个空缺绿，而那正是它要防的。");
  assert.ok(bridge.includes("expectedContextRevision"),
    "提议体里那个乐观令牌不见了：并发时伴星会拿一份过期的上下文去做决定。");
});
