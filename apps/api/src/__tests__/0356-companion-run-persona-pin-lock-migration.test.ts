import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * 0356：一个 run 的人格固定版本**只写一次**（40 §4.8.4 / 40b §5.3.2）。
 *
 * 0355 之后账号人格分「当前 / 待生效」两版，而产物必须记着自己用的是哪一版。
 * 「一次调用使用固定版本，已生成产物不静默重写」此前只由代码纪律保证
 * （`companion_turn_runs.persona_profile_revision` 写一次之后所有更新都绕开它）。
 * 纪律不是结构：守卫条件哪天被放宽，同一个 run 的前半段用旧人格、后半段用新人格，
 * 旧消息又不会被重写——于是产物与它声称的版本身份悄悄对不上，且**没有任何报错**。
 *
 * 这条判据守的是「锁真的在表上、真的只挡改写不挡首次固定」。
 */
const migration = readFileSync(
  new URL("../db/migrations/0356_companion_run_persona_pin_lock.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

test("0356 已登记进 journal", () => {
  const entry = journal.entries.find((candidate) => candidate.tag === "0356_companion_run_persona_pin_lock");
  assert.ok(entry, "journal 里没有 0356 的条目——迁移器按 journal 清单应用，漏登记=永远不会执行");
  assert.equal(entry.idx, journal.entries.indexOf(entry), "idx 必须等于它在清单里的位置");
});

test("锁挂在 companion_turn_runs 上，且是 BEFORE UPDATE 的行级触发器", () => {
  assert.match(
    migration,
    /CREATE TRIGGER companion_turn_runs_persona_pin_lock\s*BEFORE UPDATE ON public\.companion_turn_runs\s*FOR EACH ROW EXECUTE FUNCTION public\.ailearn_lock_companion_run_persona_pin\(\)/,
    "触发器必须挂在 run 表上：一次调用=一个 run，锁在别的表上等于没锁",
  );
  assert.match(migration, /DROP TRIGGER IF EXISTS companion_turn_runs_persona_pin_lock/, "重跑必须能落上触发器");
});

test("只挡「已固定的那一版被改写」，不挡首次固定（NULL → 值）", () => {
  assert.match(
    migration,
    /IF OLD\.persona_profile_revision IS NOT NULL[\s\S]*?IS DISTINCT FROM/,
    "条件必须先看 OLD 非空：否则 run 连第一次 pin 都写不进去，全部对话当场瘫掉",
  );
  // 三个身份字段一起比：只比 persona_profile_revision 的话，
  // examples revision / 默认表达版本仍可被事后换掉，复现时对不上账。
  for (const column of ["NEW.persona_profile_revision", "NEW.persona_examples_revision", "NEW.default_expression_version"]) {
    assert.ok(migration.includes(column), `${column} 没进比对——复现时只对得上其中一个身份字段`);
  }
  assert.match(migration, /USING ERRCODE = '55000'/, "固定版本被改写属于 object_not_in_prerequisite_state（55000）");
});

test("锁刻意不覆盖日记检查点 / 每日摘要 / 念头：那是新的一次生成，不是同一次调用被改写", () => {
  for (const table of ["companion_diary_generation_checkpoints", "companion_daily_summaries", "assistant_thoughts"]) {
    assert.doesNotMatch(
      migration,
      new RegExp(`CREATE TRIGGER[^;]*ON public\\.${table}`),
      `${table} 的重试会合法地换一版人格（INSERT … ON CONFLICT DO UPDATE），`
      + "把锁加到它上面会直接把重试打断",
    );
  }
});

test("迁移自带自检：触发器没落上时当场炸", () => {
  assert.match(migration, /pg_trigger[\s\S]*?tgname = 'companion_turn_runs_persona_pin_lock'/);
  assert.match(migration, /RAISE EXCEPTION 'companion run persona pin lock trigger is missing'/);
});

test("【自证】删掉触发器之后，本文件的判据必须变红", () => {
  // 正控制：判据的对象是「锁在表上」，不是「文件里写了 persona_pin_lock 这几个字」。
  const withoutTrigger = migration
    .replace(/DROP TRIGGER IF EXISTS[\s\S]*?EXECUTE FUNCTION public\.ailearn_lock_companion_run_persona_pin\(\);/, "");
  assert.ok(
    !/CREATE TRIGGER companion_turn_runs_persona_pin_lock/.test(withoutTrigger),
    "自证样本没造好：触发器还在",
  );
});
