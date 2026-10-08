import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * 脑图 handler 的几道**门**。它们一旦被删掉，症状都出现在别处——隐私、引用可信度、
 * 已被收回的笔记、过期 worker 的写入——而 worker 日志上看不出来。
 *
 * 判据对象是「门还在，还在它该挡的那段之前」，不是「文件里有这几个字」。
 *
 * 行为覆盖在 `integration-tests/note-mind-map-postgres.integration.ts`（真连库跑
 * `runNoteMindMapGenerate`），但那份不是 `.test.ts`，不进
 * `worker-handler-test-coverage-ratchet` 读的 blob——所以这里按名盯住这几道门。
 */
const HANDLER = join(import.meta.dirname, "../note-mind-map-generate.ts");
const source = readFileSync(HANDLER, "utf8");

test("外发之前先过同意门：没同意就抛 AIConsentRequiredError", () => {
  const consent = source.indexOf("governance.consentOk");
  const provider = source.indexOf("createGovernedProvider(");
  assert.ok(consent > 0, "同意门不见了——正文会在用户没同意的情况下发给外部模型");
  assert.ok(provider > consent, "同意门必须在拿到 provider、发出第一次请求之前");
  assert.match(source, /if \(!governance\.consentOk\) throw new AIConsentRequiredError\(\);/);
});

test("引用逐字回原文核对跑三道：分段、合并、合并后对整篇再核一次", () => {
  assert.ok(source.includes("reconcileMergedMindMap(parseMindMap(raw, readable), parts)"),
    "合并阶段既要回原文核对，也要把各段 concept 原样保住（模型只许改 parentId）");
  const mergedAt = source.indexOf("if (parts.length > 1)");
  const finalCheckAt = source.indexOf("parseMindMap(JSON.stringify(content), readable)");
  assert.ok(mergedAt > 0 && finalCheckAt > mergedAt,
    "合并之后必须再拿整篇冻结原文核一次——少了它，合并阶段编造的引用会直接落库");
});

test("写入所在的那个事务块里，同时持有租约锁并重查可见性", () => {
  const insertAt = source.indexOf("tx.insert(schema.noteMindMaps)");
  assert.ok(insertAt > 0, "找不到脑图落库那一句，下面两条判据都空转了");
  const blockStart = source.lastIndexOf("withJobTransaction(job, async tx => {", insertAt);
  const block = source.slice(blockStart, insertAt);
  assert.ok(block.includes("await lockJobLease(tx, job)"),
    "写入要在持有租约锁的同一事务里，否则被抢占后仍在跑的旧 worker 会把结果覆盖回去");
  assert.ok(block.includes("stillVisible"),
    "笔记在生成期间被收回或软删时不能继续写入——这条复查要在 insert 之前");
});

test("读不全就明确失败，不许一边少读一边声称 allTextRead", () => {
  assert.match(source, /textChars > 96_000/, "超过全文读取上限要抛错，而不是悄悄截断");
  assert.match(source, /chunks\.length > 8/, "收缩到八块还装不下要抛错——当前模型读不了这篇");
  assert.ok(source.includes("allTextRead: true") && source.includes("imageBlocksNotRead:"),
    "覆盖率要随结果一起存：读了哪些段、跳过几张图，事后才核对得起来");
});
