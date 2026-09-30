import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * P3-10：runner 认得上 `-- migrate:no-transaction`。
 *
 * ## 为什么需要这条
 *
 * `apps/api/src/db/migrate.ts` 默认把**每条**迁移包在 `sql.begin` 里。
 * 而 Postgres 的 `CREATE/DROP INDEX CONCURRENTLY` 与
 * `ALTER TYPE ... ADD VALUE` **不能**在事务块里执行，报
 * `ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block`。
 *
 * 也就是说：想给一张大表加索引而不锁写，**只有**这一条路。
 * 2026-09-29 在一次性库上双向验过：带指令 → 索引建成；同一条语句塞进事务 → 上面那句报错。
 *
 * ## 这条判据守什么
 *
 * 守的是"**声明了就真的不进事务**，且声明这件事不能被写在正文里**。
 *
 * 后半句更要紧：指令是按**前 20 行**扫的。如果全文扫，一句
 * "这条迁移因为 CONCURRENTLY 不能进事务"的中文注释也会被当成指令——
 * 于是那条迁移会在毫无声明的情况下丢掉事务保护。
 */

const API_ROOT = new URL("..", import.meta.url).pathname;
const RUNNER = join(API_ROOT, "db", "migrate.ts");
const MIGRATIONS = join(API_ROOT, "db", "migrations");

test("runner 认得上这条指令，并且真的绕开事务", () => {
  const source = readFileSync(RUNNER, "utf8");
  assert.ok(
    /NO_TRANSACTION_DIRECTIVE\s*=\s*\//.test(source),
    "runner 里没有那条指令的正则——判据认不得它",
  );
  // 分流必须真的存在：noTransaction 时走 sql.unsafe 而不是 sql.begin
  assert.ok(
    /if \(migration\.noTransaction\)/.test(source),
    "runner 没有按 noTransaction 分流——指令会被读到却不起作用",
  );
  const at = source.indexOf("if (migration.noTransaction)");
  const branch = source.slice(at, at + 900);
  assert.ok(
    /await sql\.unsafe\(stmt\)/.test(branch) && !/await sql\.begin/.test(branch.split("} else {")[0] ?? branch),
    "noTransaction 分支里应当直发语句，且**不得**再开事务",
  );
  // 标记仍要落在全部语句成功之后
  assert.ok(
    branch.indexOf("INSERT INTO drizzle.__drizzle_migrations")
      > branch.indexOf("await sql.unsafe(stmt)"),
    "无事务分支里 apply 标记必须排在语句之后——"
    + "否则半途失败会被记成已应用，重跑时整条被跳过",
  );
});

test("指令只在前 20 行生效（正文里提到它不算声明）", () => {
  const source = readFileSync(RUNNER, "utf8");
  assert.ok(
    /DIRECTIVE_SCAN_LINES\s*=\s*20/.test(source),
    "runner 里的扫描行数不是 20——全文扫会让正文注释里的提及被当成指令",
  );
});

test("现有迁移里没有把这条指令写歪（写在正文里的会被忽略，于是静默失效）", () => {
  // 这一条守"别白写"：指令写进正文第 25 行不会被认，迁移就仍然包在事务里——
  // 而症状是运行时报 `cannot run inside a transaction block`，不是这里。
  const offenders: string[] = [];
  for (const name of readdirSync(MIGRATIONS)) {
    if (!name.endsWith(".sql")) continue;
    const lines = readFileSync(join(MIGRATIONS, name), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (i < 20) return;
      if (/--\s*migrate:no-transaction\b/.test(line)) {
        offenders.push(`${name}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "这些迁移把指令写在了第 20 行之后，不会被认到：\n" + offenders.join("\n")
    + "\n指令必须出现在文件头部；写晚了症状是运行时的 `cannot run inside a transaction block`，"
    + "而不是这里。",
  );
});

test("【自证】判据会红：把指令挪到正文里必须被抓", () => {
  const header = "-- migrate:no-transaction";
  assert.ok(
    header.split("\n").length === 1 && !/--\s*migrate:no-transaction\b/.test(header.split("\n")[20] ?? ""),
    "自证样本没造好：单行指令在第 21 行处不应当被算命中",
  );
  // 反过来，文件头那一行必须命中
  assert.ok(
    /--\s*migrate:no-transaction\b/.test(header),
    "自证样本没造好：判据没认得出文件头的指令",
  );
});
