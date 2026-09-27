/**
 * W7-2 剩一件 · §16.35：「**通知未送达不改变保存/授权成功的事实**」。
 *
 * ## 实读结论：这一格今天**没有落点**（真·空缺，不是缺陷）
 *
 * 激活那一发（`activateCardCandidatesV2` 及其内部）**只写库内效果**：事件行、目标、卡、
 * 排期（`ensurePendingReviewScheduleV2`）。**没有一处对外投递**——没有通知、没有推送、
 * 没有任何跨进程副作用。所以「通知未送达」这件事今天**无法发生**，于是这句话
 * **空真**。
 *
 * 台账 W7-2 那一格早就写着「今天没有可断路的落点」，这一份把那句话说**变成可执行的**：
 * 钉住「激活路径里没有对外投递」这个**前提**。因为**前提一旦被改掉，这一条就不再是
 * 自动成立的**——而改掉它的改动看起来完全无害（"保存完顺便提醒她一声"）。
 *
 * ## 那一天要做的事（写在这里，是为了让下一个人不必重新推一遍）
 *
 * 加上投递之后，三件事**必须同时**成立，否则 §16.35 就破了：
 *  1. 投递**在事务之外**（在 `commit` 之后），而**不是**在 `ensurePendingReviewScheduleV2`
 *     那个事务里——放进去就变成"投递失败 ⇒ 回滚保存"，与 §16.35 正面相反。
 *  2. 投递失败**只记**（事件/日志），**不**改回执上的成功事实。
 *  3. 重试那一发（同一把幂等键）**不会**因为上次投递失败而变成"未保存"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const ACTIVATION = readFileSync(
  join(REPO, "apps/api/src/modules/card-generation-v2/activation-service.ts"),
  "utf8",
);

test("W7-2 §16.35 前提：激活路径**没有对外投递**（所以这一格今天空真）", () => {
  // 三样「对外投递」的样子。命中任何一样，§16.35 就**立刻从空真变成有约束**，
  // 而那时候上面那三条必须**同时**成立。
  const outward = [
    // fetch/axios/gRPC 那一族
    /\bfetch\s*\(/,
    /\baxios\b/,
    // 推送/通知服务
    /\bpush(Notification|Message)\b/,
    /\bsendNotification\b/,
    /\bnotifyUser\b/,
    // 事件总线出进程
    /\bbus\.(emit|publish)\(/,
  ];
  const offenders = outward.filter((re) => re.test(ACTIVATION)).map((re) => String(re));
  assert.deepEqual(offenders, [],
    `激活路径里出现了对外投递（${offenders.join(", ")}）：`
    + "「通知未送达不改变保存/授权成功」这一条**从今天起不再是自动成立的**，"
    + "而要它成立必须**同时**满足三条：① 投递在**事务之外**、"
    + "② 失败**只记不改回执**、③ 重试那一发**不会**变成「未保存」。");
});

test("W7-2 §16.35 正对照：保存与授权的事实**只由库内写入决定**", () => {
  // 回执上的那几格（`mappings` / `scheduling`）全部来自**同一事务内**的写，
  // 所以它们不可能被一个外部副作用改掉——这是 §16.35 成立的结构理由。
  assert.match(ACTIVATION, /withWorkspaceTransaction|withApiTransaction/,
    "激活那一发的事务入口不见了：这一格要按新形状重写（回执由谁决定这件事变了）。");
  assert.match(ACTIVATION, /ensurePendingReviewScheduleV2\(/,
    "授权那一步不见了：§16.35 的「授权成功」已经没有生产者。");
});
