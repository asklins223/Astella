import { test } from "node:test";
import assert from "node:assert/strict";
import {
  purifyVoiceText,
  spokenFormula,
  splitCompanionTtsSegments,
  splitCompanionTtsSegmentsIncremental,
  companionSegmentId,
  splitCommittedDisplaySegments,
  TTS_MAX_SEGMENTS,
  TTS_MAX_TOTAL_CHARS,
} from "../tts-segments.ts";
import {
  stripVoiceExpressionTags,
  extractVoiceEmotion,
} from "@astella/shared/voice-expression-tags";

test("净化：去掉 markdown/URL/代码块，保留中文", () => {
  const p = purifyVoiceText("好的，`x` 继续 [链接](https://a.b/c) 学习。```code``` 我们继续。");
  assert.equal(p.includes("https"), false, "URL 剔除");
  assert.equal(p.includes("```"), false, "代码块剔除");
  assert.ok(p.includes("好的"), "中文保留");
  assert.ok(p.includes("我们继续"));
});

test("净化：保留正文半角括号/连字符，只剥离 markdown 语法", () => {
  const p = purifyVoiceText("第3-4题 (b)：**重点** 请参考 [文档](https://a.b/c)。");
  assert.ok(p.includes("第3-4题 (b)"), "半角括号与连字符保留");
  assert.ok(p.includes("重点"), "强调内容保留");
  assert.ok(p.includes("文档"), "链接文字保留");
  assert.equal(p.includes("**"), false, "强调标记剥离");
  assert.equal(p.includes("https"), false, "URL 剥离");
});

test("净化：有序列表标记不进朗读文本（实机落过一段单独的 `4.`）", () => {
  const p = purifyVoiceText("疏散四步：\n1. 关燃气\n2. 带应急包\n3. 走安全通道\n4. 到集合点");
  assert.equal(p.includes("4."), false, "有序列表符号剥离");
  assert.ok(p.includes("关燃气") && p.includes("到集合点"), "条目正文保留");
  // `1.5 米` 这类正文不能被误伤：数字后必须紧跟 `.`/`)` 且再接空白才算列表项
  assert.ok(purifyVoiceText("绳子长 1.5 米。").includes("1.5 米"), "小数保留");
  assert.ok(purifyVoiceText("2026 年计划。").includes("2026 年计划"), "年份保留");
});

test("净化：公式与表格转成可朗读的中文，不把 LaTeX/竖线送去 TTS", () => {
  const inline = purifyVoiceText("根据公式 $E = mc^2$，能量等于质量乘以光速的平方。");
  assert.ok(inline.includes("E 等于 mc 的平方"), inline);
  assert.equal(/[$\\^_{}]/.test(inline), false, "不残留 LaTeX 符号");

  const fraction = purifyVoiceText("这个式子 $\\frac{a}{b} + \\sqrt{x}$ 表示比值。");
  assert.ok(fraction.includes("b 分之 a"), fraction);
  assert.ok(fraction.includes("根号 x"), fraction);
  assert.equal(/\\/.test(fraction), false, "不念反斜杠命令");

  const table = purifyVoiceText("| 项目 | 数值 |\n| --- | --- |\n| 速度 | 5 m/s |\n| 时间 | 2 s |");
  assert.ok(table.includes("表格，列有：项目、数值"), table);
  assert.ok(table.includes("第 1 行"), table);
  assert.ok(table.includes("5 米每秒"), table);
  assert.equal(/[|]/.test(table), false, "不念表格竖线");
  assert.equal(table.includes("---"), false, "不念表格分隔线");

  const matrix = purifyVoiceText("矩阵 \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} 表示变换。");
  assert.ok(matrix.includes("矩阵 这个公式 表示变换"), matrix);
  assert.equal(/[\\&]/.test(matrix), false, "矩阵不念原始语法");
});

test("spokenFormula：常见结构转口语，未知环境明确退回占位语", () => {
  assert.equal(spokenFormula("E=mc^2"), "E 等于 mc 的平方");
  assert.equal(spokenFormula("\\frac{1}{2}mv^2"), "2 分之 1 mv 的平方");
  assert.equal(spokenFormula("\\sqrt[3]{x}"), "3 次根号 x");
  assert.equal(spokenFormula("\\begin{cases} a & b \\end{cases}"), "这个公式");
  assert.equal(spokenFormula("50\\%"), "百分之50");
});

test("净化：讲解里的裸公式（没有 $ 定界）也转成口语，不逐字符念符号", () => {
  // 2026-10-17 真实回合：模型写的是 `P = U²/R`，旧净化只认 $…$/LaTeX，
  // 于是 TTS 原样念"P 等于 U 平方斜杠 R"这种谁也听不懂的串。
  const power = purifyVoiceText("电压固定时：P = U²/R。");
  assert.ok(power.includes("P 等于 U 的平方 除以 R"), power);
  assert.equal(/[=/²∝]/.test(power), false, "不把运算符和上标送去 TTS");

  const current = purifyVoiceText("电流固定时：P = I²R。");
  assert.ok(current.includes("I 的平方 乘 R"), current);

  const proportional = purifyVoiceText("P ∝ 1/R，所以电阻越大功率越小。");
  assert.ok(proportional.includes("P 正比于 R 分之一"), proportional);

  // 不是公式的斜杠与连字符必须原样保留（"和/或"、日期）。
  const prose = purifyVoiceText("这和/或那种写法无关，日期 2026-10-17 也不动。");
  assert.equal(prose, "这和/或那种写法无关，日期 2026-10-17 也不动。");
});

test("切句：按。！？切分后贪心合并相邻句，ordinal 递增，textSha256 64 hex", () => {
  // 2026-08-12：段落间隔优化——相邻句子贪心合并到目标段长（≤120 字符）。
  // 三句短句应合并为 1-2 段（旧行为每句一段=3 段，段间独立 TTS 请求造成
  // 朗读间隔被成倍放大）。
  const segs = splitCompanionTtsSegments("这是第一句的内容。这是第二句的内容！这是第三句的内容？");
  assert.ok(segs.length >= 1 && segs.length <= 2, `合并后段数=${segs.length}`);
  for (const s of segs) {
    assert.ok(s.ordinal >= 1 && s.ordinal <= TTS_MAX_SEGMENTS);
    assert.match(s.textSha256, /^[a-f0-9]{64}$/);
    assert.match(s.segmentId, /^[a-f0-9]{64}$/);
  }
  // 合并段应保留全部句子文本，且段内自然衔接
  const all = segs.map((s) => s.text).join("");
  assert.ok(all.includes("第一句") && all.includes("第二句") && all.includes("第三句"));
  assert.equal(segs[0].ordinal, 1);
});

test("切句：单段 ≤160 字符，超长在标点处强制切分", () => {
  const long = "这是一个很长的句子，没有句号只有逗号，" + "啊".repeat(300) + "结束";
  const segs = splitCompanionTtsSegments(long);
  for (const s of segs) {
    assert.ok(s.text.length <= 160, `segment ${s.ordinal} len=${s.text.length}`);
  }
  assert.ok(segs.length > 1, "超长被切分");
});

test("切句：上限 40 段与 4000 字（超限只显示文字）", () => {
  const many = Array.from(
    { length: 120 },
    (_, i) => `第${i + 1}段句子内容，继续写一些字让段落更长一些，这里再补充几个短语增加长度。`,
  ).join("");
  const segs = splitCompanionTtsSegments(many);
  assert.ok(segs.length <= TTS_MAX_SEGMENTS, `segments=${segs.length}`);
  assert.ok(segs.length > 20, `长文本段数应超过原 20 段上限（当前 ${segs.length}）——15a 修复后长回复后面不再"不读"`);
  const total = segs.reduce((acc, s) => acc + s.text.length, 0);
  assert.ok(total <= TTS_MAX_TOTAL_CHARS, `total=${total}`);
});

test("净化后为空 → 零段（不发 voice.segment.ready）", () => {
  assert.deepEqual(splitCompanionTtsSegments("```code```  `x`  "), []);
  assert.deepEqual(splitCompanionTtsSegments("   "), []);
});

test("companionSegmentId：runId/generation/textSha256 参与哈希且稳定", () => {
  const id1 = companionSegmentId("run-1", 0, 1, "a".repeat(64));
  const id2 = companionSegmentId("run-1", 0, 1, "a".repeat(64));
  const id3 = companionSegmentId("run-2", 0, 1, "a".repeat(64));
  const id4 = companionSegmentId("run-1", 1, 1, "a".repeat(64));
  const id5 = companionSegmentId("run-1", 0, 2, "a".repeat(64));
  const id6 = companionSegmentId("run-1", 0, 1, "b".repeat(64));
  assert.equal(id1, id2);
  assert.notEqual(id1, id3);
  assert.notEqual(id1, id4);
  assert.notEqual(id1, id5);
  assert.notEqual(id1, id6);
  assert.match(id1, /^[a-f0-9]{64}$/);
});

test("增量切段：完整句立即切出、未完成句留 rest、final flush", () => {
  let state = { rest: "", sentCount: 0, sentChars: 0 };
  // 第一块：两个完整句 + 半句
  let r = splitCompanionTtsSegmentsIncremental("你好世界。今天天气不错。明天会", state);
  assert.equal(r.segments.length, 2, "两个完整句立即成段");
  assert.ok(r.segments[0].text.includes("你好世界"));
  assert.ok(r.segments[1].text.includes("今天天气不错"));
  assert.equal(r.next.rest, "明天会", "半句留在 rest");
  state = r.next;
  // 第二块：补全 rest + 新句
  r = splitCompanionTtsSegmentsIncremental("更好。后天再说。", state);
  assert.equal(r.segments.length, 2, "rest 补全 + 新完整句");
  assert.ok(r.segments[0].text.includes("明天会更好"));
  assert.equal(r.next.rest, "", "无未完成句");
  state = r.next;
  // final flush：rest 空则无段
  r = splitCompanionTtsSegmentsIncremental("", state, true);
  assert.equal(r.segments.length, 0);
  // ordinal 连续递增
  assert.equal(r.next.sentCount, 4);
});

test("增量切段：final flush 强制切出 rest", () => {
  let state = { rest: "", sentCount: 0, sentChars: 0 };
  let r = splitCompanionTtsSegmentsIncremental("只说了半句没说完", state);
  assert.equal(r.segments.length, 0, "无完整句不切");
  assert.equal(r.next.rest, "只说了半句没说完");
  state = r.next;
  r = splitCompanionTtsSegmentsIncremental("", state, true);
  assert.equal(r.segments.length, 1, "final 强制切出 rest");
  assert.ok(r.segments[0].text.includes("只说了半句没说完"));
});

test("增量切段：上限按累计维护（超限丢弃不朗读）", () => {
  const opts = { maxSegments: 2, maxTotalChars: 1000 };
  let state = { rest: "", sentCount: 0, sentChars: 0 };
  let r = splitCompanionTtsSegmentsIncremental(
    "第一句。第二句。第三句。第四句。",
    state,
    false,
    opts,
  );
  assert.equal(r.segments.length, 2, "只切 2 段（上限）");
  assert.equal(r.next.sentCount, 2);
});

// ─── 15b 二期：情感与富语言标签 ─────────────────────────────────────────

test("标签剥离：白名单标签全部剥离（含大小写与带空格标签）", () => {
  const input =
    "[excited]今天天气真不错！[laughing]我们一起出去玩吧！" +
    "[Very Fast]快一点说。[deep and loud shouting]大声喊！";
  const out = stripVoiceExpressionTags(input);
  assert.equal(out, "今天天气真不错！我们一起出去玩吧！快一点说。大声喊！");
});

test("标签剥离：不误伤正文普通方括号（[重要] 原样保留）", () => {
  const out = stripVoiceExpressionTags("[重要] 这道题 [b] 不是标签");
  assert.equal(out, "[重要] 这道题 [b] 不是标签");
});

// 2026-08-24 行为变更（AI 设计审查 §4.2）：模型自造的 ASCII 标签形态 token
// 现在一并剥离（此前会漏进 TTS 被当普通文字朗读）；中文正文方括号不受影响。
test("标签剥离：模型自造标签剥离，正文方括号保留", () => {
  const out = stripVoiceExpressionTags("[happy] 自定义标签会剥离 [excited]ok [重要]保留");
  assert.equal(out, " 自定义标签会剥离 ok [重要]保留");
});

test("标签剥离：无标签文本原样返回", () => {
  const input = "今天想学点什么？";
  assert.equal(stripVoiceExpressionTags(input), input);
});

test("emotion 解析：取段内最后一个控制类标签（小写）", () => {
  assert.equal(extractVoiceEmotion("[excited]太好了！"), "excited");
  assert.equal(
    extractVoiceEmotion("[serious]注意安全。[excited]开始吧！"),
    "excited",
  );
  assert.equal(extractVoiceEmotion("[giggles]只有富语言标签"), null);
  assert.equal(extractVoiceEmotion("没有标签"), null);
  assert.equal(extractVoiceEmotion("[Very Slowly]慢一点"), "very slowly");
});

// ─── 15b 二期（问题2 修复）：首段提前触发 ───────────────────────────────

test("首段提前：缓冲 ≥14 字且无完整句也切段（声音尽早开始）", () => {
  let state = { rest: "", sentCount: 0, sentChars: 0 };
  const r = splitCompanionTtsSegmentsIncremental(
    "这句话还没有说完但是已经够长了",
    state,
    false,
    { firstSegmentMinChars: 14 },
  );
  assert.equal(r.segments.length, 1, "≥14 字即切出首段");
  assert.equal(r.next.sentCount, 1);
  assert.equal(r.next.rest, "", "缓冲已切走");
  assert.ok(r.segments[0].text.includes("这句话还没有说完"), "半句也被切出");
});

test("首段提前：不足 14 字仍等完整句（不提前切）", () => {
  let state = { rest: "", sentCount: 0, sentChars: 0 };
  const r = splitCompanionTtsSegmentsIncremental(
    "太短了。",
    state,
    false,
    { firstSegmentMinChars: 14 },
  );
  assert.equal(r.segments.length, 1, "有完整句正常切");
  // 无完整句且不足 14 字 → 不切
  const r2 = splitCompanionTtsSegmentsIncremental(
    "这句话没说完",
    state,
    false,
    { firstSegmentMinChars: 14 },
  );
  assert.equal(r2.segments.length, 0, "不足 14 字且无完整句 → 不切");
  assert.equal(r2.next.rest.length > 0, true, "留在 rest");
});

test("首段提前：只对首段生效，后续段仍等完整句", () => {
  // 首段提前切出后（sentCount=1），后续累积无完整句 → 不切
  const r1 = splitCompanionTtsSegmentsIncremental(
    "这是第一段提前切出来的内容对吧",
    { rest: "", sentCount: 0, sentChars: 0 },
    false,
    { firstSegmentMinChars: 14 },
  );
  assert.equal(r1.segments.length, 1, "首段提前切出");
  const r2 = splitCompanionTtsSegmentsIncremental(
    "第二句还没说完",
    r1.next,
    false,
    { firstSegmentMinChars: 14 },
  );
  assert.equal(r2.segments.length, 0, "第二段无完整句不切");
  assert.equal(r2.next.rest, "第二句还没说完");
});

// 2026-08-24（三轮自查）：首段同样受单段 160 字符合同上限约束——此前
// 整个首刷批次（可达 256+ 字符）无上限成段，web 客户端会按 >160 静默丢音频。
test("首段提前：超长批次截到 160 上限，超出部分留 rest 不丢失", () => {
  const big = "a".repeat(300);
  const r = splitCompanionTtsSegmentsIncremental(
    big,
    { rest: "", sentCount: 0, sentChars: 0 },
    false,
    { firstSegmentMinChars: 14 },
  );
  assert.equal(r.segments.length, 1);
  assert.ok(r.segments[0].text.length <= 160, "首段不超合同上限");
  assert.equal(r.next.rest.length, 300 - 160, "超出部分留在 rest 继续正常切句");
  assert.equal(r.segments[0].text + r.next.rest, big, "文本无丢失");
});

// ─── 展示段切分（splitCommittedDisplaySegments）──────────────────────────
// 这是**生产路径**用的那个切段器（companion-dialogue.ts 的 emitVisibleVoiceSegments），
// 而它此前一条直接单测都没有——只有集成测试间接覆盖。方案 29 §14.11 修复 ④ 改的就是
// 它，所以先把不变量钉住：displayText 必须逐字等于 fullText.slice(displayStart, displayEnd)。

test("展示段：句末标点成段，且 displayText 与绝对下标逐字对齐", () => {
  const text = "第一句。第二句！第三句？";
  const r = splitCommittedDisplaySegments(text, { cursor: 0, sentCount: 0 }, false);
  assert.deepEqual(r.segments.map((s) => s.displayText), ["第一句。", "第二句！", "第三句？"]);
  for (const seg of r.segments) {
    assert.equal(seg.displayText, text.slice(seg.displayStart, seg.displayEnd), "下标与文本必须自洽");
  }
  assert.deepEqual(r.next, { cursor: text.length, sentCount: 3 });
});

test("展示段：没有句末标点时按目标长度在逗号处切，不切碎正常长度的句子", () => {
  const long = `${"甲".repeat(30)}，${"乙".repeat(30)}，${"丙".repeat(30)}，尾巴。`;
  const r = splitCommittedDisplaySegments(long, { cursor: 0, sentCount: 0 }, false, { targetSegmentChars: 48 });
  assert.ok(r.segments.length >= 2, "长句被切开");
  for (const seg of r.segments) {
    assert.ok(seg.displayText.length <= 48, `每段不超目标长度：${seg.displayText.length}`);
    assert.equal(seg.displayText, long.slice(seg.displayStart, seg.displayEnd));
  }
  assert.equal(r.segments.map((s) => s.displayText).join(""), long, "文本不丢不重");
  // 短句一个都不该被切：p50/p90 的段（19/41 字）不受这条规则影响。
  const short = "短句一。短句二，还没完。";
  const s = splitCommittedDisplaySegments(short, { cursor: 0, sentCount: 0 }, false);
  assert.deepEqual(s.segments.map((x) => x.displayText), ["短句一。", "短句二，还没完。"]);
});

test("展示段：句内没有逗号可切时仍按 160 硬上限切，不越合同", () => {
  const text = "甲".repeat(400);
  // isFinal=true：尾部不足 160 的那截也要切出来，否则它是在等后续文本（正常行为）。
  const r = splitCommittedDisplaySegments(text, { cursor: 0, sentCount: 0 }, true);
  assert.ok(r.segments.every((s) => s.displayText.length <= 160), "不越 160 上限");
  assert.equal(r.segments.map((s) => s.displayText).join(""), text, "文本不丢");
  assert.equal(r.next.cursor, text.length, "全部切完");
});

test("展示段：流式增量下不重复、不遗漏（cursor 只前进）", () => {
  let state = { cursor: 0, sentCount: 0 };
  const seen: string[] = [];
  const full = "先写一句。再写一句，接着补完这一句。";
  for (let i = 1; i <= full.length; i += 1) {
    const r = splitCommittedDisplaySegments(full.slice(0, i), state, i === full.length);
    state = r.next;
    seen.push(...r.segments.map((s) => s.displayText));
  }
  assert.equal(seen.join(""), full, "增量切段拼起来正好是全文");
});

// 2026-10-14（用户报"声音一顿一顿、必出现"）：`。”` 后面紧跟空行时，`\n` 自己就是切分
// 字符，右引号被顶成孤零零一段。库里近 3 天 53 次合成失败**全部**是这种 1 字符段
// （`”` 39、`"` 8、`）` 6）；qwen 直接拒（`Please ensure input text is valid`，实测 91ms
// 就回来），回落 edge 又赶上容器整条 502，客户端重试三次就是六到十一秒静音。
const SPEAKABLE = /[\p{L}\p{N}]/u;

type DisplaySegment = ReturnType<typeof splitCommittedDisplaySegments>["segments"][number];

/** 按固定批长模拟流式提交，最后一次 isFinal——生产就是这个形状。 */
function collectDisplaySegments(full: string, chunk = 17): {
  readonly segments: DisplaySegment[];
  readonly cursor: number;
} {
  let state = { cursor: 0, sentCount: 0 };
  const segments: DisplaySegment[] = [];
  for (let i = 0; i < full.length; i += chunk) {
    const upto = Math.min(i + chunk, full.length);
    const r = splitCommittedDisplaySegments(full.slice(0, upto), state, upto === full.length);
    state = r.next;
    segments.push(...r.segments);
  }
  return { segments, cursor: state.cursor };
}

test("展示段：引号后面紧跟空行时不切成孤段，且覆盖仍然连续", () => {
  const full = "医生问：“那不按呢？”\n\n第二个：老师问：“谁能用‘果然’造个句子？”小明说：“果然很好吃。”";
  const { segments, cursor } = collectDisplaySegments(full);
  assert.ok(segments.length >= 3, `正常切成多段：${segments.length}`);
  for (const seg of segments) {
    assert.ok(SPEAKABLE.test(seg.displayText), `不可朗读段：${JSON.stringify(seg.displayText)}`);
  }
  let covered = 0;
  for (const seg of segments) {
    assert.equal(
      /^\s*$/u.test(full.slice(covered, seg.displayStart)),
      true,
      `段间缺口只能是被剥掉的首尾空白：${JSON.stringify(full.slice(covered, seg.displayStart))}`,
    );
    covered = seg.displayEnd;
  }
  assert.equal(SPEAKABLE.test(full.slice(covered)), false, "没覆盖到的尾巴读不出任何声音");
  assert.equal(cursor, full.length, "尾巴已跨过，不会再作为第二段追回来");
});

test("展示段：直引号、右括号、右书名号同型——标点并进有字的段", () => {
  for (const punctuation of [`"`, `”`, `）`, `』`, `……`]) {
    const full = `第一句${punctuation}\n\n第二句在这里。`;
    const { segments } = collectDisplaySegments(full, 7);
    assert.ok(segments.length >= 2, `${punctuation} 那条例子仍切出多段`);
    for (const seg of segments) {
      assert.ok(SPEAKABLE.test(seg.displayText), `${punctuation} 不该单独成段：${seg.displayText}`);
    }
  }
});

test("展示段：final 收尾时尾巴上的引号不再发一段", () => {
  const full = "她说：“那你别按。”";
  const r = splitCommittedDisplaySegments(full, { cursor: 0, sentCount: 0 }, true);
  assert.deepEqual(r.segments.map((s) => s.displayText), ["她说：“那你别按。"]);
  assert.equal(r.next.cursor, full.length, "尾巴被跨过，final 之后不再有段");
});

test("展示段：整条正文都没有可读的字 → 零段（不去敲合成服务）", () => {
  const r = splitCommittedDisplaySegments("……\n\n？？", { cursor: 0, sentCount: 0 }, true);
  assert.equal(r.segments.length, 0, "纯标点不发段");
  assert.equal(r.next.cursor, 6, "cursor 仍然前进，不会原地打转");
});
