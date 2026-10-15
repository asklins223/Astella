import { test } from "node:test";
import assert from "node:assert/strict";
import type { MindMapContentV1 } from "@astella/shared/note-mind-map-contracts";
import { parseMindMap, reconcileMergedMindMap } from "../note-mind-map-output.ts";
import { buildChunks, exactQuote, imageSafeText } from "../note-mind-map-source.ts";
const map: MindMapContentV1 = { schemaVersion:1,rootId:"root",nodes:[
  {id:"root",parentId:null,kind:"root",label:"功率",explanation:null,references:[]},
  {id:"c0_a",parentId:"root",kind:"concept",label:"固定电压",explanation:"保持电压不变才能使用这个比较。",references:[{blockOrdinal:1,quote:"固定电压"}]}] };
test("evidence is normalized back to source; invented or image evidence is rejected", () => {
  assert.equal(exactQuote("**固定电压**，P=U²/R", "固定 电压"), "固定电压");
  assert.equal(exactQuote("😀电阻", "😀"), "😀");
  assert.equal(parseMindMap(JSON.stringify(map),[{ordinal:1,type:"text",content:"固定电压"}]).nodes[1]!.references[0]!.quote,"固定电压");
  for (const content of ["不存在该引用", "![固定电压](image.png)", '<img alt="固定电压" src="image.png">']) assert.throws(()=>parseMindMap(JSON.stringify(map),[{ordinal:1,type:"text",content}]));
  assert.throws(()=>parseMindMap(JSON.stringify(map),[{ordinal:1,type:"image",content:"固定电压"}]));
});
test("chunks cover Unicode source without truncation, retain ordinal and omit image text", () => {
  const text="电😀阻".repeat(7000); const chunks=buildChunks([{ordinal:4,type:"text",content:text}],16000);
  assert.equal(chunks.flatMap(c=>c.lines.map(l=>l.text)).join(""),text);
  assert.ok(chunks.every(c=>c.ordinals.has(4)));
  assert.equal(imageSafeText('文字<img src="x">![alt](y)').imageCount,2);
  assert.equal(imageSafeText('![alt](y)').text,"");
});
test("merge preserves every concept and its frozen evidence, even if the model rewrites facts", () => {
  const edited={...map,nodes:map.nodes.map(n=>n.kind==="concept"?{...n,label:"错误改写",explanation:"伪造",references:[{blockOrdinal:9,quote:"伪造"}]}:n)};
  assert.deepEqual(reconcileMergedMindMap(edited,[map]).nodes[1],map.nodes[1]);
  assert.throws(()=>reconcileMergedMindMap({...map,nodes:[map.nodes[0]!]},[map]));
});
test("节点名、解释与引用都不再按固定字数拒收：写长一点不该让整张图判无效", () => {
  const source = "把复习安排在快要忘记的时候，比反复重读同一段材料更有效。间隔越长，回忆越费力，记住的也越牢。";
  const longLabel = "复习该安排在快要忘记的时候而不是反复重读".repeat(3);
  const longExplanation = "读者需要知道的是复习时机比复习次数更关键。".repeat(30);
  assert.ok(longLabel.length > 48 && longExplanation.length > 600, "用例必须真的越过原来那两道闸");
  const wide = { ...map, nodes: map.nodes.map(n => n.kind === "concept"
    ? { ...n, label: longLabel, explanation: longExplanation, references: [{ blockOrdinal: 1, quote: source }] }
    : n) };
  const parsed = parseMindMap(JSON.stringify(wide), [{ ordinal: 1, type: "text", content: source }]);
  assert.equal(parsed.nodes[1]!.label, longLabel, "长名字原样留下");
  assert.equal(parsed.nodes[1]!.explanation, longExplanation);
  assert.equal(parsed.nodes[1]!.references[0]!.quote, source, "整段引用照留，读者才回得到原文");
});
test("校验失败要说清是哪一处：重试提示得靠它指出该改哪里", () => {
  // 引用核不回原文：点名是哪个节点、哪一段、哪一句
  assert.throws(
    () => parseMindMap(JSON.stringify(map), [{ ordinal: 1, type: "text", content: "完全对不上的另一段话" }]),
    /节点 c0_a 引用第 1 段的/,
  );
  // 结构问题：带上 zod 的第一条问题，而不是一句"未通过校验"
  assert.throws(
    () => parseMindMap(JSON.stringify({ ...map, rootId: "missing" }), []),
    /脑图结构不完整或缺少原文依据：脑图必须只有一个主题根节点/,
  );
});

test("引文逐字是真的、门牌号写错时按实际出处归位（只在唯一命中时）", () => {
  // 实测形状（2026-10-14《瑞利散射》）：列表内容记在它上方小标题的块号上，
  // repair 修好被点名的一处、下一处再犯，一发烧两次调用仍判红。
  const sources = [
    { ordinal: 2, type: "heading", content: "现象" },
    { ordinal: 3, type: "text", content: "- 大白天抬头，天空是蓝的，而且蓝得四面八方都有。" },
  ];
  const citing = (blockOrdinal: number, quote: string) => ({ ...map,
    nodes: map.nodes.map(node => node.kind === "concept"
      ? { ...node, references: [{ blockOrdinal, quote }] }
      : node) });
  const parsed = parseMindMap(JSON.stringify(citing(2, "大白天抬头，天空是蓝的")), sources);
  assert.equal(parsed.nodes[1]!.references[0]!.blockOrdinal, 3, "出处指向真的含这句的那一段");
  assert.equal(parsed.nodes[1]!.references[0]!.quote, "大白天抬头，天空是蓝的");

  // 两处都命中时不归位——那是猜，判红并把候选说给模型。
  const twice = [
    { ordinal: 2, type: "text", content: "- 天空是蓝的，四面八方都有。" },
    { ordinal: 7, type: "text", content: "再提一次：天空是蓝的，四面八方都有。" },
  ];
  assert.throws(
    () => parseMindMap(JSON.stringify(citing(4, "天空是蓝的，四面八方都有")), twice),
    /这句同时出现在段落 2、7/,
    "多命中必须仍然判红，归位只认唯一答案",
  );
  // 真找不到逐字一致的原文时也照旧判红。
  assert.throws(
    () => parseMindMap(JSON.stringify(citing(2, "夜里星星会排队")), sources),
    /这句在读取过的段落里没有逐字一致的原文/,
  );
});

test("引号字形不是内容差别：弯引号复述直引号原文也要核得过", () => {
  // 实测（2026-10-14）：原文存 ASCII 直引号，模型按中文排版写成 “ ”，
  // 核对判"原文里找不到"、repair 重发又写成弯引号，一发烧两次调用判红。
  const straight = [{ ordinal: 12, type: "text", content: '这就是"蓝光比红光更容易被散射"的全部底气：不是蓝光更亮，而是它波长更短。' }];
  const curlyMap = { ...map, nodes: map.nodes.map(node => node.kind === "concept"
    ? { ...node, references: [{ blockOrdinal: 12, quote: '这就是“蓝光比红光更容易被散射”的全部底气' }] }
    : node) };
  const parsed = parseMindMap(JSON.stringify(curlyMap), straight);
  assert.equal(
    parsed.nodes[1]!.references[0]!.quote,
    '这就是"蓝光比红光更容易被散射"的全部底气',
    "核对放宽字形，落库的引文仍取原文那一版（读者回得到的就是笔记里真的那句话）",
  );
});

test("模型自己用省略号截短的引文，认它那段真的前缀；编的那一句照样判红", () => {
  // 实测（2026-10-14，37 万字符长文的脑图）：节点引长表格行写成
  // 「AgentRun | 原目标、当前目标 revision、完成条件、输入引用、范…」，除末尾省略号外逐字对得上，
  // 却因"必须逐字"整张图判无效、两次调用全烧掉。
  const row = { ordinal: 42, type: "text", content: "| `AgentRun` | 原目标、当前目标 revision、完成条件、输入引用、范围和产物 | 一次目标的持续记录 |" };
  const sources = [row, { ordinal: 43, type: "text", content: "4.1 必须解决现有表的限制" }];
  const citing = (blockOrdinal: number, quote: string) => ({ ...map,
    nodes: map.nodes.map(node => node.kind === "concept"
      ? { ...node, references: [{ blockOrdinal, quote }] }
      : node) });
  const abbreviated = parseMindMap(JSON.stringify(citing(42, "AgentRun | 原目标、当前目标 revision、完成条件、输入引用、范…")), sources);
  assert.equal(abbreviated.nodes[1]!.references[0]!.quote, "AgentRun | 原目标、当前目标 revision、完成条件、输入引用、范",
    "落库的是原文里真在的那一段前缀，不是模型写的带省略号那串");

  // 前缀本身在原文里不存在（省略号不是通行证）→ 照旧判红。
  assert.throws(() => parseMindMap(JSON.stringify(citing(42, "AgentRun | 原目标、月亮背面环形山的编号…")), sources),
    /这句在读取过的段落里没有逐字一致的原文/);
  // 短到撑不起一个知识点的前缀不认（"一句…"在哪一段都可能出现）。
  assert.throws(() => parseMindMap(JSON.stringify(citing(42, "原…")), sources),
    /脑图引用无法在读取的段落中核对/);
  // 同一段前缀在多段都出现、而模型指的那一段又没有它时不猜出处：与归位那条同一个判据。
  const elsewhere = [{ ordinal: 44, type: "text", content: "第 44 段：AgentRun | 原目标、当前目标 revision、完成条件" },
    { ordinal: 45, type: "text", content: "第 45 段：AgentRun | 原目标、当前目标 revision、完成条件" }];
  assert.throws(() => parseMindMap(JSON.stringify(citing(43, "AgentRun | 原目标、当前目标 revision…")), [row, ...elsewhere]),
    /这句同时出现在段落 42、44、45/);
});

test("带分隔行的真表格：模型按原始 markdown 引，渲染后的正文里没有竖线，照样核得回", () => {
  // 实测（2026-10-14，37 万字符长文的脑图，节点 g44c3 引第 891 段）：
  // 提示里给模型的是原始 markdown，`noteBlockRenderedTextV1` 却把它解析成表格、
  // 竖线不进文本——于是每一句表格行的引用都"没有逐字一致的原文"，两发判死。
  const table = [
    "| 入口/作业 | 执行时读取 | 可以贡献的依据 |",
    "| --- | --- | --- |",
    "| 当前交流 | 当前请求、相关记忆与方法 | 明确长期要求、具体纠正、有来源的共同事件 |",
  ].join("\n");
  const citing = (blockOrdinal: number, quote: string) => ({ ...map,
    nodes: map.nodes.map(node => node.kind === "concept"
      ? { ...node, references: [{ blockOrdinal, quote }] }
      : node) });
  const cited = parseMindMap(JSON.stringify(citing(891, "当前交流 | 当前请求、相关记忆与方法 | 明确长期要求、具体纠正、有来源的共同…")),
    [{ ordinal: 891, type: "paragraph", content: table }]);
  const stored = cited.nodes[1]!.references[0]!;
  assert.equal(stored.blockOrdinal, 891);
  assert.equal(stored.quote.includes("|"), false,
    "落库那一句取的是渲染后的形态：读者在笔记页面上看到的就是这一串，没有竖线");
});

test("有序编号那一行：模型连 `1. ` 一起抄，页面上编号画成列表不进正文，照样核得回", () => {
  // 实测（2026-10-14，37 万字符长文的脑图，节点 g1n3 引第 14 段）：模型照抄了
  // `1. **单次调用可以是完整执行。** 明确的小任务…`，而 `noteBlockRenderedTextV1` 把
  // 列表编号渲染成列表、文本里没有 `1. `——连发两版判死。
  const content = [
    "1. **单次调用可以是完整执行。** 明确的小任务允许直接完成；复杂目标的步骤由 Agent 结合结果选择。",
    "2. **入口不同，能力与回执一致。** 页面按钮可限定能力与输入。",
  ].join("\n");
  const citing = (blockOrdinal: number, quote: string) => ({ ...map,
    nodes: map.nodes.map(node => node.kind === "concept"
      ? { ...node, references: [{ blockOrdinal, quote }] }
      : node) });
  const parsed = parseMindMap(JSON.stringify(citing(14,
    "1. **单次调用可以是完整执行。** 明确的小任务允许直接完成；复杂目标的步骤…")),
    [{ ordinal: 14, type: "paragraph", content }]);
  const stored = parsed.nodes[1]!.references[0]!;
  assert.equal(stored.blockOrdinal, 14);
  assert.match(stored.quote, /^单次调用可以是完整执行/,
    "落库从正文第一个字开始：编号不在页面正文里");
  // 该拒的照拒：不同行的内容不会因为跳过编号就串到一起。
  assert.throws(() => parseMindMap(JSON.stringify(citing(14, "1. 这一段里从来没有过的一句话…")),
    [{ ordinal: 14, type: "paragraph", content }]), /这句在读取过的段落里没有逐字一致的原文/);
});
