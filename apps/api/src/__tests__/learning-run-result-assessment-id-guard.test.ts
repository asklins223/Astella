/**
 * 结果载荷必须投影这一次判定的 id（39 §14.2、§16.11、§16.25；39d W5-5 界面那一半）。
 *
 * **为什么这是一个判据而不是顺手加的一列**：§14.2 的争议、更正、以及 §16.25 的
 * 补答，全都挂在**一次具体判定**上——没有那个 id，桌面端就**没有任何办法**把
 * "我不同意这次判定"接到这一次判定上。此前这一格整条链的服务端是齐的
 * （`run-dispute-routes.ts` 六条路由、`server.ts:380` 已注册），而**客户端对这套
 * 路由的调用数是 0**：结果页印着「也可以现在结束争议、把这一项暂不安排」，
 * 那句话向用户承诺了一个点不到的地方。
 *
 * 这一格补上投影之后，界面才有 id 可用；而它是最容易被静默摘掉的一列——
 * 摘掉之后**不会有任何一条测试会红**，症状是屏上那颗入口凭空消失，
 * 而症状看上去像"界面还没做"。
 *
 * 因此钉两条：
 *  1. 服务端**确实**把 `assessmentId` 选出来并放进结果投影（不是只在合同里加了一档）。
 *  2. 合同那一格是**可选**的，且注释说明了为什么——把它改成必填会让**所有历史结果**
 *     在解析时整片报错，而那些结果本身是好的。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  learningRunResultAssessmentV2Schema,
} from "@astella/shared/learning-run-v2-contracts";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SERVICE_FILE = join(REPO_ROOT, "apps/api/src/modules/learning-runs/run-service.ts");
const CONTRACTS_FILE = join(REPO_ROOT, "packages/shared/src/contracts/learning-run-v2-contracts.ts");

/** 剥掉注释：源码形状判据要判代码。 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const service = codeOnly(readFileSync(SERVICE_FILE, "utf8"));
const contracts = codeOnly(readFileSync(CONTRACTS_FILE, "utf8"));

/** `loadResultAssessmentV2` 那个函数体——摘掉它就说明 id 根本没被选出来。 */
function resultAssessmentLoader(): string {
  const at = service.indexOf("async function loadResultAssessmentV2(");
  assert.ok(at > 0, "run-service 里读不到 loadResultAssessmentV2（判据空转）");
  const next = service.indexOf("\n}\n", at);
  return service.slice(at, next === -1 ? service.length : next);
}

test("结果投影真的选出了 assessmentId 并交给合同解析（不只是合同里多了一档）", () => {
  const loader = resultAssessmentLoader();
  // 少了 select 里的 `id` 那一行，后面那句 `assessmentId: row.id` 就是
  // `row.<不存在的字段>` ⇒ 投影恒为 undefined ⇒ 屏上入口永远不出现，且不红。
  assert.match(
    loader,
    /select\(\{[\s\S]*?\bid:\s*learningAssessments\.id\b/,
    "loadResultAssessmentV2 的 select 里没有 assessmentId 那一列——结果载荷投影不出 id",
  );
  assert.match(
    loader,
    /learningRunResultAssessmentV2Schema\.safeParse\(\{[\s\S]*?assessmentId:\s*row\.id\b/,
    "safeParse 的入参里没有把 row.id 交给合同",
  );
});

test("合同那一格是可选的（老 run 的 result 里没有它，硬做成必填会整片解析失败）", () => {
  assert.match(
    contracts,
    /learningRunResultAssessmentV2Schema\s*=\s*z\.strictObject\(\{[\s\S]{0,400}?assessmentId:\s*z\.string\(\)\.uuid\(\)\.optional\(\)/,
    "assessmentId 那一档不见了，或者被改成了必填",
  );
  // 可选不是"可以不发"：给了就必须是合法 uuid，否则界面会拿着一个假 id 去提交申诉。
  const given = learningRunResultAssessmentV2Schema.safeParse({
    assessmentId: "00000000-0000-4000-8000-0000000000a1",
    source: "assessment_critic",
    status: "completed",
    trustClass: "mastery_eligible",
    rubricResults: [],
  });
  assert.equal(given.success, true, "给了合法 uuid 却解析不过");

  const bogus = learningRunResultAssessmentV2Schema.safeParse({
    assessmentId: "not-a-uuid",
    source: "assessment_critic",
    status: "completed",
    trustClass: "mastery_eligible",
    rubricResults: [],
  });
  assert.equal(bogus.success, false, "非法 uuid 被放行了——屏上会拿它去提交一份申诉");

  // 缺席（老 run）必须仍然解析得过：没有 id 就不给入口，而不是让整份结果读不出来。
  const absent = learningRunResultAssessmentV2Schema.safeParse({
    source: "assessment_critic",
    status: "completed",
    trustClass: "mastery_eligible",
    rubricResults: [],
  });
  assert.equal(absent.success, true, "没有 assessmentId 时整块解析失败——老结果会被判成坏合同");
});
