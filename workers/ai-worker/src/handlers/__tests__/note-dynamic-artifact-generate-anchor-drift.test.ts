import assert from "node:assert/strict";
import test from "node:test";
import { anchorMatches } from "../note-dynamic-artifact-generate.ts";

/**
 * P1-19：动态讲解的**锚点漂移**判定。
 *
 * ## 这条判定是什么
 *
 * 用户在协作笔记里选中一句原句、点了"做一份互动演示"，任务入队时把选区的
 * start/end、选中的文字（excerpt），以及**选区前后各 120 字符**（prefix/suffix）
 * 一起冻进 payload。worker 真正跑到时，笔记可能已经改过了。
 *
 * `anchorMatches` 就是那个"还准不准"的判断。准就继续，不准就拒。
 *
 * ## 为什么必须测
 *
 * 这是一条**安全边界**，不是业务规则：不判的后果是模型拿到一段与用户当时所见
 * 不符的上下文，生成的演示"引"了一个用户根本没选中的位置，而页面上看不出来。
 * 而且它漂移得很安静——笔记被改 → 演示照生成 → 没有报错。
 *
 * ## 为什么不端到端测
 *
 * `runNoteDynamicArtifactGenerate` 只有一个导出，要跑它得 mock 租约断言、事务、
 * AI 治理上下文、provider 构造与产物落库。成本高且脆。而这一条是**纯函数**，
 * 覆盖它的失败模式（改一个字、删一段、换一篇）才是重点。
 */

const TEXT = "0123456789".repeat(30); // 300 字符

function anchorAt(start: number, end: number) {
  return {
    // 这三个字段 anchorMatches 不读，但真实 anchor 带它们，桩要照全
    noteVersionId: "00000000-0000-4000-8000-000000000001",
    startBlockOrdinal: 3,
    endBlockOrdinal: 3,
    startOffset: start,
    endOffset: end,
    excerpt: TEXT.slice(start, end),
    prefix: TEXT.slice(Math.max(0, start - 120), start),
    suffix: TEXT.slice(end, end + 120),
  };
}

test("原文没变时锚点匹配（这是基准：别把正常路径判死）", () => {
  const anchor = anchorAt(150, 160);
  assert.equal(anchorMatches(TEXT, anchor), true);
});

test("选中的那一句被改写 → 判为不匹配", () => {
  const anchor = anchorAt(150, 160);
  const edited = TEXT.slice(0, 150) + "X".repeat(10) + TEXT.slice(160);
  assert.equal(anchorMatches(edited, anchor), false);
});

test("选区之前被改（prefix 对不上）→ 判为不匹配", () => {
  const anchor = anchorAt(150, 160);
  // 在选区**前面**插一个字：选中的 excerpt 还在，但 prefix 整体右移了一格
  const edited = "Z" + TEXT;
  assert.equal(anchorMatches(edited, anchor), false);
});

test("选区之后被改（suffix 对不上）→ 判为不匹配", () => {
  const anchor = anchorAt(30, 40); // 选区靠前，suffix 覆盖 [40, 160)
  // 改点必须落在 suffix 窗口内；落在窗口外时 suffix 不变（那是另一条判据管的）
  const edited = TEXT.slice(0, 100) + "Q" + TEXT.slice(100);
  assert.equal(anchorMatches(edited, anchor), false);
  // 对照：改在 suffix 窗口**之外**，这一条不该由 suffix 抓到
  const outside = TEXT.slice(0, 200) + "Q" + TEXT.slice(200);
  assert.equal(anchorMatches(outside, anchor), true,
    "窗口外的改动不改变 prefix/suffix/excerpt——这条判据只看锚点附近，不看全文");
});

test("原文整体被替换成同样长度的另一篇 → 判为不匹配", () => {
  const anchor = anchorAt(150, 160);
  const other = "9".repeat(TEXT.length);
  assert.equal(anchorMatches(other, anchor), false);
});

test("原文变短、endOffset 越界 → 判为不匹配（不是抛错）", () => {
  const anchor = anchorAt(150, 160);
  const truncated = TEXT.slice(0, 100);
  assert.equal(anchorMatches(truncated, anchor), false);
});

test("空原文 + 空选区：一致才算匹配", () => {
  const empty = {
    noteVersionId: "00000000-0000-4000-8000-000000000001",
    startBlockOrdinal: 0,
    endBlockOrdinal: 0,
    startOffset: 0, endOffset: 0, excerpt: "", prefix: "", suffix: "",
  };
  assert.equal(anchorMatches("", empty), true);
  // 一旦原文有内容而选区声称是空选区，就不匹配
  assert.equal(anchorMatches("x", empty), false);
});

test("选区贴着开头/结尾时 prefix/suffix 的截断是对的（不该误判）", () => {
  const atStart = anchorAt(0, 5);
  assert.equal(atStart.prefix, "", "开头选区没有 prefix");
  assert.equal(anchorMatches(TEXT, atStart), true);

  const atEnd = anchorAt(TEXT.length - 5, TEXT.length);
  assert.equal(atEnd.suffix, "", "结尾选区没有 suffix");
  assert.equal(anchorMatches(TEXT, atEnd), true);
});

test("【自证】判定真的在比内容（把全文清空后仍判匹配就说明它退化成了恒真）", () => {
  const anchor = anchorAt(150, 160);
  // 这几条若判成 true，说明 anchorMatches 已经不再检查内容
  assert.equal(anchorMatches(TEXT.slice(0, 140), anchor), false, "短前缀必须不匹配");
  assert.equal(anchorMatches(TEXT + "!", anchor), true,
    "尾部追加在 suffix 窗口之外，锚点附近没变——这是本判据的**设计边界**，不是漏洞："
    + "它只保证『用户选的那一句及其上下文没被动过』，不保证全文没动过");
});
