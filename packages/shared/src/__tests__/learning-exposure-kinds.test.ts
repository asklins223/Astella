/**
 * 三档"揭示类"记账的成员表只留一份：`EXPOSURE_KINDS_V2`。
 *
 * 这份成员关系此前被抄了七处：合同 enum、`surface-service.ts:164`、
 * `topology-repository.ts:459`、`reveal-service.ts:57`、`target-snapshot-adapter.ts:293`、
 * `activation-service.ts:2084`（那处是"答案级"两档的子集，现在叫
 * `ANSWER_BEARING_EXPOSURE_KINDS_V2`）、`db-schema/card-generation-v2.ts` 的 CHECK，
 * 以及 worker 里那份两档 union 类型。抄第二遍起它就只会漂：加一档时少改一处不会红，
 * 只会让那一档在那个读点被静默漏掉——与 39d W4-2 那三张手抄顺位表是同一族病
 * （那一格见 `primary-action-precedence.test.ts`）。
 *
 * 一条明确的"这一格不断"：**不拿字面量断言某一档有没有生产者**。第一版加了这么一条
 * （登记 evidence_reveal 为零写入方），跑灵敏度判据时被自己抓住——那一档在 worker 里由分类器
 * 返回、以变量形状落库（`companion-answer-exposure.ts:128-140` 交给调用方 `exposureKind: kind`），
 * 字面量扫不到不等于没人写。今天量到的实情是两张表都只有 answer_reveal 行
 * （learning_exposures_v2 65、card_exposure_ledger_v2 6）；那句归 D7 §表 第 26 行的实测，
 * 不归一枚静态守卫，所以第一版那条判据被**删掉**，不是被改弱。
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ANSWER_BEARING_EXPOSURE_KINDS_V2, EXPOSURE_KINDS_V2 } from "../contracts/learning-card-v2-contracts.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
// 2026-09-29（P2-3）：contracts/ 重组后这份定义换了位置。
// 判据的对象是「这份成员表的唯一定义处」，不是某个文件名——所以跟着搬。
const DEFINITION_FILE = "packages/shared/src/contracts/learning-card-v2-contracts.ts";
const MIGRATION_DIR = "apps/api/src/db/migrations";
const RUNTIME_DIRS = ["apps/api/src", "workers/ai-worker/src", "apps/desktop-client/src", "packages/shared/src"];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 一段文本里以字面量出现了哪几档。 */
function kindsIn(text: string): string[] {
  const hits: string[] = [];
  for (const kind of EXPOSURE_KINDS_V2) {
    if (text.includes('"' + kind + '"') || text.includes("'" + kind + "'")) hits.push(kind);
  }
  return hits;
}

/**
 * "又抄了一份清单"的两种形状：同一行里两档以上（数组、union、IN 列表都这样写），
 * 或一个文件集齐整份表（排成多行也抓住）。不按"文件里有两档就算抄"判——worker 那个分类器
 * 本来就要分别返回两档、一处一行，那是分发不是抄表；把分发点都误报成违规的判据等于没有。
 */
function copiesTheList(text: string): string | null {
  for (const line of text.split("\n")) {
    if (kindsIn(line).length >= 2) return line.trim().slice(0, 90);
  }
  return kindsIn(text).length >= EXPOSURE_KINDS_V2.length ? "multiline copy of the whole list" : null;
}

function runtimeSources(): Array<{ rel: string; text: string }> {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry) || /(\.test|\.integration)\.(ts|tsx)$/.test(entry)) continue;
      files.push(full);
    }
  };
  for (const rel of RUNTIME_DIRS) walk(resolve(REPO_ROOT, rel));
  return files.map((full) => ({
    rel: full.slice(REPO_ROOT.length + 1),
    text: stripComments(readFileSync(full, "utf8")),
  }));
}

/** 只取最新那份声明了 exposure_kind CHECK 的迁移；历史迁移不许参与判断。 */
function declaredCheckKinds(): { file: string; kinds: string[] } {
  const candidates = readdirSync(resolve(REPO_ROOT, MIGRATION_DIR))
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .filter((name) => readFileSync(resolve(REPO_ROOT, MIGRATION_DIR, name), "utf8").includes("exposure_kind"))
    .sort();
  assert.ok(candidates.length > 0, "迁移里找不到 exposure_kind 的 CHECK，判据读空了");
  const latest = candidates[candidates.length - 1];
  const sqlText = readFileSync(resolve(REPO_ROOT, MIGRATION_DIR, latest), "utf8");
  const matches = [...sqlText.matchAll(/exposure_kind\s+IN\s*\(([^)]*)\)/g)];
  assert.ok(matches.length > 0, latest + " 里没能解析出 exposure_kind 的取值表");
  const kinds = [...matches[matches.length - 1][1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(kinds.length >= 1, latest + " 解析出的取值为空");
  return { file: latest, kinds };
}

const sources = runtimeSources();

test("分母与库里最新的 CHECK 一致，两份成员表非空且子集关系成立", () => {
  assert.deepEqual([...EXPOSURE_KINDS_V2].sort(), ["answer_editor_view", "answer_reveal", "evidence_reveal"]);
  assert.ok(ANSWER_BEARING_EXPOSURE_KINDS_V2.length >= 2, "答案级那一子集退化成一档以下");
  for (const kind of ANSWER_BEARING_EXPOSURE_KINDS_V2) {
    assert.ok((EXPOSURE_KINDS_V2 as readonly string[]).includes(kind), kind + " 不在全表里");
  }
  const declared = declaredCheckKinds();
  assert.deepEqual(declared.kinds, [...EXPOSURE_KINDS_V2],
    "最新迁移 " + declared.file + " 的 CHECK 与合同成员表不一致（改一档要连着改迁移）");
});

test("成员表只许有一份：别的事件文件里不许再出现两档以上的字面量清单", () => {
  const copies = sources
    .filter(({ rel, text }) => rel !== DEFINITION_FILE && copiesTheList(text) !== null)
    .map(({ rel, text }) => rel + " -> " + copiesTheList(text));
  assert.deepEqual(copies, [],
    "又一处抄了这份成员表：加一档时这里不会红，只会让那一档在这个读点被静默漏掉");
});

test("判据自己的灵敏度：合成文本各判各的", () => {
  assert.notEqual(copiesTheList('const kinds = ["answer_reveal", "evidence_reveal"] as const;'), null,
    "同一行的两档清单没被抓到，判据是瞎的");
  assert.notEqual(copiesTheList('a\nconst x = ["answer_reveal",\n  "evidence_reveal",\n  "answer_editor_view"];'), null,
    "跨行抄整份表没被抓到，只挡住了单行写法");
  assert.equal(copiesTheList(stripComments('// 注释里 ["answer_reveal", "evidence_reveal"] 不算数')), null,
    "注释里的字面量被算成了清单");
  assert.equal(copiesTheList('return { kind: "answer_reveal" };\nreturn { kind: "evidence_reveal" };'), null,
    "分发点（一处一档、各自成行）被误报成抄表");
  const synthetic = "exposure_kind text NOT NULL CHECK (exposure_kind IN ('answer_reveal','other_kind'))";
  const parsed = [...synthetic.matchAll(/exposure_kind\s+IN\s*\(([^)]*)\)/g)];
  assert.deepEqual([...parsed[parsed.length - 1][1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
    ["answer_reveal", "other_kind"], "迁移解析数错了取值");
});
