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
const ROUTES_FILE = join(REPO_ROOT, "apps/api/src/modules/learning-runs/run-routes.ts");
const SURFACE_FILE = join(REPO_ROOT, "apps/desktop-client/src/renderer/src/components/surfaces/learning-run-surface.tsx");

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

/**
 * 上面那条量的是 **TS union**，而 wire 上真正执法的是另外三处。三处都合法地「有这一档」
 * 或者「合法地少一档」时，TS 不会报错、判据也全绿，而命令**发不出去**。
 *
 * 真实事故就是这一形状：action union 有、`learning_assessments.status` 有、
 * `run-service.ts` 的 `case` 有、`allowedActions` 会宣告它——但
 *  ① `learningRunActionSchema`（**zod**，V2 请求的 `action` 字段用它）没有这一档，
 *    `run-routes.ts` 的 `parseBody(app, learningRunActionRequestV2Schema, …)` 在那一层
 *    就拒掉，`applyAction` 那个 case 永远进不去；
 *  ② `isV2ActionAllowed` 的 `switch` 少一个 case（不穷尽时 TS **不报错**，回调返回
 *    类型含 undefined），于是就算发得出去也 409；
 *  ③ 渲染层 `actionLinks` 是 `filter(…includes(kind))` 白名单式的一行，漏一档＝屏上
 *    根本没有那颗按钮，而 `actionRequestFor` 的 switch 同样不穷尽。
 *
 * 四处都"看起来有"或"看起来该有"，没有任何一条判据量到它们。**所以下面这几条量的是
 * 执法点本身，不是声明点。**
 */
test("执法点①：wire 的 zod 有这一档（TS union 有 ≠ 发得出去）", () => {
  const contracts = readFileSync(CONTRACTS_FILE, "utf8");
  // learningRunActionSchema 是 z.discriminatedUnion("kind", [...])，逐个 variant 量。
  const at = contracts.indexOf('export const learningRunActionSchema = z.discriminatedUnion("kind", [');
  assert.ok(at > 0, "读不到 learningRunActionSchema（判据可能指错了地方）");
  const body = contracts.slice(at, contracts.indexOf("\n]);", at));
  assert.match(body, /kind: z\.literal\("cancel_assessment"\)[\s\S]{0,120}assessmentId/,
    "learningRunActionSchema 里没有带 assessmentId 的 cancel_assessment："
    + "run-routes 的 parseBody 会在 zod 那一层拒掉整发命令，applyAction 那个 case 永远进不去");
  assert.match(body, /kind: z\.literal\("end"\)/,
    "end 那一档不见了：取消必须是**另一个**动作，不能顶掉它");
});

test("执法点②：isV2ActionAllowed 的 switch 有这一档（不穷尽的 switch 不报错）", () => {
  const routes = readFileSync(ROUTES_FILE, "utf8");
  const at = routes.indexOf("function isV2ActionAllowed(");
  assert.ok(at > 0, "读不到 isV2ActionAllowed（判据可能指错了地方）");
  const body = routes.slice(at, routes.indexOf("\n}\n", at));
  assert.match(body, /case "cancel_assessment":/,
    "isV2ActionAllowed 没有这一档：服务端会宣告一颗注定 409 的动作，"
    + "屏上按下去只得到「该 action 不在服务端签发的允许集合中」");
  // 指名要连 assessmentId 一起对，否则一次 run 的两次评估分不清收的是哪一次
  assert.match(body, /case "cancel_assessment":[\s\S]{0,200}allowed\.assessmentId/,
    "这一档没有把 assessmentId 一起比对");
});

test("执法点③④：屏上真的有这颗按钮（白名单 ＋ 请求映射 ＋ 出口那一排）", () => {
  const surface = readFileSync(SURFACE_FILE, "utf8");
  // ③ actionLinks 的白名单式 filter：漏一档＝整条链接被丢掉。
  // **判据必须钉那一行本身**，不能只量 `action.kind === "cancel_assessment"` 出现过——
  // `isExitAction` 里也有同一句，量宽了就会在白名单仍然缺着的时候给出假绿
  // （这正是本刀第一版的写法，变异③④当场戳穿）。
  assert.match(surface, /snapshot\.allowedActions\.filter\(\(action\) => action\.kind === "cancel_assessment"\)/,
    "actionLinks 那几行 filter 没有把 cancel_assessment 接进来：屏上根本没有那颗按钮");
  // actionRequestFor：不接就是发出去一个 undefined 的 action
  assert.match(surface, /case "cancel_assessment":[\s\S]{0,160}assessmentId/,
    "actionRequestFor 没有这一档：按下去发出去的 action 是 undefined");
  // §5.5「三个独立动作」：出口那一排要同时承载，不能是一颗
  assert.ok(!/const exitAction = actionLinks\.find\(/.test(surface),
    "出口仍然是 find(...) 单数：评估在途时 cancel_assessment 与 end 同时被宣告，只有一颗进得来，"
    + "另一颗连「更多选择」都进不去（moreActions 用 -quickActionKeys 过滤）");
  assert.match(surface, /isExitAction[\s\S]{0,200}"cancel_assessment"/,
    "cancel_assessment 没有被算成出口动作：它会被塞进「更多选择」，而 §5.5 要求它看得见");
  // 措辞：不能写成「取消评估」——那听起来像把作答也收走了
  assert.match(surface, /case "cancel_assessment": return "停止本次评估"/,
    "这颗按钮没有独立措辞（或措辞与 §5.5 的分工不符）：三个动作分量不同，字面不该长得像");
});

/**
 * 变异自证：把上面三条各自指着的执法点去掉，这三条必须**各自**红。
 * 一条判据如果三处都漏也能绿，那它量的就不是执法点。
 */
test("判据对「三处执法点各漏一处」灵敏", () => {
  const surface = readFileSync(SURFACE_FILE, "utf8");
  const contracts = readFileSync(CONTRACTS_FILE, "utf8");
  const routes = readFileSync(ROUTES_FILE, "utf8");

  // ① wire 缺这一档 ⇒ 执法点① 红
  const wireDropped = contracts.replace(
    /\s*z\.strictObject\(\{ kind: z\.literal\("cancel_assessment"\), assessmentId: z\.string\(\)\.uuid\(\) \}\),/,
    "",
  );
  assert.notEqual(wireDropped, contracts, "变异①造不出差异 ⇒ 判据恒真（正则是指错了地方）");
  assert.ok(!/kind: z\.literal\("cancel_assessment"\)/.test(
    wireDropped.slice(wireDropped.indexOf('learningRunActionSchema = z.discriminatedUnion'), wireDropped.indexOf("\n]);", wireDropped.indexOf('learningRunActionSchema = z.discriminatedUnion'))),
  ), "变异①没有真的删掉 wire 那一档");

  // ② switch 缺这一档 ⇒ 执法点② 红
  const switchDropped = routes.replace(/\s*case "cancel_assessment":\s*\n?\s*return action\.kind === "cancel_assessment"[^\n]*\n/, "\n");
  assert.notEqual(switchDropped, routes, "变异②造不出差异 ⇒ 判据恒真");
  const isV2Body = (text: string) => {
    const a = text.indexOf("function isV2ActionAllowed(");
    return text.slice(a, text.indexOf("\n}\n", a));
  };
  assert.ok(!/case "cancel_assessment":/.test(isV2Body(switchDropped)), "变异②没有真的删掉 switch 那一档");

  // ③④ 屏上缺这颗按钮 ⇒ 执法点③ 红
  const surfaceDropped = surface.replace(/\s*\.\.\.snapshot\.allowedActions\.filter\(\(action\) => action\.kind === "cancel_assessment"\),/, "");
  assert.notEqual(surfaceDropped, surface, "变异③④造不出差异 ⇒ 判据恒真");
  assert.ok(!/snapshot\.allowedActions\.filter\(\(action\) => action\.kind === "cancel_assessment"\)/.test(surfaceDropped),
    "变异③④没有真的删掉白名单那一行");
});

test("action union 带上 assessmentId：仅凭 runId 判不出「已完成的那一次」", () => {
  const contracts = readFileSync(CONTRACTS_FILE, "utf8");
  assert.match(contracts, /\| \{ kind: "cancel_assessment"; assessmentId: string \}/,
    "action union 里没有 cancel_assessment，或它没有带 assessmentId");
  assert.match(contracts, /\| \{ kind: "end"; abandonLockedEvidence: boolean \}/,
    "end 那一档不见了：取消必须是**另一个**动作，不能顶掉它");
});

/**
 * 三处 status 枚举**同宽**。
 *
 * 写下这三条是因为本刀第一版真的漏了一处：schema 的 `LearningAssessmentStatusValues` 加了
 * `cancelled`、公开合同 `AssessmentPublicV1.status` 没加，于是投影层那个 `as never` 的 cast
 * 失守，`tsc` 在**离那次改动很远的地方**报了一个语义不明的错（`run-service.ts:1184` 整个对象
 * 不匹配 `AssessmentRow`）。症状离病因很远，是这类不同步最费时间的地方——所以钉住。
 */
test("三处 status 枚举同宽：schema / 公开合同 / 数据库 CHECK", () => {
  const schema = readFileSync(SCHEMA_FILE, "utf8");
  const contracts = readFileSync(CONTRACTS_FILE, "utf8");
  const migration = readFileSync(MIGRATION_FILE, "utf8");

  const schemaSet = schema.match(/LearningAssessmentStatusValues = \[([^\]]*)\]/);
  assert.ok(schemaSet, "读不到 schema 的 status 枚举（判据可能指错了地方）");
  const contractSet = contracts.match(
    /export type AssessmentPublicV1 = \{[\s\S]{0,900}?status: ([^;]+);/,
  );
  assert.ok(contractSet, "读不到 AssessmentPublicV1.status（判据可能指错了地方）");

  // TS 那边写双引号、SQL CHECK 里写单引号，两种都要认——第一版只认双引号，
  // 于是 migrationSet 读出来是空数组，这条判据在真出事时会给出「两边都是空」的假绿。
  const pick = (text: string) => [...text.matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1]!);
  const fromSchema = pick(schemaSet[1]!).sort();
  const fromContract = pick(contractSet[1]!).sort();
  assert.deepEqual(fromContract, fromSchema,
    `公开合同的 status 与 schema 枚举不同宽：schema=${fromSchema.join(",")} 合同=${fromContract.join(",")}。`
    + "少写一档会让投影层在给那一行做 cast 时失守，而那处失守要到真的产生那一档才暴露。");

  const migrationSet = migration.match(
    /learning_assessments_status_check CHECK \(status IN \(([^)]*)\)\)/,
  );
  assert.ok(migrationSet, "读不到迁移 0301 的 status CHECK（判据可能指错了地方）");
  const fromMigration = pick(migrationSet[1]!).sort();
  assert.deepEqual(fromMigration, fromSchema,
    `迁移的 CHECK 与 schema 枚举不同宽：schema=${fromSchema.join(",")} 迁移=${fromMigration.join(",")}`);
});

test("判据对「漏一处」灵敏：从公开合同里删掉 cancelled，这一条必须红", () => {
  const schemaSet = readFileSync(SCHEMA_FILE, "utf8").match(
    /LearningAssessmentStatusValues = \[([^\]]*)\]/,
  )!;
  // TS 那边写双引号、SQL CHECK 里写单引号，两种都要认——第一版只认双引号，
  // 于是 migrationSet 读出来是空数组，这条判据在真出事时会给出「两边都是空」的假绿。
  const pick = (text: string) => [...text.matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1]!);
  const fromSchema = pick(schemaSet[1]!).sort();
  // 模拟「第一版真的漏了的那一处」：公开合同少一档。
  const drifted = fromSchema.filter((k) => k !== "cancelled");
  assert.notDeepEqual(drifted, fromSchema,
    "这条判据没造出差异 ⇒ 它恒真（数据库枚举里恰好有 cancelled，把它剔掉应当造出不同）");
});
