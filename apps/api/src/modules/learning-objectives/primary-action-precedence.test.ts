/**
 * §3.2 那条优先规则的常驻判据（39d W4-2 验收原话：「各入口使用同一优先规则」）。
 *
 * 这一枚守卫存在的原因不是"想加测试"，是量到三份手抄的表互相矛盾：首页把 §3.2 的
 * 第一档（需要处理的内容／权限变化）压在「开始学习」之后，伴星把「开始学习」压在
 * 「到期复习」之前，两份都漏了 `wait_for_initial_validation`。表抄第二遍的那一刻起，
 * 它就只会慢慢漂，没有任何东西会喊。
 *
 * 四条判据各自拦一种失效：
 *  ① 全覆盖（**两个方向**）：合同 union 里的 kind 与顺位表里的必须一一对应；
 *  ② 顺序符合 §3.2 点名的那几档；
 *  ③ 没登记的 kind 沉底，不插队（`indexOf` 的 -1 会被当成最高优先——那是把"忘了登记"
 *     奖励成"永远优先"）；
 *  ④ 两个消费点不再各自抄表（静态：那一格里不许再出现按 kind 分支的 switch）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { learningObjectivePrimaryActionV3Schema } from "@ailearn/shared/learning-objective-surface-contracts";
import { PRIMARY_ACTION_PRECEDENCE_V3, primaryActionPrecedenceV3 } from "./action-resolver.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..", "..");

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 取一处消费点的代码区间（函数体或那条语句）——判"这一格里有没有再抄一张表"。 */
function regionFrom(relPath: string, anchor: string): string {
  const text = stripComments(readFileSync(join(REPO_ROOT, relPath), "utf8"));
  const start = text.indexOf(anchor);
  assert.ok(start >= 0, `${relPath} 里找不到「${anchor}」——消费点被改名或整段删了，这条判据就成了瞎的`);
  const candidates = [text.indexOf("\n}", start), text.indexOf("\n  );", start), start + 800]
    .filter((value) => value > start);
  return text.slice(start, Math.min(...candidates));
}

test("① 顺位表与合同 union 一一对应（新增 kind 不登记就红，删掉一档留在表里也红）", () => {
  const unionKinds = new Set<string>(
    learningObjectivePrimaryActionV3Schema.options.map((option) => option.shape.kind.value),
  );
  const tableKinds = new Set<string>(PRIMARY_ACTION_PRECEDENCE_V3);
  assert.deepEqual(
    [...unionKinds].filter((kind) => !tableKinds.has(kind)).sort(), [],
    "合同里有这一档，顺位表没登记 ⇒ 它会被排到最后（§3.2 的顺位不再成立）",
  );
  assert.deepEqual(
    [...tableKinds].filter((kind) => !unionKinds.has(kind)).sort(), [],
    "顺位表里还留着一档合同已经没有了 ⇒ 把它删掉",
  );
  assert.equal(new Set(PRIMARY_ACTION_PRECEDENCE_V3).size, PRIMARY_ACTION_PRECEDENCE_V3.length,
    "顺位表里有重复的 kind");
});

test("② 顺序符合 §3.2：需要处理的内容／权限变化 → 未完轮次 → 到期回访 → 开始或继续探索，none 垫底", () => {
  const rankOf = primaryActionPrecedenceV3;
  assert.ok(rankOf("view_successor") < rankOf("resume_run"), "被取代的内容该排在未完轮次之前");
  assert.ok(rankOf("refresh") < rankOf("resume_run"), "权限／内容变化该排在未完轮次之前");
  assert.ok(rankOf("resume_run") < rankOf("create_review_run"), "§3.2：未完轮次在到期回访之前");
  assert.ok(rankOf("create_review_run") < rankOf("create_run"),
    "§3.2：已授权的到期回访在开始／继续探索之前（伴星那份表正是把这俩写反了）");
  assert.equal(rankOf("none"), PRIMARY_ACTION_PRECEDENCE_V3.length - 1, "「暂无可做的」必须垫底");
  // 实话：缺口与探索今天共用 `create_run`（解析器明写"刻意不新增 kind"），所以这两档
  // 在顺位表里就是同一带。这一条把"为什么只有四档可比"钉在测试里，而不是留在注释里漂着。
  assert.ok(rankOf("practice_only") < rankOf("create_run"), "reveal 之后的练习入口排在开始新学之前");
  assert.ok(rankOf("wait_for_initial_validation") < rankOf("create_run"),
    "等正式验证那一档过去掉在两张抄表之外（今天谁都没列它）");
});

test("③ 没登记的 kind 排到最后，不插队", () => {
  const unknown = "brand_new_kind_not_in_the_union" as never;
  assert.equal(primaryActionPrecedenceV3(unknown), PRIMARY_ACTION_PRECEDENCE_V3.length);
  assert.ok(primaryActionPrecedenceV3(unknown) > primaryActionPrecedenceV3("none"));
});

test("④ 两个消费点不再各自抄表：那一格里不许再出现按 kind 分支的 switch", () => {
  const consumers = [
    { rel: "apps/api/src/modules/learning-dashboard/service.ts", anchor: "function priorityScore(" },
    { rel: "apps/api/src/modules/companion-conversation/learning-action-bridge.ts", anchor: "const sorted = [" },
  ] as const;
  for (const { rel, anchor } of consumers) {
    const whole = stripComments(readFileSync(join(REPO_ROOT, rel), "utf8"));
    // 消费点必须真的在调用那一份表（不然"没有 switch"只是因为整段被删了）。
    assert.ok(whole.includes("primaryActionPrecedenceV3("), `${rel} 没再调用唯一那份顺位表`);
    const body = regionFrom(rel, anchor);
    assert.ok(!/case\s+["'](resume_run|create_review_run|create_run|refresh|view_successor)["']/.test(body),
      `${rel} 的顺位那一格里又出现按 kind 分支的表：§3.2 的顺位只能有一份住处（action-resolver.ts）`);
  }
});

test("判据自己的灵敏度：合成文本喂进去，各判各的", () => {
  // ④ 的那条谓词必须真的抓得住"又抄了一份表"。
  const reForked = 'const rank = (kind) => { switch (kind) { case "resume_run": return 0; } };';
  assert.ok(/case\s+["'](resume_run|create_review_run)["']/.test(reForked));
  const clean = "const sorted = [...objectives].sort((a, b) => primaryActionPrecedenceV3(a.kind) - 0);";
  assert.equal(/case\s+["'](resume_run|create_review_run)["']/.test(clean), false);
  // 区间取不到时必须当场红，而不是安静返回空串（那会让 ④ 永远"过"）。
  assert.throws(
    () => regionFrom("apps/api/src/modules/learning-dashboard/service.ts", "function notAFunctionAtAll("),
    /找不到/,
  );
  // 真实消费点的区间非空，且确实包含那一次调用（证明 ④ 读到位了，不是靠 substring 走运）。
  const dashBody = regionFrom("apps/api/src/modules/learning-dashboard/service.ts", "function priorityScore(");
  assert.ok(dashBody.length > 20 && dashBody.includes("primaryActionPrecedenceV3"), dashBody.slice(0, 80));
  const bridgeBody = regionFrom("apps/api/src/modules/companion-conversation/learning-action-bridge.ts", "const sorted = [");
  assert.ok(bridgeBody.includes("primaryActionPrecedenceV3"), bridgeBody.slice(0, 80));
});
