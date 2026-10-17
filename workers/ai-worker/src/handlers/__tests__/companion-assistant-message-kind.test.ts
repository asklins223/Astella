import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { companionAssistantMessageKind } from "../turn/companion-dialogue-content.ts";

/**
 * 她主动说的那句话，无论走 `companion_publish_utterance` 分句还是走普通收尾，
 * 落库的 kind 必须是同一个（2026-10-13 方案 56 遗留缺陷）。
 *
 * 病：工具那条路写 `proactive`，终态正文写死 `text`。于是
 * `runCompanionInitiative` 的主动节奏读数
 * （`max(created_at) WHERE role='assistant' AND kind='proactive'`）与按 kind
 * 认她发言的历史/记忆/摘要都漏掉她主动说的大部分话——真库 23 条 initiative
 * 助手消息里 22 条是 `text`。
 *
 * 这一份钉判据本身（不触 DB，跑得快）；真实 handler 落库的那一条由
 * `integration-tests/companion-dialogue-postgres.integration.ts` 盯。
 */

test("主动交流那一轮的终态消息记 proactive", () => {
  assert.equal(
    companionAssistantMessageKind({ initiativeInput: { version: 1, kind: "initiative" } }),
    "proactive",
  );
});

test("普通问答的终态消息记 text", () => {
  assert.equal(companionAssistantMessageKind({ initiativeInput: null }), "text");
  // read 阶段没有主动输入时这个字段可能整个不出现——"没有"不是"有但为空"。
  assert.equal(companionAssistantMessageKind({}), "text");
  assert.equal(companionAssistantMessageKind(undefined), "text");
});

const FINALIZATION = join(import.meta.dirname, "../turn/companion-dialogue-finalization.ts");
const finalizationSource = readFileSync(FINALIZATION, "utf8");
const STORE = join(import.meta.dirname, "../turn/companion-dialogue-store.ts");
const storeSource = readFileSync(STORE, "utf8");

/**
 * 终态写入 2026-10-14 从 `companion-dialogue` 抽进了 `companion-dialogue-store`
 * 的 `insertCompanionFinalAssistantMessage`（那个编排文件贴着神文件阈值），
 * 2026-10-16（神文件棘轮）调用点又随终态事务搬进 `companion-dialogue-finalization.ts`。
 * 本体分居两处，判据也得分两处盯——盯错地方就会一直红在错误的位置，
 * 而真正的回归（INSERT 里写死 'text'）反而没人看。
 */
test("终态写入用这一处判据，不在 INSERT 里写死 kind", () => {
  const start = storeSource.indexOf("INSERT INTO companion_messages");
  assert.ok(start > 0, "判据认不出终态写入——语句被改名或搬走了，这里会红（那是该红的时候）");
  const statement = storeSource.slice(start, storeSource.indexOf("`);", start));
  // kind 必须由参数传入：写死 'text' 会让主动轮的收尾漏记 proactive。
  assert.match(statement, /\$\{args\.kind\}/,
    "INSERT 的 kind 必须取自参数；写死会让主动节奏与历史漏掉她自己的发言");
  assert.doesNotMatch(statement, /'text'/);
});

test("调用点把 read 交给判据，不在收尾里自定 kind", () => {
  assert.match(finalizationSource, /kind:\s*companionAssistantMessageKind\(read\)/,
    "终态写入的 kind 必须来自 companionAssistantMessageKind(read)——"
    + "主动轮的收尾按 read.initiativeInput 记 proactive，写死 'text' 会漏掉她主动说的大部分话");
});
