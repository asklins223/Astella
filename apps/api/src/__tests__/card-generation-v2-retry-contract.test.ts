/**
 * 「run 级就地重试」的跨端契约（2026-09-18）。
 *
 * ## 为什么需要这条测试
 * 就地重试由两侧配合完成，两侧分属不同包、此前没有任何机制保证它们对齐：
 *
 * 1. **API 侧**（`retryGenerationRunV2`）在派发重排任务前，把 run 从
 *    `needs_attention` 推进到工作态（`checking`），让用户点完立刻看到"又动起来了"；
 * 2. **worker 侧**（简化链 `mode: "replan"` 那一档）在真正执行前要校验 run 状态是否合法。
 *
 * 两者一旦不对齐，任务会以**非重试错误**失败：用户眼里就是"点了重试，一秒后变成
 * 生成失败"。这个缺陷**只有真实消费任务时才会暴露**——本仓库的单测全部通过，
 * 第一次真跑（worker 真的取走任务）当场失败，错误是
 * `replan requires review_ready/needs_attention run (got checking)`。
 *
 * 因此这里用源码文本把这条耦合钉住（与 `card-generation-v2-prompt-version-sync`、
 * `card-generation-v2-routes-contract` 同一手法）：API 推进到的状态，必须是 worker
 * 重规划门闩接受的状态之一。改动任一侧而忘了另一侧 → 本测试失败。
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = join(__dirname, "../../../..");

const apiRetryServiceSource = readFileSync(
  join(WORKSPACE_ROOT, "apps/api/src/modules/card-generation-v2/generation-run-service.ts"),
  "utf8",
);
const workerHandlerSource = readFileSync(
  join(WORKSPACE_ROOT, "workers/ai-worker/src/handlers/card-generation-v2-handler.ts"),
  "utf8",
);
/** 39d W7-7 刀一之后，"重排"这一档的状态门闩住在简化链的处理函数里。 */
const v3HandlerSource = readFileSync(
  join(WORKSPACE_ROOT, "workers/ai-worker/src/card-generation-v3/handler.ts"),
  "utf8",
);

describe("card-generation run 级就地重试：API ↔ worker 状态门闩契约", () => {
  it("API 在派发重排前把 run 推进到的状态，worker 的重排门闩必须接受", () => {
    // API 侧：retryGenerationRunV2 里推进 run 状态的那次更新。
    const retryFnStart = apiRetryServiceSource.indexOf("export async function retryGenerationRunV2");
    assert.ok(retryFnStart >= 0, "retryGenerationRunV2 must exist in the run service");
    const retryFnBody = apiRetryServiceSource.slice(retryFnStart, retryFnStart + 6000);
    const advancedTo = /\.set\(\{\s*status:\s*"([a-z_]+)"/.exec(retryFnBody);
    assert.ok(advancedTo, "retryGenerationRunV2 must advance the run status before dispatching the replan job");
    const targetStatus = advancedTo[1];

    // worker 侧：重排那一档的状态门闩（读的是那一行 `new Set([...])`，不是注释）。
    const gateMatch = /const REPLAN_RUN_STATUSES = new Set\(\[([^\]]*)\]\)/.exec(v3HandlerSource);
    assert.ok(gateMatch, "简化链的处理函数必须声明重排那一档接受哪些 run 状态");
    const accepted = gateMatch[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    assert.ok(accepted.length > 0, "重排门闩读到的是空集 ⇒ 这一格恒不成立，判据空转");

    assert.ok(
      accepted.includes(targetStatus),
      `API 把 run 推进到 "${targetStatus}"，但 worker 的重排门闩只接受 [${accepted.join(", ")}]`
      + "——任务会以非重试错误失败，用户看到「点了重试却变成生成失败」",
    );
  });

  it("重试服务派发的是简化链的重排那一发（旧链与总控一起删除后，这里只有一个答案）", () => {
    // 认的是**代码形状**（那一发的 `jobType:` 字面量），不是"文件里没出现过那个词"：
    // 上一版的判据被一句过时的注释满足了，注释改之前它一直绿着，代码早就翻了链。
    // 刀一之前这一格读的是三元真分支；刀二删掉旧链之后没有第二档可读，判据随之收窄成
    // "这一发的 jobType 必须是简化链的整批那一发"，旧 jobType 若被写回来，
    // `card-generation-chain-entry-inventory` 那格台账会红。
    assert.match(
      apiRetryServiceSource,
      /jobType:\s*"card_generation_simplified_v1"/,
      "retryGenerationRunV2 必须派简化链的整批任务（带 `mode: \"replan\"`）",
    );
    assert.match(
      apiRetryServiceSource,
      /payload:\s*\{\s*runId,[^\n]*mode:\s*"replan"/,
      "重排那一发的来意要写在 payload 里，worker 才知道不是第一次生成",
    );
    assert.match(workerHandlerSource, /case "card_generation_simplified_v1"/,
      "worker 必须分发整批那一发的 jobType");
    assert.match(v3HandlerSource, /function jobModeV3/,
      "worker 侧必须真的读 payload 里的来意，否则 replan 与首次生成无从区分");
  });
});
