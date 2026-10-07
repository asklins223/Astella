/**
 * 42 阶段 1 D：拓展草稿读取的位置校验、有界分页与跨页版本一致性。
 *
 * 这里钉的是读侧最容易出错、又最难靠肉眼发现的几件事：
 *   1. **长块能读完**。一个 20000 字的单块必须能一页一页读到最后一个字，尾部不能被某一页
 *      永久截掉；每页都要给出段内位置。
 *   2. **跨页不丢不重不误拼**。照 next 一直读，拿到的是原文的完整序列；换篇时从新的一篇
 *      第一个字开始，不接着上一篇的半句——这一条用**真实返回结果**验证，不复刻分页规则。
 *   3. **位置按实际草稿校验**。越界就报错，不 clamp 回最后一篇/第一段去重读旧内容。
 *   4. **分页期间用户改草稿**。版本令牌对不上就要求从头重读，不把两版正文拼在一起。
 *   5. **每次输出严格有界**，且预算是在**完整结果形状**上算的：元数据全部需要 JSON 转义的
 *      合法极端输入也越不过 maxOutputChars，装不下时明确失败而不是悄悄截掉 next。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { noteExpansionDraftV1Schema, type NoteExpansionDraftV1 } from "@astella/shared/note-expansion-contracts";
import { noteAgentCapabilityManifest } from "@astella/shared/agent-capabilities";
import {
  EXPANSION_READ_MIN_BODY_CHARS, boundExpansionReadPage, expansionDraftBlockText,
  expansionDraftEchoFields, paginateExpansionDraft, resolveExpansionReadPosition,
  type ExpansionReadNext, type ExpansionReadPosition,
} from "../expansion-reading.ts";

const BUDGET = 2200;
const MAX_OUTPUT = 4000;
const VERSION = "2026-10-04T06:00:00.000000Z";
/** JSON 转义最坏的两种合法字符：一个变六个，一个变两个。 */
const CTRL = String.fromCharCode(1);
const BACKSLASH = String.fromCharCode(92);
const QUOTE = String.fromCharCode(34);

function draft(blocks: { type: NoteExpansionDraftV1["blocks"][number]["type"]; content: string }[], overrides: Partial<NoteExpansionDraftV1> = {}): NoteExpansionDraftV1 {
  return noteExpansionDraftV1Schema.parse({
    candidateId: randomUUID(), requestId: randomUUID(),
    title: "光合作用的能量来源",
    relationship: "沿着叶绿体这条线继续追问，能量究竟从哪里来。",
    sourceReferences: [{ blockOrdinal: 1, quote: "叶绿体利用光能制造有机物。" }],
    blocks, selected: false, ...overrides,
  });
}

const START: ExpansionReadPosition = { candidateOrdinal: 1, blockOrdinal: 1, blockOffset: 0 };

/** 一页最小可用的固定字段；真实形状由 readExpansionDrafts 拼，这里只喂给 boundExpansionReadPage。 */
function head(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "succeeded", taskId: randomUUID(), noteId: randomUUID(), noteVersionId: randomUUID(),
    taskState: "ready", draftCount: 1, draftsUpdatedAt: VERSION, artifactRevision: 1, available: true,
    candidateOrdinal: 1, totalCandidates: 1,
    title: "光合作用的能量来源", relationship: "沿着叶绿体这条线继续追问，能量究竟从哪里来。",
    sourceReferences: [{ blockOrdinal: 1, quote: "叶绿体利用光能制造有机物。", quoteTruncated: false }],
    selected: false, confirmed: false, ...overrides,
  };
}

/** 照 next 一直读到读完，返回每页位置与正文；顺带钉住「每页都前进、永不空转」。 */
function readAll(d: NoteExpansionDraftV1, budget: number, limit = 500) {
  const bodies: string[] = [];
  const positions: string[] = [];
  let position = START;
  let pages = 0;
  let next: ExpansionReadPosition | null | undefined;
  const seen = new Set<string>();
  do {
    const page = paginateExpansionDraft(d, position, budget);
    pages += 1;
    assert.ok(page.body.length > 0, `第 ${pages} 页正文为空：预算 ${budget} 时位置必须仍然前进`);
    bodies.push(page.body);
    next = page.nextInCandidate;
    if (!next) break;
    const key = `${next.candidateOrdinal}:${next.blockOrdinal}:${next.blockOffset}`;
    assert.ok(!seen.has(key), `第 ${pages} 页的 next 回到已读位置 ${key}，会死循环`);
    seen.add(key);
    positions.push(key);
    position = next;
    assert.ok(pages < limit, "读完一页就停，没有走完");
  } while (true);
  return { bodies, pages, next };
}

/** 正文里的段首标记去掉，只留模型真正看到的字。 */
function textOf(bodies: string[]) {
  return bodies.map((body) => body.replace(/【草稿 \d+ · 第 \d+ 段 · \w+】\n/g, "")).join("");
}

test("一页装不下整块时留给下一页，不把半句拼进本页", () => {
  const d = draft([
    { type: "paragraph", content: "甲".repeat(30) },
    { type: "paragraph", content: "乙".repeat(4000) },
    { type: "paragraph", content: "丙".repeat(30) },
  ]);
  const page = paginateExpansionDraft(d, START, BUDGET);
  assert.deepEqual(page.body.match(/【草稿 1 · 第 \d+ 段 · paragraph】/g), ["【草稿 1 · 第 1 段 · paragraph】"]);
  assert.match(page.body, /甲+$/);
  assert.doesNotMatch(page.body, /乙/, "第二块装不下就不该在这一页出现半句");
  assert.deepEqual(page.nextInCandidate, { candidateOrdinal: 1, blockOrdinal: 2, blockOffset: 0 });
  assert.equal(page.blockTextTruncated, false, "这一页是整块读完，不是被切的");
  assert.equal(page.endBlockOrdinal, 1);
});

test("19992 字的长块能一页页读完，尾部不会被永久截掉", () => {
  const content = Array.from({ length: 19_990 }, (_, index) => String(index % 10)).join("");
  const d = draft([{ type: "paragraph", content }, { type: "paragraph", content: "尾巴在这里" }]);
  const { bodies, pages } = readAll(d, BUDGET);
  assert.ok(pages >= 10, `19992 字按 2200 的预算至少要 10 页，实际 ${pages}`);
  assert.equal(textOf(bodies), content + "尾巴在这里", "照 next 读完必须正好是原文，一个字不多一个字不少");
});

test("单个 20000 字的块也是一页页读完的，读到结尾时 next 为 null", () => {
  const content = "甲".repeat(20_000);
  const d = draft([{ type: "paragraph", content }]);
  const { bodies, pages, next } = readAll(d, BUDGET);
  assert.equal(next, null, "最后一页的 next 必须是 null，这时才可以说这一批读完");
  assert.equal(textOf(bodies), content);
  assert.equal(pages, Math.ceil(20_000 / (BUDGET - 25)), "页数只由预算与段内位置决定");
});

test("段内位置是必需的：没有它长块的尾部永远读不到", () => {
  const content = "甲".repeat(20_000);
  const d = draft([{ type: "paragraph", content }]);
  const first = paginateExpansionDraft(d, START, BUDGET);
  assert.equal(first.blockTextTruncated, true);
  assert.ok(first.nextInCandidate && first.nextInCandidate.blockOffset > 0,
    "被切开的块必须交出段内位置，否则下一页只会从头再来");
  const second = paginateExpansionDraft(d, first.nextInCandidate!, BUDGET);
  assert.equal(second.startBlockOffset, first.nextInCandidate!.blockOffset);
  assert.ok(content.startsWith(textOf([first.body, second.body])),
    "第二页要接着第一页的切点继续，不能从这一段的开头重读一遍");
});

test("预算小到装不下前缀时也至少读一个字，位置永远前进", () => {
  const d = draft([{ type: "paragraph", content: "甲".repeat(4000) }]);
  for (const budget of [1, 5, EXPANSION_READ_MIN_BODY_CHARS]) {
    const page = paginateExpansionDraft(d, START, budget);
    assert.ok(page.body.length > 0, `预算 ${budget} 时正文不能为空，否则模型会卡在同一页`);
    assert.ok(page.nextInCandidate, `预算 ${budget} 时必须给出下一段位置`);
    assert.ok(page.nextInCandidate!.blockOffset > 0 || page.nextInCandidate!.blockOrdinal > 1,
      `预算 ${budget} 时位置必须真的前进了：${JSON.stringify(page.nextInCandidate)}`);
  }
});

test("渲染走现役块合同：语法标记不进入可见文本，代码块保持原样", () => {
  const d = draft([
    { type: "heading", content: "## 能量从哪来" },
    { type: "paragraph", content: "有 **粗体** 和 [链接](https://a.test)" },
    { type: "code", content: "第一行\n**第二行**" },
    { type: "quote", content: "> 引用一句话" },
    { type: "list", content: "- 甲\n- 乙" },
  ]);
  const body = paginateExpansionDraft(d, START, BUDGET).body;
  assert.match(body, /第 1 段 · heading】\n能量从哪来/);
  assert.match(body, /第 2 段 · paragraph】\n有 粗体 和 链接/);
  assert.match(body, /第一行\n\*\*第二行\*\*/, "代码块里的 ** 是内容，不能被当成标记吃掉");
  assert.match(body, /第 4 段 · quote】\n引用一句话/);
  assert.match(body, /第 5 段 · list】\n甲乙/, "列表标记与换行不占 DOM 文本坐标，与笔记正文读取同一口径");
  assert.equal(expansionDraftBlockText({ type: "paragraph", content: "---" }), "", "分隔线渲染成空，段序号仍然保留");
  const { bodies } = readAll(d, 1);   // 极端预算下走完全篇仍不丢字
  assert.equal(textOf(bodies).replace(/\s+/g, ""),
    d.blocks.map((b) => expansionDraftBlockText(b)).join("").replace(/\s+/g, ""));
});

test("位置按实际草稿校验：越界就报无效，不 clamp 回最后一篇/第一段", () => {
  const only = draft([{ type: "paragraph", content: "甲".repeat(10) }]);
  const two = [only, draft([{ type: "paragraph", content: "乙".repeat(10) }])];
  for (const [drafts, request, reason] of [
    [two, { candidateOrdinal: 3, blockOrdinal: 1, blockOffset: 0 }, "candidate_out_of_range"],
    [two, { candidateOrdinal: 0, blockOrdinal: 1, blockOffset: 0 }, "candidate_out_of_range"],
    [two, { candidateOrdinal: 1, blockOrdinal: 2, blockOffset: 0 }, "block_out_of_range"],
    [[only], { candidateOrdinal: 1, blockOrdinal: 1, blockOffset: 10 }, "block_offset_out_of_range"],
    [[only], { candidateOrdinal: 1, blockOrdinal: 1, blockOffset: 20_000 }, "block_offset_out_of_range"],
  ] as const) {
    const resolved = resolveExpansionReadPosition(drafts as NoteExpansionDraftV1[], request, undefined, VERSION);
    assert.equal(resolved.ok, false, JSON.stringify(request));
    assert.equal(resolved.ok === false && resolved.rejection.reason, reason, JSON.stringify(request));
    assert.ok(resolved.ok === false && resolved.rejection.detail.length > 0, "要说得清为什么这个位置不成立");
  }
  // clamp 会让模型把已经读过一遍的内容再读一次，看上去「读到了」，其实在原地打转。
  const ok = resolveExpansionReadPosition(two as NoteExpansionDraftV1[], { candidateOrdinal: 2, blockOrdinal: 1, blockOffset: 0 },
    VERSION, VERSION);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok === true && ok.position.candidateOrdinal, 2);
});

test("分页期间草稿被改过：版本令牌对不上就要求从头重读", () => {
  const drafts = [draft([{ type: "paragraph", content: "甲".repeat(50) }])];
  const stale = resolveExpansionReadPosition(drafts, { candidateOrdinal: 1, blockOrdinal: 1, blockOffset: 10 },
    "2026-10-04T06:00:00.000001Z", VERSION);
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false && stale.rejection.reason, "drafts_changed");
  assert.match(stale.ok === false ? stale.rejection.detail : "", /重新读/, "要说清是重来，不是继续");

  // 续读必须带令牌，否则两版正文会被拼成一篇。
  const missing = resolveExpansionReadPosition(drafts, { candidateOrdinal: 1, blockOrdinal: 1, blockOffset: 10 }, undefined, VERSION);
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.rejection.reason, "drafts_version_required");

  // 第一页可以不带令牌：用户刚改过草稿时，初页读到的是最新那一版。
  const fresh = resolveExpansionReadPosition(drafts, START, undefined, VERSION);
  assert.equal(fresh.ok, true);
  // 令牌对得上才允许续读。
  assert.equal(resolveExpansionReadPosition(drafts, { candidateOrdinal: 1, blockOrdinal: 1, blockOffset: 10 }, VERSION, VERSION).ok, true);
});

test("跨篇接续用真实返回结果验证：next 带上位置与版本令牌", () => {
  const first = draft([{ type: "paragraph", content: "甲".repeat(30) }]);
  const second = draft([{ type: "paragraph", content: "乙".repeat(30) }]);
  const bounded = boundExpansionReadPage(
    head({ draftCount: 2, totalCandidates: 2, candidateOrdinal: 1 }), first, 2, 1, VERSION, START, MAX_OUTPUT);
  assert.ok(bounded);
  assert.deepEqual(bounded.fields.next,
    { startCandidateOrdinal: 2, startBlockOrdinal: 1, startBlockOffset: 0, draftsUpdatedAt: VERSION },
    "本篇读完要把 next 接到下一篇的第一个字，并带上版本令牌；字段名与工具参数同名");

  // 照这个 next 继续读：第二篇只应有第二篇的字，序号换到新的一篇。
  const resolved = resolveExpansionReadPosition([first, second],
    { candidateOrdinal: 2, blockOrdinal: 1, blockOffset: 0 }, bounded.fields.next.draftsUpdatedAt, VERSION);
  assert.equal(resolved.ok, true);
  const secondPage = boundExpansionReadPage(
    head({ draftCount: 2, totalCandidates: 2, candidateOrdinal: 2 }), second, 2, 2, VERSION,
    resolved.ok === true ? resolved.position : START, MAX_OUTPUT);
  assert.ok(secondPage);
  assert.ok(secondPage.body.includes("乙") && !secondPage.body.includes("甲"), "第二篇只应有第二篇的字");
  assert.match(secondPage.body, /^【草稿 2 · 第 1 段 · paragraph】/, "序号要换到新的一篇");
  assert.equal(secondPage.fields.next, null, "最后一篇读完 next 才是 null");
});

test("每次输出严格有界：元数据全部需要 JSON 转义的合法极端输入也越不过上限", () => {
  // 领域合同允许的极端：标题 200 字、关系说明 600 字、6 条引用各 500 字，
  // 而它们每一个字符都要 JSON 转义（控制字符一个变六个，反斜杠变两个）。
  const extreme = noteExpansionDraftV1Schema.parse({
    candidateId: randomUUID(), requestId: randomUUID(),
    title: CTRL.repeat(200),
    relationship: BACKSLASH.repeat(600),
    sourceReferences: Array.from({ length: 6 }, (_, index) => ({ blockOrdinal: index + 1, quote: CTRL.repeat(500) })),
    blocks: [{ type: "paragraph", content: CTRL.repeat(5000) }], selected: false,
  });
  // 元数据用生产侧同一段截断，不复刻一份；这里断言的正是真实返回形状的上界。
  const worstHead = head({
    ...expansionDraftEchoFields(extreme, { candidateOrdinal: 2, totalCandidates: 4, confirmed: false }),
    draftCount: 4,
  });
  for (const content of [CTRL.repeat(5000), "甲".repeat(20_000), `${QUOTE}${BACKSLASH}\n`.repeat(4000)]) {
    const one = noteExpansionDraftV1Schema.parse({ ...extreme, blocks: [{ type: "paragraph", content }] });
    let position: ExpansionReadPosition = { candidateOrdinal: 2, blockOrdinal: 1, blockOffset: 0 };
    let next: ExpansionReadNext = {
      startCandidateOrdinal: 2, startBlockOrdinal: 1, startBlockOffset: 0, draftsUpdatedAt: VERSION,
    };
    let pages = 0;
    // 第 2 篇读完就会把 next 交给第 3 篇——换一篇是另一次读取的范围，这里停在换篇之前。
    while (next.startCandidateOrdinal === 2 && pages < 400) {
      const bounded = boundExpansionReadPage(worstHead, one, 4, 2, VERSION, position, MAX_OUTPUT);
      assert.ok(bounded, "合法极端输入也必须装得下；装不下就该明确失败，而不是悄悄截掉 next");
      const serialized = JSON.stringify({ ...worstHead, ...bounded.fields, available: true, body: bounded.body });
      assert.ok(serialized.length <= MAX_OUTPUT, `第 ${pages + 1} 页序列化 ${serialized.length} 字，越过了上限`);
      assert.ok(bounded.body.length > 0, "任何一页都至少读到一个字，不能空转");
      pages += 1;
      const following = bounded.fields.next as ExpansionReadNext | null;
      if (!following || following.startCandidateOrdinal !== 2) { next = following ?? next; break; }
      assert.ok(following.startBlockOffset > 0 || following.startBlockOrdinal > 1, "位置必须每页前进");
      position = { candidateOrdinal: 2, blockOrdinal: following.startBlockOrdinal, blockOffset: following.startBlockOffset };
      next = following;
    }
    assert.ok(pages > 1, `第 2 篇应当分成多页读，实际 ${pages} 页`);
    assert.deepEqual(next, { startCandidateOrdinal: 3, startBlockOrdinal: 1, startBlockOffset: 0, draftsUpdatedAt: VERSION });
  }
});

test("装不下最低有效结果时明确失败，不返回一页读不出东西的正文", () => {
  const d = draft([{ type: "paragraph", content: "甲".repeat(5000) }]);
  // 上限小于元数据加最低正文：返回 null，让调用方报错，而不是越界输出或悄悄丢掉 next。
  assert.equal(boundExpansionReadPage(head(), d, 1, 1, VERSION, START, 120), null);
  // 上限够最低正文时就能读，且正文非空、next 前进。
  const ok = boundExpansionReadPage(head(), d, 1, 1, VERSION, START, EXPANSION_READ_MIN_BODY_CHARS + 1_000);
  assert.ok(ok);
  assert.ok((ok.body as string).length > 0);
});

test("续读长段的尾页：take 扣掉已消费的 offset，正文、bodyChars 与结束位置都对得上", () => {
  // 一段 10 个字，从第 9 个字（第 10 个字）续读，而预算大到能装下整段。
  // 按整段长度算 take 会读到 10 个字、结束位置算到 19 —— 正文里其实只有 1 个字。
  const d = draft([{ type: "paragraph", content: "甲乙丙丁戊己庚辛壬癸" }]);
  const page = paginateExpansionDraft(d, { candidateOrdinal: 1, blockOrdinal: 1, blockOffset: 9 }, BUDGET);
  assert.match(page.body, /【草稿 1 · 第 1 段 · paragraph】\n癸$/, "正文里只剩最后一个字");
  assert.equal(page.bodyChars, 1, "bodyChars 必须是这一页真正读到的字数，不是整段长度");
  assert.equal(page.endBlockOffset, 10, "结束位置落在段尾，不能越过 10");
  assert.equal(page.blockTextTruncated, false);
  assert.equal(page.blocksInPage, 1);
  assert.equal(page.nextInCandidate, null, "这一段读完就是读完，不能再翻一次同一段");

  // 再往前一格：还有 3 个字没读。
  const threeLeftDraft = d;
  const threeLeft = paginateExpansionDraft(threeLeftDraft, { candidateOrdinal: 1, blockOrdinal: 1, blockOffset: 7 }, BUDGET);
  assert.match(threeLeft.body, /辛壬癸$/);
  assert.equal(threeLeft.bodyChars, 3);
  assert.equal(threeLeft.endBlockOffset, 10);
  const threeLeftFields = boundExpansionReadPage(head(), threeLeftDraft, 1, 1, VERSION,
    { candidateOrdinal: 1, blockOrdinal: 1, blockOffset: 7 }, MAX_OUTPUT);
  assert.equal(threeLeftFields?.fields.remainingChars, 0, "本篇读完就是没有剩余");

  // 尾页之后要能接上下一段 / 下一篇，且不重复、不丢字。
  const joined = paginateExpansionDraft(
    draft([{ type: "paragraph", content: "甲".repeat(4000) }, { type: "paragraph", content: "乙".repeat(5) }]),
    { candidateOrdinal: 1, blockOrdinal: 1, blockOffset: 3995 }, BUDGET);
  assert.equal(joined.bodyChars, 10, "5 个续读字 + 5 个下一段字");
  assert.equal(joined.endBlockOrdinal, 2);
  assert.equal(joined.endBlockOffset, 5);
});

test("生产 next 与工具参数同名：直接进 strict schema，再照它续读", () => {
  const entry = noteAgentCapabilityManifest.find((item) => item.definition.name === "note_expansion_read");
  assert.ok(entry);
  type NextArgs = { startCandidateOrdinal: number; startBlockOrdinal: number; startBlockOffset: number; draftsUpdatedAt: string };
  // 直接用清单里那一份真实校验器，不在测试里复制 schema。
  const parse = (value: Record<string, unknown>) => {
    const result = entry.argumentSchema.safeParse(value);
    return result.success
      ? { ok: true as const, args: result.data as NextArgs }
      : { ok: false as const, issues: result.error.issues.map((issue) => `${issue.path.join(".")}:${issue.code}`).join(", ") };
  };
  const noteId = randomUUID(), noteVersionId = randomUUID(), taskId = randomUUID();
  const long = draft([{ type: "paragraph", content: "甲".repeat(6000) }, { type: "paragraph", content: "乙".repeat(40) }]);
  const fields = head({ draftCount: 1, candidateOrdinal: 1 });
  const strip = (body: string) => body.replace(/【草稿 \d+ · 第 \d+ 段 · \w+】\n/g, "");

  // 每一次续读都把上一次的 next 与同一份 task/note/version 合并，原样过真实 schema。
  let merged: Record<string, unknown> = { noteId, noteVersionId, taskId };
  const bodies: string[] = [];
  let pages = 0;
  for (;;) {
    const parsed = parse(merged);
    assert.equal(parsed.ok, true, `next 必须能直接当参数用：${parsed.ok ? "" : parsed.issues}`);
    assert.ok(parsed.ok);
    assert.deepEqual({ ...merged, ...parsed.args }, merged, "过 schema 之后参数必须逐字不变");
    const args = parsed.args;
    // 第一次还没有 next，位置缺省即第一篇第一段第一个字 —— 与能力层的默认值一致。
    const resolved = resolveExpansionReadPosition([long], {
      candidateOrdinal: args.startCandidateOrdinal ?? 1,
      blockOrdinal: args.startBlockOrdinal ?? 1,
      blockOffset: args.startBlockOffset ?? 0,
    }, args.draftsUpdatedAt, VERSION);
    assert.equal(resolved.ok, true, "生产 next 给出的位置必须能被内部校验接受");
    const page = boundExpansionReadPage(fields, long, 1, 1, VERSION, resolved.ok === true ? resolved.position : START, MAX_OUTPUT);
    assert.ok(page, "每一页都要装得下");
    bodies.push(strip(page.body));
    assert.ok(JSON.stringify({ ...fields, ...page.fields, available: true, body: page.body }).length <= MAX_OUTPUT,
      "每一页都仍受输出上限约束");
    pages += 1;
    assert.ok(pages < 50, "读完一页就停，没有走完");
    if (!page.fields.next) break;
    merged = { ...merged, ...(page.fields.next as ExpansionReadNext) };
  }
  assert.ok(pages > 1, "长草稿应当分成多页读");
  assert.equal(bodies.join(""), long.blocks.map((block) => expansionDraftBlockText(block)).join(""),
    "照 next 读完必须正好是那一篇草稿的正文");
});

// ─── 合法空渲染段（分隔线、保存下来的空段）──────────────────────────────────────
//
// `noteBlockRenderedTextV1("paragraph", "---")` 返回空串，草稿合同也允许用户存空段。
// 上一版在这里栽了两跤：位置校验把空段合法的 offset 0 一起拒掉（初页与生产 next 都被卡死），
// 分页又靠「至少读一个字」保证前进，给空段报出 bodyChars=1 / endBlockOffset=1。

/** 生产往返：取真实 next → 过真实 strict schema → 内部位置 → 继续读，直到 next=null。 */
function productionRoundTrip(drafts: NoteExpansionDraftV1[], label: string) {
  const entry = noteAgentCapabilityManifest.find((item) => item.definition.name === "note_expansion_read");
  assert.ok(entry);
  type Args = { startCandidateOrdinal: number; startBlockOrdinal: number; startBlockOffset: number; draftsUpdatedAt: string };
  const taskId = randomUUID(), noteId = randomUUID(), noteVersionId = randomUUID();
  const bodies: string[] = [];
  let merged: Record<string, unknown> = { taskId, noteId, noteVersionId };
  let pages = 0;
  const progress: string[] = [];
  for (;;) {
    const parsed = entry.argumentSchema.safeParse(merged);
    assert.equal(parsed.success, true, `${label}：next 必须能直接当参数用`);
    assert.ok(parsed.success);
    const args = parsed.data as Args;
    const resolved = resolveExpansionReadPosition(drafts, {
      candidateOrdinal: args.startCandidateOrdinal ?? 1,
      blockOrdinal: args.startBlockOrdinal ?? 1,
      blockOffset: args.startBlockOffset ?? 0,
    }, args.draftsUpdatedAt, VERSION);
    assert.equal(resolved.ok, true, `${label}：生产 next 给出的位置必须被内部校验接受`);
    assert.ok(resolved.ok);
    const fields = head({ draftCount: drafts.length, totalCandidates: drafts.length, candidateOrdinal: resolved.position.candidateOrdinal });
    const page = boundExpansionReadPage(fields, drafts[resolved.position.candidateOrdinal - 1]!, drafts.length,
      resolved.position.candidateOrdinal, VERSION, resolved.position, MAX_OUTPUT);
    assert.ok(page, `${label}：每一页都要装得下`);
    bodies.push(page.body.replace(/【草稿 \d+ · 第 \d+ 段 · \w+】\n/g, ""));
    const serialized = JSON.stringify({ ...fields, ...page.fields, available: true, body: page.body });
    assert.ok(serialized.length <= MAX_OUTPUT, `${label}：第 ${pages + 1} 页 ${serialized.length} 字，越过上限`);
    pages += 1;
    assert.ok(pages < 200, `${label}：没有走到 next=null`);
    if (!page.fields.next) break;
    const next = page.fields.next as ExpansionReadNext;
    const key = `${next.startCandidateOrdinal}:${next.startBlockOrdinal}:${next.startBlockOffset}`;
    assert.ok(!progress.includes(key), `${label}：next 回到 ${key}，会原地打转`);
    progress.push(key);
    merged = { ...merged, ...next };
  }
  const expected = drafts.map((draft) => draft.blocks.map((block) => expansionDraftBlockText(block)).join("")).join("");
  assert.equal(bodies.join(""), expected, `${label}：逐字读完必须与原渲染相同`);
  return pages;
}

test("第一段渲染为空：初页读得出来，生产 next 也能续读到底", () => {
  // 空段在前、后面接正文；正文长度足够大，必须分多页才能证明 next 真的在走。
  const drafts = [noteExpansionDraftV1Schema.parse({
    candidateId: randomUUID(), requestId: randomUUID(), title: "标题在这里", relationship: "关系说明在这里一段。",
    sourceReferences: [{ blockOrdinal: 1, quote: "叶绿体利用光能制造有机物。" }],
    blocks: [{ type: "paragraph", content: "---" }, { type: "paragraph", content: "甲".repeat(6000) },
      { type: "paragraph", content: "乙".repeat(40) }],
    selected: false,
  })];
  assert.ok(productionRoundTrip(drafts, "第一段为空") > 1, "正文很长，必须分页才说明 next 有效");
});

test("空段在正中间与在尾部：段号标记保留，正文计数与结束位置准确为 0", () => {
  const first = draft([{ type: "paragraph", content: "甲".repeat(30) }, { type: "paragraph", content: "---" },
    { type: "paragraph", content: "乙".repeat(30) }]);
  const page = paginateExpansionDraft(first, START, BUDGET);
  // 三个段号都在，顺序不变。
  assert.deepEqual(page.body.match(/【草稿 1 · 第 \d+ 段 · paragraph】/g),
    ["【草稿 1 · 第 1 段 · paragraph】", "【草稿 1 · 第 2 段 · paragraph】", "【草稿 1 · 第 3 段 · paragraph】"]);
  assert.equal(page.bodyChars, 60, "空段不计入正文：30 + 30");
  assert.equal(page.endBlockOrdinal, 3);
  assert.equal(page.endBlockOffset, 30, "结束位置落在第三段读完的地方，不是空段的 0，也不是越界的数");
  assert.equal(page.nextInCandidate, null, "读完就是读完，不能停在原地");
  assert.equal(page.body.replace(/【草稿 \d+ · 第 \d+ 段 · \w+】\n/g, ""), "甲".repeat(30) + "乙".repeat(30),
    "逐字正文里不该混进空段，也不该丢字");

  // 整篇都渲染成空：标记全在，正文 0 字，读完即完成。
  // 注意合同只禁止空 content（min 1），「有内容但渲染为空」是合法输入 —— 分隔线就是。
  const blank = draft([{ type: "paragraph", content: "---" }, { type: "paragraph", content: "***" }]);
  const blankPage = paginateExpansionDraft(blank, START, BUDGET);
  assert.equal(blankPage.bodyChars, 0, "一段正文都没读到，就不能报字符");
  assert.equal(blankPage.nextInCandidate, null);
  assert.ok(blankPage.body.length > 0, "标记仍然在，模型看得见这里有两段");
  assert.equal(productionRoundTrip([blank], "整篇为空"), 1);
});

test("空段的位置：offset 0 合法，其他 offset 明确拒绝", () => {
  const drafts = [draft([{ type: "paragraph", content: "---" }, { type: "paragraph", content: "甲".repeat(10) }])];
  const ok = resolveExpansionReadPosition(drafts, { candidateOrdinal: 1, blockOrdinal: 1, blockOffset: 0 }, undefined, VERSION);
  assert.equal(ok.ok, true, "第一段为空时 offset 0 必须合法，否则初页都读不出来");
  for (const offset of [1, 5, -1]) {
    const bad = resolveExpansionReadPosition(drafts, { candidateOrdinal: 1, blockOrdinal: 1, blockOffset: offset }, VERSION, VERSION);
    assert.equal(bad.ok, false, `空段的 offset ${offset} 必须被拒`);
    assert.equal(bad.ok === false && bad.rejection.reason, "block_offset_out_of_range");
  }
  // 非空段的合法区间没有因此放宽。
  const good = resolveExpansionReadPosition(drafts, { candidateOrdinal: 1, blockOrdinal: 2, blockOffset: 9 }, VERSION, VERSION);
  assert.equal(good.ok, true);
  const past = resolveExpansionReadPosition(drafts, { candidateOrdinal: 1, blockOrdinal: 2, blockOffset: 10 }, VERSION, VERSION);
  assert.equal(past.ok === false && past.rejection.reason, "block_offset_out_of_range");
});

test("整篇空、下一篇有正文：跨篇接续照常，且空篇不会把 next 卡住", () => {
  const blank = draft([{ type: "paragraph", content: "---" }, { type: "paragraph", content: "***" }]);
  const filled = draft([{ type: "paragraph", content: "丙".repeat(30) }]);
  assert.ok(productionRoundTrip([blank, filled], "空篇接有正文篇") > 1);
  // 直接核对跨篇接续用的是生产 pageFields：空篇读完时 next 接到下一篇第一个字。
  const blankFields = boundExpansionReadPage(head({ draftCount: 2, totalCandidates: 2, candidateOrdinal: 1 }),
    blank, 2, 1, VERSION, START, MAX_OUTPUT);
  assert.deepEqual(blankFields?.fields.next,
    { startCandidateOrdinal: 2, startBlockOrdinal: 1, startBlockOffset: 0, draftsUpdatedAt: VERSION });
  assert.equal(blankFields?.fields.bodyChars, 0);
});
