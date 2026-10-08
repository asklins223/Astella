import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPANION_VOICE_STYLE_LINES_V2 } from "@astella/shared";
import { buildDiaryCandidates } from "../companion-diary-candidates.ts";
import { buildDiaryRevisionPrompt, diaryRevisionDraft } from "../companion-diary-revision.ts";
import {
  buildDiaryPrompt, diaryLengthShortfall, diaryWritingSize, focusDiaryMaterial,
  pickDiarySubject, renderMaterial, resolveDiaryBlocks,
  type DiaryEmbed, type DiaryMaterial, type DiaryPersona, type DiaryPiece,
} from "../companion-diary-content.ts";

const persona: DiaryPersona = {
  name: "爱吃白饭的大肥鱼", personalityTags: ["慵懒", "贪吃"],
  speakingStyle: "说话慢悠悠，偶尔开个玩笑。", examples: [],
  activeness: "active", boundaries: null, revision: 1,
};

function exchange(lines: string[], conversationId = "tea"): DiaryPiece[] {
  return lines.map((text, index) => ({
    text: `${index % 2 ? "我" : "你"}说：${text}`,
    group: index % 2 ? "her" : "his", weight: index % 2 ? 3 : 1,
    at: `11:${String(40 + index).padStart(2, "0")}`,
    sourceId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    sourceType: "companion_message", conversationId,
  }));
}

function material(pieces: DiaryPiece[]): DiaryMaterial {
  return { pieces, subject: pickDiarySubject(pieces), embeds: [], previousOpenings: [], previousMotifs: [], quietDay: false };
}

// The Oct 5 tea draft claimed she never asked the question, then gave her the
// user's cup. The real exchange contains the question and its answer.
const tea = exchange([
  "茶泡好了，今天想慢慢歇一会儿。",
  "那就歇着，欧姆定律的草稿还在手记里等你挑。我陪你摸会儿鱼。泡的什么茶？",
  "是普洱，闻着挺舒服。今天风也很轻。",
  "普洱配轻风，这配置可以。你慢慢坐，我不催你。",
]);

test("the chosen scene keeps the question, answer and ending in source order", () => {
  const chosen = buildDiaryCandidates(material(tea))[0];
  const focused = focusDiaryMaterial(chosen.material);
  assert.deepEqual(focused.pieces, tea);
  const prompt = buildDiaryPrompt({ date: "2026-10-05", persona, material: focused, rejection: null });
  const source = prompt[1].content;
  let previous = -1;
  for (const piece of tea) {
    const offset = source.indexOf(piece.text.slice(3));
    assert.ok(offset > previous, `lost or reordered: ${piece.text}`);
    previous = offset;
  }
  assert.deepEqual(chosen.sourceIds, tea.map((piece) => piece.sourceId));
});

test("the nickname scene keeps acceptance after the initial objection", () => {
  const pieces = exchange(["小猪", "物种不能乱认。", "你就是小猪", "行吧，你说小猪就小猪，名字是你起的。"]);
  const source = renderMaterial(focusDiaryMaterial(buildDiaryCandidates(material(pieces))[0].material));
  assert.ok(source.indexOf("物种不能乱认") < source.indexOf("行吧"));
  assert.ok(source.includes('"actor":"用户"'));
  assert.ok(source.includes('"content":"你就是小猪"'));
});

test("overlapping conversations remain different diary candidates", () => {
  const other = exchange(["今天不聊茶，看看排序。", "那从稳定性看起。"], "sorting")
    .map((piece, index) => ({ ...piece, sourceId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` }));
  const candidates = buildDiaryCandidates(material([...tea, ...other]));
  assert.equal(candidates.length, 2);
  for (const candidate of candidates) {
    assert.equal(new Set(candidate.material.pieces.map((piece) => piece.conversationId)).size, 1);
  }
});

test("a nearby note edit joins the whole exchange in time order, including later correction", () => {
  const pieces = exchange(["这篇初稿还有问题。", "我再核对一遍。", "结尾没改，先别提交。", "确认只保存，不提交。"]);
  pieces[0].noteId = "draft";
  const note: DiaryPiece = {
    text: "你改了笔记「初稿」", group: "his", weight: 1, at: "11:41",
    noteId: "draft", sourceId: "20000000-0000-4000-8000-000000000001", sourceType: "note",
  };
  const candidates = buildDiaryCandidates(material([note, ...pieces]));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].material.pieces.length, 5);
  const text = renderMaterial(candidates[0].material);
  assert.ok(text.indexOf("这篇初稿还有问题") < text.indexOf("你改了笔记"));
  assert.ok(text.includes("确认只保存，不提交"));
});

test("a long exchange retains its late correction, with exact represented provenance", () => {
  const pieces = exchange(Array.from({ length: 20 }, (_, index) => index === 19
    ? "最后更正：没有提交，只保存了初稿。" : `核对报告内容和来由，这是第 ${index} 个往返。`));
  const candidate = buildDiaryCandidates(material(pieces))[0];
  assert.ok(renderMaterial(focusDiaryMaterial(candidate.material)).includes("最后更正：没有提交"));
  assert.ok(candidate.sourceIds.length <= 16);
  assert.deepEqual(candidate.sourceIds, candidate.material.pieces.map((piece) => piece.sourceId).sort());
});

test("a source over the soft budget remains whole, including its final qualification", () => {
  const pieces = exchange(["请核对这份初稿。", "原文核对。".repeat(2_500) + "最后更正：并未提交。"]);
  const candidate = buildDiaryCandidates(material(pieces))[0];
  assert.ok(renderMaterial(candidate.material).includes("最后更正：并未提交。"));
});

test("related note embeds follow the entire chosen exchange, not just its first reply", () => {
  const pieces = tea.map((piece, index) => index === 3 ? { ...piece, noteId: "ohm" } : piece);
  const input = material(pieces);
  input.embeds = [
    { ref: "引1", kind: "quote", label: "欧姆定律", text: "电压与电流成正比。", noteId: "ohm" },
    { ref: "引2", kind: "quote", label: "无关", text: "这不是当前话题。", noteId: "other" },
  ];
  assert.deepEqual(focusDiaryMaterial(input).embeds.map((embed) => embed.ref), ["引1"]);
});

test("diary length follows material density and is independent of chat activeness", () => {
  const rich = material(exchange(["核对经过。".repeat(50), "最后有一处更正。"]));
  assert.equal(diaryWritingSize(rich).minChars, 280);
  const prompts = ["quiet", "moderate", "active"].map((activeness) => buildDiaryPrompt({
    date: "2026-10-05", persona: { ...persona, activeness: activeness as DiaryPersona["activeness"] },
    material: rich, rejection: null,
  })[0].content);
  assert.equal(new Set(prompts).size, 1);
  assert.ok(diaryLengthShortfall([{ type: "text", text: "今天核对了这件事，感觉很踏实。" }], rich));
  assert.equal(diaryLengthShortfall([
    { type: "text", text: "甲".repeat(140) }, { type: "text", text: "乙".repeat(140) },
  ], rich), null);
  assert.ok(diaryLengthShortfall([{ type: "text", text: "甲".repeat(300) }], rich), "a rich diary needs natural paragraphs");
  assert.equal(diaryWritingSize(material(tea)).minChars, 120, "sparse real exchanges can be shorter");
});

test("private prose keeps shared voice without inventing hidden past psychology or a listener", () => {
  const prompt = buildDiaryPrompt({ date: "2026-10-05", persona, material: material(tea), rejection: "正文太短" });
  assert.ok(prompt[0].content.includes(COMPANION_VOICE_STYLE_LINES_V2));
  assert.match(prompt[0].content, /用第一人称写给自己/);
  assert.match(prompt[0].content, /不能假称还原了当时未记下的秘密心理/);
  assert.match(prompt[0].content, /上一稿需要修正：正文太短/);
  assert.doesNotMatch(prompt[0].content, /全文最多|全程用「你」|心里怎么绕的|必须写出来/);
  assert.doesNotMatch(prompt[0].content, /workspace、job、run|不出现计数/);
  assert.doesNotMatch(prompt[0].content, /<day_material>/, "untrusted source is separate from system instructions");
});

test("longer natural paragraphs and their ending survive block resolution", () => {
  const draft = { blocks: Array.from({ length: 7 }, (_, index) => ({
    type: "text" as const, text: index === 6 ? "最后那个更正也留下了。" : `第 ${index} 段。`,
  })) };
  assert.deepEqual(resolveDiaryBlocks(draft, []).blocks, draft.blocks);
});

test("revision receives the original actors separately from the untrusted draft", () => {
  const m = material(tea);
  const draft = { blocks: [{ type: "text" as const, text: "我没有问什么茶，还捧起了那杯普洱。" }], digest: "原始事实备忘" };
  const prompt = buildDiaryRevisionPrompt({ draft, material: m });
  const source = JSON.parse(prompt[1].content);
  const actors = source.original_material.split("\n").map(JSON.parse).map((piece: { actor: string }) => piece.actor);
  assert.deepEqual(actors, ["用户", "伴星（日记作者）", "用户", "伴星（日记作者）"]);
  assert.deepEqual(source.draft.blocks, draft.blocks);
  assert.ok(source.original_material.includes("泡的什么茶"));
  assert.ok(!source.original_material.includes(draft.blocks[0].text), "the prose must not become a source event");
});

test("revision restores embed refs without sending storage URLs or duplicating caption titles", () => {
  const m = material(tea);
  const image: Extract<DiaryEmbed, { kind: "image" }> = {
    kind: "image", ref: "图1", noteId: "note", noteTitle: "原稿", nth: 1,
    url: "https://private.example.invalid/signed-asset", nearby: null, shape: "横向的",
    objectKey: "private/object", mimeType: "image/png", byteSize: 100, description: null,
  };
  const quote: Extract<DiaryEmbed, { kind: "quote" }> = { kind: "quote", ref: "引1", noteId: "note", label: "原稿摘录", text: "初稿尚未提交，这一句限定应该保留。" };
  m.embeds = [image, quote];
  const draft = { blocks: [
    { type: "text" as const, text: "这件事还没做完。" },
    { type: "image" as const, url: image.url, label: "留下的草稿（《原稿》）" },
    { type: "quote" as const, label: "原稿摘录", text: quote.text },
  ], digest: "" };
  const refs = diaryRevisionDraft(draft, m);
  assert.deepEqual(refs.blocks.slice(1), [{ type: "image", ref: "图1", caption: "留下的草稿" }, { type: "quote", ref: "引1" }]);
  const prompt = JSON.stringify(buildDiaryRevisionPrompt({ draft, material: m }));
  assert.ok(!prompt.includes("signed-asset"));
  assert.ok(!prompt.includes("private/object"));
  assert.deepEqual(resolveDiaryBlocks(refs, m.embeds).blocks, draft.blocks);
});
