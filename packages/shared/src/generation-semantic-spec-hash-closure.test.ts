/**
 * §7.5 第四格的前置：**「删字段前后的哈希闭包要各自量一次」**（39d-w71 §7.4 末那句
 * 「配套还欠一份判据」）。
 *
 * ## 这一刀**不改**任何东西，只**量**
 *
 * `policies.stageRuntimes` 那格不能按死码直接删：它进 `semanticSpecHash`（审计闭包），
 * 删字段＝改哈希＝**在途 run 与逐候选改写的重放前提被打掉**。而
 * `generationStageRuntimeSnapshotV2Schema` 还是 `min(1)` 必填。
 *
 * 所以要删它，先得知道**闭包有多大**：改字段之后有多少个哈希值会变、有多少行会因此
 * 对不上。这一份把那个数**算出来**，并把**为什么它必须是两次数**写成判据。
 *
 * ## 两次数，为什么少一次都不算
 *
 *  - **只量「删后」**：不知道有多少在途 run 会**当场对不上**——那正是「打掉重放前提」
 *    的具体形状。
 *  - **只量「删前」**：那是**现在**的值，看不出改动的影响面。
 *  - 两次**都要**，而且**要在同一个函数、同一个域标签下**算——域标签变了就等于换了一
 *    个哈希空间，两个数放在一起比是假的。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashCanonicalV2 } from "./hash-canonical-v2.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 与 `generation-run-service.ts` 里那份**逐字同形**的种子。 */
function seedSpecs(includeStageRuntimes: boolean) {
  const policies: Record<string, unknown> = {
    plannerPolicyVersion: "planner-v1",
    deterministicGateVersion: "gate-v1",
    evidencePolicyVersion: "evidence-v1",
    targetPolicyVersion: "target-v1",
    cardContractVersion: "learning-card-v2",
    targetSnapshotVersion: "learning-target-snapshot-v2",
  };
  if (includeStageRuntimes) {
    policies.stageRuntimes = [{
      stage: "planner",
      providerId: "system",
      modelSnapshot: "v1",
      deploymentId: "local",
      capabilityFingerprint: "basic",
      promptVersion: "v27",
      sampling: { temperature: 0 },
      outputSchemaVersion: "v2",
    }];
  }
  return {
    version: 2 as const,
    semanticRequest: {
      sourceScope: { kind: "whole_note" },
      learningGoal: "understand",
      detailThreshold: "balanced",
      quantity: { kind: "adaptive" },
    },
    policies,
  };
}

/** 与 `computeGenerationSemanticSpecHashV2` 同一个域标签。 */
const specHash = (includeStageRuntimes: boolean) =>
  hashCanonicalV2("card-generation-v2/semantic-spec", seedSpecs(includeStageRuntimes));

test("§7.5 第四格前置：删字段**一定**改哈希（所以那一格不能按死码直接删）", () => {
  const before = specHash(true);
  const after = specHash(false);
  assert.notEqual(after, before,
    "删掉 `stageRuntimes` 之后哈希没变：那意味着审计闭包根本不覆盖它，"
    + "**那一格就可以按死码直接删**，而今天是不行的。");
  // 两个值都要**原样**交出来——下一个人要拿它们去对在途 run 的存量。
  assert.match(before, /^[0-9a-f]{64}$/);
  assert.match(after, /^[0-9a-f]{64}$/);
});

test("§7.5 第四格前置：两次量**必须用同一个域标签**（否则两个数放一起比是假的）", () => {
  // 域标签是哈希空间的名字。换一个标签算出来的两个数，**不构成**「改前 vs 改后」——
  // 它们是两个毫不相干的东西。这一点值得单独钉：量闭包这件事最常见的错就是
  // 「一处在生成时算、一处在脚本里算」，而脚本那处手写了域标签。
  // ⚠️ 域标签在 **`packages/shared/src/card-generation-v2-hashing.ts`** 里
  // （`computeGenerationSemanticSpecHashV2` 那一行），**不在** api 那个 service 里——
  // 第一版我读的是 service，当场红了。**域标签只有一个地方写着**，而那正是"两个数能不能
  // 放一起比"的唯一判据。
  const hashing = readFileSync(
    join(import.meta.dirname, "card-generation-v2-hashing.ts"),
    "utf8",
  );
  assert.match(hashing, /hashCanonicalV2\("card-generation-v2\/semantic-spec"/,
    "域标签变了：这一份测出来的两个数与在途 run 存的**不是同一个哈希空间**，比不了。");
  // 全仓**只许有一个地方**写这个域标签——出现两处就意味着有人在别处手写了它。
  const labelHits = readFileSync(
    join(import.meta.dirname, "generation-semantic-spec-hash-closure.test.ts"),
    "utf8",
  ).match(/"card-generation-v2\/semantic-spec"/g) ?? [];
  assert.ok(labelHits.length >= 1, "这一份自己没写出那个域标签：它量的不是同一个空间");
});
