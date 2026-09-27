/**
 * §16.37(a)「第一份已锁定回答不被正常事后揭示降级」的**现状守卫**（39d W5-1；PRD §14.1.1）。
 *
 * ## 这一条钉的是什么
 *
 * §16.37(a) 今天**恰好**成立，但成立的方式经不起追问：
 *
 *  - **规划期**那道闸（`target-snapshot-adapter.ts`）**读** `learning_exposures_v2`，
 *    按 `RECENT_REVEAL_WINDOW_MS = 24h` 把目标降成 `practice_only`；
 *  - **评估期**那道闸（`run-processing-tick.ts` 的 `hasHintExposure`）**只读**
 *    `learning_run_events` 里 `learning_task.hint_requested`，**完全不读 exposure 表**。
 *
 * 于是"答完 → 看卡背 → 评分稍后返回"这一串里，评估期那道闸看不到刚才那次揭示，
 * 这次已锁定的回答**没有被降级**——§16.37(a) 因此成立。
 *
 * **但它是两道闸串联出来的，不是哪一道闸自己保证的。** 谁给 `hasHintExposure` 加上
 * exposure 读侧（那看起来只是"补全一处漏读"），它就会在**答案锁定之后**看到那次揭示，
 * 把一份已经锁定的回答降级——§16.37(a) 当场反向，而**没有一条测试会红**。
 *
 * ## 为什么正确的修法不是"加读侧"
 *
 * §14.1.1 加粗那句是「**以回答锁定先后为界，而不是评分返回时间**」。要让
 * `hasHintExposure` 读 exposure，必须先能回答"这条 exposure 发生在答案锁定之前还是之后"，
 * 而今天**没有这个判据**：锁定的凭据只有 `runtime_epoch` 与 `revision`，两者都不是时间戳，
 * 拿来比"揭示发生得更早还是更晚"是编的。所以 W5-1 主体那一格在补上"锁定时刻"这一列
 * （数据面＋契约）之前**不能**动这一处——那不是补一处漏读，那是换一套证据条件算法。
 *
 * 这一份是**纯守卫**：不改任何运行行为，只把上面那串推理钉住，并在有人动它时给出
 * "要做什么才允许动"而不是一句"别动"。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const TICK_FILE = join(REPO_ROOT, "apps/api/src/modules/learning-runs/run-processing-tick.ts");
const ADAPTER_FILE = join(REPO_ROOT, "apps/api/src/modules/card-generation-v2/target-snapshot-adapter.ts");

/** 剥掉注释：源码形状判据要判代码，注释里的话是给人读的。 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const tick = codeOnly(readFileSync(TICK_FILE, "utf8"));
const adapter = codeOnly(readFileSync(ADAPTER_FILE, "utf8"));

/** `hasHintExposure` 那个函数的函数体（按 `async function` 到下一个顶层声明）。 */
function hasHintExposureBody(): string {
  const at = tick.indexOf("async function hasHintExposure(");
  assert.ok(at > 0, "run-processing-tick 里读不到 hasHintExposure ⇒ 这条判据空转（函数被改名或挪走了）");
  const next = tick.indexOf("\n}\n", at);
  return tick.slice(at, next === -1 ? tick.length : next + 2);
}

test("评估期那道闸今天**不**读 exposure 表——这是 §16.37(a) 成立的原因", () => {
  const body = hasHintExposureBody();
  assert.ok(body.includes("learningRunEvents"), "读不到 learningRunEvents 那个读点（判据可能指错了地方）");
  assert.ok(!/learningExposures|learning_exposures/.test(body),
    "hasHintExposure 现在读了 learning_exposures。**这一条不能顺手改**："
    + "§14.1.1 的判据是「以回答锁定先后为界，而不是评分返回时间」，而锁定时刻今天"
    + "没有数据面（只有 runtime_epoch 与 revision，都不是时间戳）。加上读侧会让一份"
    + "**已经锁定**的回答被事后那次揭示降级——§16.37(a) 当场反向。"
    + "要动这里，先补「锁定时刻」那一列与契约，再按锁定前后分档；见 39d W5-1。");
});

test("规划期那道闸读 exposure，且有一个有界窗口（它是今天的第一道保险）", () => {
  assert.ok(/learningExposures|learning_exposures/.test(adapter),
    "target-snapshot-adapter 里读不到 exposure 的读点（判据可能指错了地方）");
  // 「近期」必须**有界**：一个无界的窗口会把「一般教学经历」永久变成「不能独立提取」，
  // 而 §14.1.1 明确「已经学过概念、看过以前的讲解，不意味着今后永远不能独立提取」。
  assert.match(adapter, /RECENT_REVEAL_WINDOW_MS\s*=\s*\d/,
    "读不到那个有界窗口常量：没有界的话，一般教学经历会永久压住独立提取");
});

test("两道闸的串联：规划期降 ceiling ⇒ practice_only 不产生 canonical 事实", () => {
  // 第二道保险在提交侧：ceiling 被钳到 practice_only 的那一次评估不写 canonical 事件。
  // 这一条同时说明为什么"给 hasHintExposure 加读侧"今天未必立刻炸出用户可见故障——
  // 但它**会**让 §16.37(a) 的判据反向（上面那条已经钉了），所以仍然不许顺手加。
  assert.match(tick, /practice_only/,
    "tick 里读不到 practice_only 那一档（判据可能指错了地方）");
  assert.match(tick, /ceilingOrder/,
    "读不到 ceiling 钳制那张顺序表");
});

test("揭示路径与评估路径今天不相交（§16.37(a) 的第三道保险）", () => {
  // `reveal_not_available` 要求 run 已结算：答完之后再揭示走的是**另一条**路径，
  // 它不会再回到评估那一步。三道保险叠起来，所以今天看不出问题——也正因如此，
  // 拆掉任何一道都不会立刻有测试变红，这一份守卫才有必要。
  const runService = codeOnly(readFileSync(
    join(REPO_ROOT, "apps/api/src/modules/learning-runs/run-service.ts"), "utf8"));
  assert.ok(runService.includes("reveal_not_available"),
    "run-service 里读不到 reveal_not_available（判据可能指错了地方）");
});

test("判据对「加读侧」灵敏：给 hasHintExposure 塞一句 exposure 读，这一条必须红", () => {
  // 同一份源码上做内存变异，不改生产文件。恒真的守卫比没有守卫更坏。
  const mutated = hasHintExposureBody().replace(
    "const rows = await tx",
    "const _exposureRows = await tx.select({ id: learningExposuresV2.id }).from(learningExposuresV2);\n  const rows = await tx",
  );
  assert.ok(
    /learningExposures|learning_exposures/.test(mutated),
    "变异没落在正确位置：守卫读不到那一处",
  );
  assert.ok(
    !/learningExposures|learning_exposures/.test(hasHintExposureBody()),
    "变异后守卫仍判成立 ⇒ 这条判据恒真",
  );
});
