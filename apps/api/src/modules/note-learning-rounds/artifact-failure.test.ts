/**
 * 动态产物失败留痕的判据（39d W4-6 刀五·失败侧；§16.4「动态交付失败记录保留」）。
 *
 * 这一组钉的是**三条不变量**（见 `artifact-failure.ts` 文件头），外加两处"组合不许新增
 * 一档而不同步"的一致性：
 *
 *  1. **失败不许冒充成功，也不许冒充教学失败**（D4 §6.2）。写失败那一步之后，教学行仍要
 *     在库里、`artifact_id` 仍要留空——判据按源码形状钉：写失败**不包** SAVEPOINT，也不
 *     改教学行的任何一个字段。
 *  2. **失败不碰能力证据**。这个文件里不许出现任何 `learning_*` 表。
 *  3. **重试不抹掉历史**。没有唯一索引、只追加触发器在迁移里。
 *
 * 另外两条是"防止明天悄悄加一档"：判据里那份组合表、迁移的 CHECK、schema 的 CHECK、
 * 线上合同，四处必须同宽。少一处，新增的那一档就会静默落到某个默认类，而"这是哪一类
 * 失败"是这一整张表的全部意义。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ARTIFACT_FAILURE_COMBINATIONS_V1,
  isArtifactFailureReasonV1,
} from "./artifact-failure.ts";
import { roundArtifactFailureV1Schema } from "@ailearn/shared/note-learning-round-contracts";

// apps/api/src/modules/note-learning-rounds → 上溯五级到仓库根。
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");
const SERVICE_FILE = join(REPO_ROOT, "apps/api/src/modules/note-learning-rounds/artifact-failure.ts");
const ROUND_SERVICE = join(REPO_ROOT, "apps/api/src/modules/note-learning-rounds/round-service.ts");
const MIGRATION_FILE = join(REPO_ROOT, "apps/api/src/db/migrations/0298_note_learning_round_artifact_failures.sql");
/**
 * 0304 把那条 CHECK 拓宽了一档（`generate`）。"四处同宽"要读的是**当前生效**的那一条，
 * 所以判据读 0304；0298 仍然被读，为的是"原始两档没有被偷偷改过"。
 */
const MIGRATION_0304_FILE = join(REPO_ROOT, "apps/api/src/db/migrations/0304_note_round_dynamic_artifact_generation.sql");
const SCHEMA_FILE = join(REPO_ROOT, "packages/shared/src/db-schema/note-learning-rounds.ts");
const CONTRACTS_FILE = join(REPO_ROOT, "packages/shared/src/note-learning-round-contracts.ts");

/** 剥掉注释：源码形状判据要判的是代码，注释里的话是给人读的。 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("四处组合表同宽：判据 / 迁移 CHECK / schema CHECK / 线上合同", () => {
  // 判据这一份
  assert.deepEqual(ARTIFACT_FAILURE_COMBINATIONS_V1.build, ["empty", "over_quota"]);
  assert.deepEqual(ARTIFACT_FAILURE_COMBINATIONS_V1.generate, ["model_failed", "contract_rejected"]);
  assert.deepEqual(ARTIFACT_FAILURE_COMBINATIONS_V1.persist, ["persist_failed"]);

  // 迁移：那条 CHECK 必须逐档列出，而不是只 CHECK stage
  const migration = readFileSync(MIGRATION_0304_FILE, "utf8");
  assert.match(migration, /stage = 'build'\s+AND reason IN \('empty', 'over_quota'\)/,
    "迁移的 CHECK 里 build 档的两档没逐个列出来");
  assert.match(migration, /stage = 'generate'\s+AND reason IN \('model_failed', 'contract_rejected'\)/,
    "迁移的 CHECK 里 generate 档没逐个列出来（39d W4-1 尾加的那一档）");
  assert.match(migration, /stage = 'persist' AND reason = 'persist_failed'/,
    "迁移的 CHECK 里 persist 档那一条不见了");
  // 0298 的原始两档不许被 0304 顺手改过：那是存量行的判据。
  const original = readFileSync(MIGRATION_FILE, "utf8");
  assert.match(original, /stage = 'build'\s+AND reason IN \('empty', 'over_quota'\)/,
    "0298 的原始 CHECK 不见了 ⇒ 存量行当初是靠它挡住的，现在无从对照");
  assert.match(original, /stage = 'persist' AND reason = 'persist_failed'/);

  // schema：同名 CHECK 同一份规则
  const schema = readFileSync(SCHEMA_FILE, "utf8");
  assert.ok(schema.includes("nlraf_stage_reason_chk"),
    "schema 里那条 CHECK 不叫 nlraf_stage_reason_chk ⇒ 它与迁移脱钩了（守卫读不到）");
  assert.match(schema, /stageReasonCheck: check\("nlraf_stage_reason_chk"/,
    "schema 里的 CHECK 名与迁移不同名 ⇒ 迁移改的那条不是 drizzle 会生成的那条");
  assert.match(schema, /\$\{t\.stage\} = 'generate' AND \$\{t\.reason\} IN \('model_failed', 'contract_rejected'\)/,
    "schema 的 CHECK 里少了一档 generate ⇒ 新增那一档会静默落到某个默认类");

  // 线上合同：两档的 reason 枚举
  const contracts = readFileSync(CONTRACTS_FILE, "utf8");
  assert.match(contracts, /z\.literal\("build"\),\s*\n\s*reason: z\.enum\(\["empty", "over_quota"\]\)/,
    "线上合同的 build 档 reason 与判据不同宽");
  assert.match(contracts, /z\.literal\("generate"\),\s*\n\s*reason: z\.enum\(\["model_failed", "contract_rejected"\]\)/,
    "线上合同的 generate 档 reason 与判据不同宽");
  assert.match(contracts, /z\.literal\("persist"\),\s*\n\s*reason: z\.literal\("persist_failed"\)/,
    "线上合同的 persist 档 reason 与判据不同宽");
});

test("判据对「四处同宽」灵敏：迁移里改掉一档，判据必须跟着红", () => {
  const migration = readFileSync(MIGRATION_0304_FILE, "utf8");
  const mutated = migration.replace(
    /stage = 'build'\s+AND reason IN \('empty', 'over_quota'\)/,
    "stage = 'build' AND reason IN ('empty')",
  );
  assert.ok(
    !/stage = 'build'\s+AND reason IN \('empty', 'over_quota'\)/.test(mutated),
    "把迁移的 build 档改窄之后判据仍判一致 ⇒ 这条判据读不到那一档（恒真）",
  );
  // 同样对新增的那一档灵敏：把 generate 档从 CHECK 里拿掉，判据必须读不到。
  const withoutGenerate = migration.replace(
    /stage = 'generate'\s+AND reason IN \('model_failed', 'contract_rejected'\)/,
    "stage = 'generate' AND reason = 'model_failed'",
  );
  assert.ok(
    !/reason IN \('model_failed', 'contract_rejected'\)/.test(withoutGenerate),
    "把 generate 档改窄之后判据仍判一致 ⇒ 读不到 contract_rejected 那一档（恒真）",
  );
});

test("组合非法时抛，不静默丢（那正是「事后查不到成因」这个症状本身）", () => {
  // 这是纯函数那一半，判它"会拒绝"；写库那一半由上面两条 + 迁移的 CHECK 兜。
  assert.equal(isArtifactFailureReasonV1("build", "empty"), true);
  assert.equal(isArtifactFailureReasonV1("build", "over_quota"), true);
  assert.equal(isArtifactFailureReasonV1("generate", "model_failed"), true);
  assert.equal(isArtifactFailureReasonV1("generate", "contract_rejected"), true);
  assert.equal(isArtifactFailureReasonV1("persist", "persist_failed"), true);
  assert.equal(isArtifactFailureReasonV1("persist", "over_quota"), false,
    "persist 档接受了 over_quota ⇒ 两列各自合法而组合不存在的那条路开着");
  assert.equal(isArtifactFailureReasonV1("build", "persist_failed"), false);
  assert.equal(isArtifactFailureReasonV1("build", "随便一个字符串"), false);
  // 新增的 generate 档与旧两档的交叉组合一条也不许开
  assert.equal(isArtifactFailureReasonV1("generate", "empty"), false);
  assert.equal(isArtifactFailureReasonV1("generate", "over_quota"), false);
  assert.equal(isArtifactFailureReasonV1("generate", "persist_failed"), false);
  assert.equal(isArtifactFailureReasonV1("persist", "model_failed"), false);
  assert.equal(isArtifactFailureReasonV1("persist", "contract_rejected"), false);
});

test("不变量②：失败不碰能力证据（一个 learning_* 表都不许出现）", () => {
  const source = codeOnly(readFileSync(SERVICE_FILE, "utf8"));
  for (const table of [
    "learningAssessments", "learningArtifacts", "learningRunEvents",
    "learningRunActionLedger", "learningRuns", "learningTasks",
  ]) {
    assert.ok(!source.includes(table),
      `${table} 出现在了失败留痕这一侧：一次交付失败不是一次学习观察（§9.2），`
      + "算进去就会让「动态这一版没出来」影响这个目标的掌握结论");
  }
});

test("不变量③：只追加、且同一讲解可有多次失败（重试不抹掉历史）", () => {
  const migration = readFileSync(MIGRATION_FILE, "utf8");
  assert.match(migration, /BEFORE UPDATE OR DELETE[\s\S]*?guard_note_learning_round_artifact_failure/,
    "没有只追加触发器：重试成功会把上一次失败的原因改掉，而「曾经失败过」正是排查要的那一半");
  assert.ok(
    !/UNIQUE[\s\S]{0,120}teaching_id/.test(migration),
    "teaching_id 上有唯一索引 ⇒ 重试产生的多次失败被折叠成一行，次数被抹掉（§6.2 用户可重试）",
  );
  // GRANT 也要对：只追加的表不该给 UPDATE/DELETE
  assert.match(migration, /GRANT SELECT, INSERT ON public\.note_learning_round_artifact_failures TO ailearn_api/,
    "给了比 SELECT/INSERT 更多的权限：只追加这件事不能只靠触发器，权限层也要对");
  assert.ok(
    !/GRANT[^;]*note_learning_round_artifact_failures[^;]*TO ailearn_api[^;]*;[^;]*UPDATE/.test(migration),
    "GRANT 里出现了 UPDATE/DELETE",
  );
});

test("只追加触发器带 `app.allow_history_mutation` 绕行口子（0298 头注声明过、函数体漏写）", () => {
  // 0298 头注第 5 条：「只追加（触发器照 0283/0284/0285 的形状，带
  // `app.allow_history_mutation` 绕行口子）」。而 0298 的函数体里**没有**那个判断，于是
  // `teaching_id` 的 ON DELETE CASCADE 被无条件拒绝——只要某条教学行有过失败留痕，那一行
  // （以及它所属的轮次、笔记）就永远删不掉，而报错来自一条级联出来的 DELETE，隔了三层
  // 才看得到真正的原因。笔记删除是产品动作，所以这一条要钉住"绕行口子在"，而不只是
  // 钉住"触发器在"。
  const current = readFileSync(MIGRATION_0304_FILE, "utf8");
  assert.match(
    current,
    /CREATE OR REPLACE FUNCTION public\.guard_note_learning_round_artifact_failure\(\)[\s\S]*?current_setting\('app\.allow_history_mutation', true\) = 'on'[\s\S]*?COALESCE\(NEW, OLD\)/,
    "0304 没有把那个绕行口子补上：级联删除仍然会被无条件拒绝（笔记删不掉）",
  );
  // 放行时返回 COALESCE(NEW, OLD) 而不是 NULL：BEFORE DELETE 里 NEW 是 NULL，返回 NULL
  // 的语义是"跳过这一行"（0283 真踩过：删了 0 行却不报错——静默丢数据）。
  assert.ok(
    !/allow_history_mutation[\s\S]{0,200}?RETURN NULL;/.test(current),
    "绕行分支返回 NULL：BEFORE DELETE 里那是「跳过这一行」，于是删除静默不生效",
  );
  // 判据对「绕行口子被拿掉」灵敏：把它去掉，下面这条断言必须跟着红（自证）。
  const mutated = current.replace(
    /IF current_setting\('app\.allow_history_mutation', true\) = 'on' THEN/,
    "IF false THEN",
  );
  assert.ok(
    !/current_setting\('app\.allow_history_mutation', true\) = 'on'/.test(mutated),
    "去掉绕行判断之后判据仍判一致 ⇒ 这条判据读不到它（恒真）",
  );
});

test("不变量①：写失败那一步在教学行落库之后，且不改教学行的任何字段", () => {
  const source = codeOnly(readFileSync(ROUND_SERVICE, "utf8"));
  const teachingInsertAt = source.indexOf("tx.insert(noteLearningRoundTeachings)");
  const failureWriteAt = source.indexOf("recordArtifactFailureV1(");
  assert.ok(teachingInsertAt > 0 && failureWriteAt > 0, "两个锚点有一个读不到 ⇒ 这条判据空转");
  assert.ok(failureWriteAt > teachingInsertAt,
    "失败留痕写在教学行之前 ⇒ 那一刻还没有 teaching_id 可挂，那一条永远归不到具体讲解");
  // 写失败之后必须仍然 return 那一行教学产物（不因失败而改写它）
  const after = source.slice(failureWriteAt, failureWriteAt + 400);
  assert.match(after, /return toTeachingContract\(teachingRow\)/,
    "写失败之后没有照常交回教学行 ⇒ 失败开始影响教学那一半（D4 §6.2 明写它不该）");
});

test("不变量①的反面：写失败**不**包 SAVEPOINT（写不进去要整发失败，别悄悄丢原因）", () => {
  const source = codeOnly(readFileSync(ROUND_SERVICE, "utf8"));
  const at = source.indexOf("recordArtifactFailureV1(");
  const window = source.slice(Math.max(0, at - 400), at + 400);
  assert.ok(!/transaction\(|SAVEPOINT|savepoint/i.test(window),
    "写失败那一步被包进了子事务/SAVEPOINT：写不进去会被回滚掉，"
    + "于是「失败原因事后读不到」这个症状原封不动地回来了");
});

test("产物构建失败不因 reason 不认识而崩：判据与迁移的 build 档同宽", () => {
  const source = codeOnly(readFileSync(ROUND_SERVICE, "utf8"));
  // `buildDeterministicArtifactHtmlV1` 的 reason union 就是 `empty | over_quota`；
  // 落库前显式核一遍，而不是等 0298 的 CHECK 在半夜拒一次。
  assert.ok(source.includes('built.reason !== "empty" && built.reason !== "over_quota"'),
    "构建失败没有核 reason 是否在 0298 的 build 档里 ⇒ 新增一档时失败会变成一次 23514");
  assert.match(source, /stage: "build", reason: built\.reason/,
    "build 类的失败没有把 reason 原样传给留痕 ⇒ 落库的那一档与判据认出的对不上");
});

test("persist 类的失败带的是 persist_failed，而不是把异常消息当 reason", () => {
  const source = codeOnly(readFileSync(ROUND_SERVICE, "utf8"));
  assert.match(source, /stage: "persist", reason: "persist_failed"/,
    "persist 失败没有记成那一档 ⇒ 异常消息会被当成 reason 塞进一张有 CHECK 的表");
  assert.ok(source.includes("const message = err instanceof Error ? err.message : String(err);"),
    "异常消息没有被取成一句话：detail 那一列会写成 [object Object]");
});

test("线上合同：stage 判别而不是三个可空字段（§6.2 要对「没请求过」与「请求了但失败」说不同的话）", () => {
  const base = { stage: "build" as const, reason: "empty" as const, detail: "解释、例子与计划步骤都是空的",
    teachingId: null, snapshotHash: "726f6b03d3d48cc646abd3b370ce97e8",
    at: "2026-09-27T10:00:00+08:00" };
  assert.equal(roundArtifactFailureV1Schema.safeParse(base).success, true);
  // 两列各自合法而组合不存在 ⇒ 必须被拒
  assert.equal(roundArtifactFailureV1Schema.safeParse({ ...base, reason: "persist_failed" }).success, false,
    "build + persist_failed 被收下了：两列各自 IN 而组合不存在的那条路开着");
  assert.equal(roundArtifactFailureV1Schema.safeParse({ ...base, stage: "persist" }).success, false);
  // teachingId 可空是**设计**，不是漏填
  assert.equal(roundArtifactFailureV1Schema.safeParse({ ...base, teachingId: null }).success, true);
  assert.equal(roundArtifactFailureV1Schema.safeParse(base).success, true);
  // generate 档（39d W4-1 尾）：模型没成与"没达成完成判据"是两句不同的话，都收得下
  for (const reason of ["model_failed", "contract_rejected"] as const) {
    assert.equal(roundArtifactFailureV1Schema.safeParse({ ...base, stage: "generate", reason }).success, true,
      `generate + ${reason} 被拒了`);
  }
  // 但 generate 档不收旧两档：把「外部调用没成」记成「内容是空的」就是谎报
  assert.equal(roundArtifactFailureV1Schema.safeParse({ ...base, stage: "generate", reason: "empty" }).success, false);
  assert.equal(roundArtifactFailureV1Schema.safeParse({ ...base, stage: "generate", reason: "over_quota" }).success, false);
});
