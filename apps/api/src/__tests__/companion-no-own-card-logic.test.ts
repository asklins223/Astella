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
