import { noteBlockRenderedTextV1 } from "@astella/shared/note-doc-schema";

export type NoteExpansionSourceBlock = { ordinal: number; type: string; content: string };
/** 分段读取时每一段先交回的一个候选方向；`quote` 逐字来自那一段原文。 */
export type NoteExpansionCandidate = {
  title: string;
  relationship: string;
  reference: { blockOrdinal: number; quote: string };
};

const JSON_SHAPE = [
  "只返回 JSON，顶层只含 drafts 数组，包含 2 到 4 篇草稿。每篇只含 title、relationship、sourceReferences、blocks 四个字段。title 为 2 到 120 字；relationship 为 12 到 500 字。",
  "sourceReferences 包含 1 到 3 个对象，每个只含 blockOrdinal（使用下方标注的整数 blockOrdinal，从 0 开始）和 quote（对应段落中 8 到 320 字的逐字摘录）。每条引用必须对应自己的拓展方向。关系说明与正文用原文的主题或引句说明来处，不使用内部段落编号。",
  "blocks 包含 2 到 30 个正文块，每块只含 type 和 content。type 必须是 paragraph、heading、list、quote、code 中的一个具体值，不要把多个类型用竖线拼在一起。列表使用 list，每项一行，不带项目符号；标题使用 heading，不带井号；代码使用 code，不带围栏。不要把整段 Markdown 列表塞入 paragraph。content 为非空字符串，每块不超过 8000 字，每篇正文总长不超过 20000 字。不要输出 Markdown 围栏或额外字段。",
].join("\n\n");

/** 起草用的说明：内容纪律与引用要求都在这一处写，分段那一条路径也复用同一段。 */
const DRAFTING_RULES = [
  "每篇必须是能单独读懂的知识草稿，不要只写概念名称或学习计划。relationship 用一两句说明它和原笔记的具体关系。sourceReferences 必须引用下方原文中确实存在的句子，作为这条拓展关系的来处。拓展正文可以增加原文之外的常识，但请把不确定或超出原文的内容用‘补充理解’等自然措辞标明，不能假装它是原文事实。",
  "标题、关系说明和正文都要保留原文的条件与替代方案。原文介绍某一种实现，不代表它是唯一实现；有可行的替代方案时，应比较各自条件和优势，不能写成‘必须如此’。例如原文允许半开区间与闭区间两种二分查找写法，就不能命名为‘为什么二分查找必须用半开区间’。‘必须、唯一、总是’等结论需要明确依据，标题也不能预设原文不支持的结论。提交前检查标题与正文是否互相矛盾。",
  "涉及算法、循环不变量或错误示例时，先用小规模输入逐步核验初始状态、每次更新和结束状态。空区间中的全称断言成立，不代表元素都落在另一侧。声称错误更新会让结果偏前或偏后时，必须有具体输入和演算支持；不能确认方向时只说明会错过候选位置，不猜测偏移方向。检查正文的初始化解释是否与后面的不变量一致。",
];

export function buildNoteExpansionPrompt(
  blocks: readonly NoteExpansionSourceBlock[],
  focused: boolean,
  candidates?: readonly NoteExpansionCandidate[],
): string {
  const source = blocks.map((block) => `[原文第 ${block.ordinal + 1} 段，blockOrdinal=${block.ordinal}]\n${noteBlockRenderedTextV1(block.type, block.content)}`).join("\n\n");
  return [
    "请从用户正在读的笔记出发，写 2 到 4 篇真正有助于继续理解的短拓展笔记。用自然、通俗的中文，不用学习理论术语。",
    focused ? "用户选中了一段，因此围绕这处概念向前置知识、相邻概念、实际用法或边界继续展开。" : "从整篇笔记中选择最值得继续了解的不同方向。",
    ...DRAFTING_RULES,
    ...(candidates && candidates.length > 0 ? [
      // 正文太长被分段时，起草这一发看到的是各段读完后交回的候选方向与它们的逐字原句。
      "这篇笔记是按段读完的，下面列出各段提出的候选方向与各自的逐字原句。把它们整理成 2 到 4 篇草稿：同一件事只留一篇，title 与 relationship 可以改写得更准确，sourceReferences 只许逐字复制下方出现过的句子，不能凭候选的转述重新拼原文。",
      `候选方向：${JSON.stringify(candidates.map((candidate) => ({
        title: candidate.title, relationship: candidate.relationship,
        blockOrdinal: candidate.reference.blockOrdinal, quote: candidate.reference.quote,
      })))}`,
    ] : []),
    JSON_SHAPE,
    "笔记原文：",
    source,
  ].join("\n\n");
}

/**
 * 分段读取那一步的提示词：一次只看一段，交回这一段的候选方向。
 *
 * 引文要逐字来自**这一段**，所以证据核对是按段做的——合并时不会把 A 段的句子安到 B 段上。
 */
export function buildNoteExpansionCandidatePrompt(
  lines: readonly { ordinal: number; text: string }[],
  focused: boolean,
  part: { index: number; total: number },
): string {
  const source = lines.map((line) => `[原文第 ${line.ordinal + 1} 段，blockOrdinal=${line.ordinal}]\n${line.text}`).join("\n\n");
  return [
    `这篇笔记的正文超出当前模型一次能读的预算，所以按段来读。这是第 ${part.index + 1}/${part.total} 部分，只看这一部分，不要假装读过其他部分。`,
    focused ? "用户选中了一段，候选方向要服务于这处概念的前置知识、相邻概念、实际用法或边界。" : "从这一部分里挑出最值得继续了解的不同方向。",
    "每个方向给：title（2 到 120 字）、relationship（12 到 500 字，说明它和这一段原文的具体关系）、reference（blockOrdinal 用下方标注的整数，quote 从对应段落逐字摘录 8 到 320 字）。方向条数由这一部分的内容决定，能给出几个真正不同的就写几个，宁少勿凑；引用不到的句子不要写。",
    "只返回 JSON，顶层只含 candidates 数组，每个元素只含 title、relationship、reference 三个字段。不要输出 Markdown 围栏或额外文本。",
    "relationship 要说明它和这一段原文的具体关系，不能只复述标题。原文只介绍一种做法时，不要把它写成唯一做法；‘必须、唯一、总是’这类结论需要原文支持。超出原文的理解在 relationship 里用‘补充’这类自然措辞标明。",
    "这一部分的原文：",
    source,
  ].join("\n\n");
}
