/**
 * 「停止本次评估」这条独立命令的判据（39d W5-1；39 §5.5、§16.36、§14.1.1）。
 *
 * §5.5 把三件事写成**三个独立动作**：「结束活动、取消 AI 任务和撤销未来复习授权」。
 * 今天第二格**无处落脚**：action union 里没有它、`learning_assessments.status` 里没有
 * `cancelled`，于是用户只剩两条路——「先到这里」（那要 `abandonLockedEvidence`，把已经
 * 锁定提交的作答丢掉），或者什么都不做（迟到的评分照常被采纳）。
 *
 * 这一组钉的是四条：
 *  1. **原回答保留**。取消只改 assessment 那一行，artifact 与 run 一律不动。
 *  2. **迟到报告不采纳**——由**数据库**触发器执法（迁移 0301），不靠每一处 UPDATE 自己
 *     记得带 `status='running'`。漏一处的症状是"用户明确取消了，系统照常改了他的学习事实"，
 *     而那种漏在正常链路上完全看不出来。
 *  3. **已完成的判定不因取消而消失**。那一发是幂等交回实际回执，不是 409。
 *  4. **可取消集合与可重试集合不是同一个**：合并会让「重试」与「取消」两个独立动作耦在
 *     一起——而 §5.5 要求它们是三个独立动作里的两个。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SERVICE_FILE = join(REPO_ROOT, "apps/api/src/modules/learning-runs/run-service.ts");
const AVAIL_FILE = join(REPO_ROOT, "apps/api/src/modules/learning-runs/run-action-availability.ts");
const SCHEMA_FILE = join(REPO_ROOT, "packages/shared/src/db-schema/learning-runs.ts");
const MIGRATION_FILE = join(REPO_ROOT, "apps/api/src/db/migrations/0301_learning_assessment_cancelled.sql");
const CONTRACTS_FILE = join(REPO_ROOT, "packages/shared/src/learning-run-contracts.ts");

/** 剥掉注释：源码形状判据要判代码。 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const service = codeOnly(readFileSync(SERVICE_FILE, "utf8"));

/** `cancel_assessment` 那个 case 的函数体。 */
function cancelCase(): string {
  const at = service.indexOf('case "cancel_assessment":');
  assert.ok(at > 0, "run-service 里读不到 cancel_assessment 那一档（判据空转）");
  const next = service.indexOf('\n    case "', at + 1);
  return service.slice(at, next === -1 ? service.length : next);
}

test("不变量②：「迟到报告不采纳」由数据库执法，不靠每处 UPDATE 记得带条件", () => {
  const migration = readFileSync(MIGRATION_FILE, "utf8");
  assert.match(migration, /CREATE TRIGGER learning_assessments_cancelled_terminal[\s\S]*?BEFORE UPDATE OF status/,
    "没有那条触发器：只把新值加进 CHECK 而靠服务层记得加条件，漏一处就等于取消失效");
  assert.match(migration, /OLD\.status = 'cancelled' AND NEW\.status IS DISTINCT FROM 'cancelled'/,
    "触发器没有禁止 cancelled 走回别的状态");
  // 明确排除 failed：把"用户主动取消"改写成"系统没判出来"是两句完全不同的话。
  assert.ok(!/NEW\.status = 'failed'[\s\S]{0,80}ALLOW/.test(migration),
    "触发器放行了 cancelled → failed（那会把用户的主动取消说成系统失败）");
  // 枚举里真的有它
  const schema = readFileSync(SCHEMA_FILE, "utf8");
  assert.match(schema, /LearningAssessmentStatusValues = \[[^\]]*"cancelled"/,
    "schema 的 status 枚举里没有 cancelled ⇒ 写不进去");
  assert.match(migration, /'queued', 'running', 'completed', 'not_assessable', 'failed', 'cancelled'/,
    "迁移的 CHECK 列表与 schema 枚举不同宽");
});

test("不变量①：取消只改 assessment 那一行，原回答保留", () => {
  const body = cancelCase();
  // 收尾那一发只 set assessment 的列：rubricResults/trustClass/reportHash 清空是**那一行**的
  // 字段，不是作答。判"有没有碰 artifact / learningRuns 的作答字段"更直接。
  assert.ok(/update\(learningAssessments\)/.test(body), "没有写 learningAssessments");
  assert.ok(!/update\(learningArtifacts\)|update\(learningTaskVariants\)/.test(body),
    "取消这一档碰了作答那一侧的表：§16.36「后者原回答保留」");
  assert.ok(body.includes("answerPreserved: true"),
    "事件里没有记「原回答保留」这一句：审计读不回 §16.36 的那一半");
  // 「不改 run 的 phase」——结束活动是另一个独立动作。
  assert.ok(!/set\(\{[^}]*phase:/.test(body),
    "这一档改了 run 的 phase：那把「结束活动」与「取消评估」合成一个动作了（§5.5 要求独立）");
});

test("不变量③：已完成的判定不因取消而消失（幂等交回，不是 409）", () => {
  const body = cancelCase();
  assert.match(body, /run\.phase === "completed"[\s\S]{0,400}assessment_already_final/,
    "completed 的那一发不是幂等交回：报冲突会让用户以为那个结果丢了（§5.5）");
  // 已终态的那一条不接受取消
  assert.match(body, /inArray\(learningAssessments\.status, \["queued", "running"\]\)/,
    "收尾条件没有限定在未终态：completed / not_assessable 会被抹成 cancelled");
  // 两种失败要分开说
  assert.match(body, /assessment_already_final/);
  assert.match(body, /assessment_not_found/,
    "「它已经判完了」与「压根不认得这一条」没有分开：前者 409、后者 404");
});

test("不变量④：可取消集合 ≠ 可重试集合（两个独立动作不许耦在一起）", () => {
  const avail = readFileSync(AVAIL_FILE, "utf8");
  const retryable = avail.match(/RETRYABLE_ASSESSMENT_STATUSES[^=]*=\s*\[([^\]]*)\]/);
  const cancellable = avail.match(/CANCELLABLE_ASSESSMENT_STATUSES[^=]*=\s*\[([^\]]*)\]/);
  assert.ok(retryable && cancellable, "两个集合有读不到（判据可能指错了地方）");
  assert.ok(/"failed"/.test(retryable[1]!), "可重试集合里没有 failed（判据可能指错了地方）");
  assert.ok(!/"failed"/.test(cancellable[1]!),
    "把 failed 放进可取消集合：那一档既可重试又可取消，两个独立动作就耦在一起了（§5.5）");
  assert.ok(/"queued"/.test(cancellable[1]!) && /"running"/.test(cancellable[1]!),
    "可取消集合缺 queued/running 之一");
});

test("投影与状态机一致：只在未终态时宣告那颗按钮（宣告一个注定 409 的动作 = 按不动的按钮）", () => {
  const avail = readFileSync(AVAIL_FILE, "utf8");
  assert.match(avail, /CANCELLABLE_ASSESSMENT_STATUSES\.includes\(view\.activeAssessment\.status\)/,
    "投影没有按可取消集合过滤");
  assert.match(avail, /kind: "cancel_assessment",[\s\S]{0,120}assessmentId: view\.activeAssessment\.assessmentId/,
    "投影没有把 assessmentId 带出来：状态机要靠它定位收哪一条");
  assert.match(avail, /confirmationRequired: true/,
    "这一档没有要确认：它收掉的是一次真实评估，不该一点就掉");
  // H1 那一格（retry_assessment）不能被这次改动带坏
  assert.match(avail, /RETRYABLE_ASSESSMENT_STATUSES\.includes\(view\.activeAssessment\.status\)/,
    "可重试那一档的判据被动到了");
});

test("action union 带上 assessmentId：仅凭 runId 判不出「已完成的那一次」", () => {
  const contracts = readFileSync(CONTRACTS_FILE, "utf8");
  assert.match(contracts, /\| \{ kind: "cancel_assessment"; assessmentId: string \}/,
    "action union 里没有 cancel_assessment，或它没有带 assessmentId");
  assert.match(contracts, /\| \{ kind: "end"; abandonLockedEvidence: boolean \}/,
    "end 那一档不见了：取消必须是**另一个**动作，不能顶掉它");
});
