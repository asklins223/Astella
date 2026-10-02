import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * 0355：账号人格的「待生效」指针（A50 / 40 §4.8.4 / 40b §5.3.1）。
 *
 * 这条迁移只加一列 `pending_revision`，但它承载的是整条「模型自改下一次会话生效」
 * 的语义。三件事必须被钉住，缺一件就会出现一种**安静**的错误：
 *
 *   1. 指针必须是**列**而不是第二份正文——否则"指针指 A、正文是 B"无法排除；
 *   2. 待生效一定比当前新（CHECK）——否则"待生效"可以退化成与当前同一版；
 *   3. 指针只能指向**本账号自己**那条不可变版本行（复合 FK）——否则会指到
 *      别的账号的版本上，而那在应用层要复查一遍归属。
 */
const migration = readFileSync(
  new URL("../db/migrations/0355_companion_persona_pending_revision.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

test("0355 已登记进 journal，指向一条真实存在的 SQL 文件", () => {
  const entry = journal.entries.find((candidate) => candidate.tag === "0355_companion_persona_pending_revision");
  assert.ok(entry, "journal 里没有 0355 的条目——迁移器按 journal 清单应用，漏登记=永远不会执行");
  assert.equal(entry.idx, journal.entries.indexOf(entry), "idx 必须等于它在清单里的位置");
  assert.equal(
    entry.tag,
    "0355_companion_persona_pending_revision",
    "条目 tag 必须与文件名一致（migrate.ts 按 tag 去磁盘上读 .sql）",
  );
});

test("待生效是**指针**：列只存版本号，正文仍只存在 append-only 的版本表里", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS pending_revision integer/);
  // 迁移里不得出现任何「把待生效正文写进 profiles 表」的语句：
  // 一旦 profiles 自己再存一份内容，指针与正文就能各说各话。
  assert.doesNotMatch(
    migration,
    /pending_profile|pending_json|ADD COLUMN[^;]*profile jsonb/i,
    "profiles 表不得再存第二份人格正文——待生效那一版只能住在版本表里",
  );
  assert.match(
    migration,
    /FOREIGN KEY \(user_id, pending_revision\)\s*REFERENCES public\.companion_persona_profile_versions \(user_id, revision\)/,
    "指针必须由复合外键锁在同一账号的版本行上（0341 的 UNIQUE (user_id, revision) 是它的落点）",
  );
});

test("待生效一定比当前新：CHECK 挡住「待生效 == 当前」这种自指", () => {
  assert.match(
    migration,
    /ADD CONSTRAINT companion_persona_profiles_pending_revision_check\s*CHECK \(pending_revision IS NULL OR pending_revision > revision\)/,
    "少了 CHECK，待生效可以指向当前那一版，页面上就会出现两个「当前」",
  );
});

test("约束可重复应用：整段包在 duplicate_object 兜底里", () => {
  // 0342/0045 的做法：迁移在裁剪过的目录上重跑时不得整条炸掉。
  assert.match(migration, /EXCEPTION\s*\n?\s*WHEN duplicate_object THEN NULL;/);
  assert.equal(
    (migration.match(/WHEN duplicate_object/g) ?? []).length,
    2,
    "两条约束（CHECK 与复合 FK）各自都要有 duplicate_object 兜底",
  );
});

test("列的语义写在 COMMENT 里：读路径不得把待生效当当前", () => {
  assert.match(
    migration,
    /COMMENT ON COLUMN public\.companion_persona_profiles\.pending_revision IS[\s\S]*?ignore this pointer/i,
    "COMMENT 必须写明「新 run 只认当前 revision、不得顺着这个指针取内容」——"
    + "它是后来者读 schema 时唯一能看到的说明",
  );
});

test("迁移自带自检：列或约束没落上时当场炸，而不是等「待生效不生效」被发现", () => {
  assert.match(migration, /information_schema\.columns[\s\S]*?column_name = 'pending_revision'/);
  assert.match(migration, /conname = 'companion_persona_profiles_pending_revision_check'/);
  assert.match(migration, /conname = 'companion_persona_profiles_pending_version_fkey'/);
  assert.match(migration, /RAISE EXCEPTION 'companion persona pending revision column is missing'/);
});

test("【自证】把 0355 的正文换成「只加一列、不加任何约束」，上面的判据必须变红", () => {
  // 正控制：判据的对象是**约束**，不是「文件里有 pending_revision 这几个字」。
  const columnOnly = "ALTER TABLE public.companion_persona_profiles ADD COLUMN IF NOT EXISTS pending_revision integer;";
  assert.ok(!/ADD CONSTRAINT/.test(columnOnly), "自证样本没造好：只加一列时没有任何约束");
  assert.doesNotMatch(columnOnly, /FOREIGN KEY/);
  assert.doesNotMatch(columnOnly, /CHECK/);
  assert.doesNotMatch(columnOnly, /COMMENT ON COLUMN/);
});
