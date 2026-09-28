/**
 * 动态产物的**依据核对与节点冻结**（39 §6.1 硬约束的那一半；39f DEMO-1）。
 *
 * ## 这一份现在负责什么
 *
 * 上一版让服务端把「讲解 → 例子 → 计划第 N 步」切成一串节点，模型只对每段写一句话。
 * 于是画面画的是**教学内容的包装顺序**，不是知识本身：真实样本《提取练习四步走》
 * 长成「讲解、例子、计划第 1–4 步」六格，而条形图量的还是各段说明的**字数**——字数
 * 对理解提取练习没有任何教学价值（39f §5 DEMO-1）。
 *
 * 所以职责对调了：
 *
 *   - **模型**提出的是**知识过程**：这一步在理解上叫什么、这一步发生了什么、它依据
 *     笔记里的哪一块的哪一句。这三样都是它的**主张**，不是结论。
 *   - **服务端**逐条核那三样，并**决定哪几条能上屏**。核得上的才成为节点；核不上的
 *     整条丢掉，不改写、不补齐。剩下的节点与那一处位置是服务端给的，所以 §6.1 那句
 *     「读数必须来自可信播放器或服务端给定值」在结构上仍然成立——模型写不进任何数字
 *     字段（合同两级 `strictObject`），也写不进任何**没被核对过**的依据。
 *
 * 2026-09-28：画面本身改由模型整份写之后（`round-artifact-doc.ts`），这一份**只**做
 * 依据核对与计量话术扫描两件事。上一版用来画进度格与证据格的三个 `compute*` 读数函数
 * 连同 `ArtifactReadoutV1` 一起没有调用方了——那些格子由纸面按已核对的节点渲染，
 * 读数不再是一个"由谁算"的独立问题。留着它们只会让后来的人以为还有一条读数来源。
 *
 * ## 为什么依据要逐字核对
 *
 * 「锚到第几块」是弱约束：模型可以指一块存在但根本不相关的正文，凭空讲一个机制。
 * 所以每一步必须同时给出**块号**和**那一块里的一段原文**，服务端在冻结快照里找得到
 * 才算数。找得到 = 这一段话真的出现在用户的笔记里；找不到 = 它是编的，丢掉。
 *
 * 核对用的是**去掉标记之后的纯文本**（与 `teaching-explain.ts` 的
 * `plainTextOfBlockV1` 同一套剥离规则），比较时忽略空白：模型引原文时把换行折成空格
 * 是常事，为此判它编造是误伤。**逐字顺序不放松**——字符必须仍按原顺序出现在那一块里。
 */

/** 冻结快照里的一块正文。这里只声明核对真正用到的字段，所以能直接吃教学那侧的块。 */
export interface ArtifactEvidenceBlockV1 {
  readonly ordinal: number;
  readonly type: string;
  readonly text: string;
}

/** 模型对「这一步」的主张。三样都要服务端核得上，其中依据是硬条件。 */
export interface ArtifactStepDraftV1 {
  /** 这一步在理解上叫什么（≤ 24 字）。 */
  readonly title: string;
  /** 这一步发生了什么（≤ 200 字）。同时是文字等价表达与降级分镜的正文。 */
  readonly narration: string;
  /** 主张依据在冻结快照里的哪一块。 */
  readonly evidenceOrdinal: number;
  /** 主张那一块里的哪一段原文（≤ 160 字），服务端要在这块里逐字找到它。 */
  readonly evidenceQuote: string;
}

/** 一个**已经核对过**、可以上屏的节点。字段全部由服务端定，模型改不了。 */
export interface ArtifactNodeV1 {
  /** 0 起。上屏顺序就是这个顺序。 */
  readonly index: number;
  /** 这一步叫什么（模型写的，服务端核过它不声称实测）。 */
  readonly title: string;
  /** 这一步发生了什么（模型写的，同上）。 */
  readonly narration: string;
  /** 那一块属于哪一节；没有小节时是「这一段」。这是**用户能认出来**的位置。 */
  readonly sectionLabel: string;
  /** 服务端在那一块里**真的找到过**的那一句原文。 */
  readonly quote: string;
}

/** 一份演示最多几步。知识过程再长也不该是一堂课；超出的整份拒绝，不截断。 */
export const ARTIFACT_MAX_STEPS_V1 = 6;
/** 少于这么多步就不成其为「走一遍」，整份拒绝。 */
export const ARTIFACT_MIN_STEPS_V1 = 2;

export type ArtifactStepRejectionV1 = "empty" | "unknown_block" | "quote_not_found" | "measurement_claim";

export interface ArtifactStepVerdictV1 {
  readonly ordinal: number;
  readonly ok: boolean;
  readonly reason?: ArtifactStepRejectionV1;
}

/**
 * 核对结果。`nodes` 是**服务端裁定**的节点集——不是模型声明的那一组。
 *
 * `rejected` 原样带出去是为了留痕（§16.4）：界面不说"模型编了一句"，但事后读得到
 * 有几条被核对挡下、挡在哪一条判据上。
 */
export type ArtifactGroundingResultV1 =
  | { readonly ok: true; readonly nodes: readonly ArtifactNodeV1[]; readonly rejected: readonly ArtifactStepVerdictV1[] }
  | { readonly ok: false; readonly reason: "empty" | "too_few" | "over_quota"; readonly detail: string };

/**
 * 去掉 markdown 标记，得到「这句话读起来是什么」——与教学那侧的 `plainTextOfBlockV1`
 * 同一套规则。核对只在纯文本上进行：带 `**` 与不带 `**` 的同一段话必须都算命中。
 */
export function plainTextForGroundingV1(content: string): string {
  return content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/`{1,3}/g, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 比较用：只压掉空白，其余逐字保留。中文本来就没有词间空白，这一层主要是给引文折行。 */
function squashWhitespaceV1(text: string): string {
  return text.replace(/\s+/g, "");
}

const EVIDENCE_QUOTE_MAX_V1 = 160;

/** 那一块属于哪一节：往回找最近的一个小节标题。找不到就说「这一段」，不编节名。 */
export function sectionLabelForBlockV1(
  blocks: readonly ArtifactEvidenceBlockV1[],
  ordinal: number,
): string {
  const heading = plainTextForGroundingV1(
    blocks.find((block) => block.ordinal === ordinal && block.type === "heading")?.text ?? "",
  );
  if (heading) return heading.length > 18 ? `${heading.slice(0, 17)}…` : heading;
  let label = "这一段";
  for (const block of blocks) {
    if (block.ordinal >= ordinal) break;
    if (block.type !== "heading") continue;
    const text = plainTextForGroundingV1(block.text);
    if (text) label = text.length > 18 ? `${text.slice(0, 17)}…` : text;
  }
  return label;
}

/**
 * 逐条核对模型主张的每一步，裁出**服务端裁定**的节点集。
 *
 * 判据四条，顺序就是代价从低到高：
 *   1. 这一步有内容（标题、讲解、依据句都非空）；
 *   2. 依据块在冻结快照里**存在**——指一块不存在的正文是白指；
 *   3. 依据句在那块里**逐字找得到**——这是「不是编的」那一条真正的判据；
 *   4. 标题与讲解没有声称实测过真实系统（§6.1）。
 *
 * 丢掉不整份拒绝：核过的那几条都是模型原话与服务端原位，逐字上屏没有改写。**只有**
 * 剩下的步数不成其为「走一遍」时（少于两条、或一条都没有）才整份作废——那时画面要么
 * 是空的，要么只剩一步，等于没画。
 */
export function groundArtifactStepsV1(input: {
  readonly steps: readonly ArtifactStepDraftV1[];
  readonly blocks: readonly ArtifactEvidenceBlockV1[];
}): ArtifactGroundingResultV1 {
  if (input.steps.length === 0) {
    return { ok: false, reason: "empty", detail: "这一轮没有可上屏的知识步骤" };
  }
  if (input.steps.length > ARTIFACT_MAX_STEPS_V1) {
    return {
      ok: false,
      reason: "over_quota",
      detail: `一份演示最多 ${ARTIFACT_MAX_STEPS_V1} 步，这次给了 ${input.steps.length} 步`,
    };
  }

  const byOrdinal = new Map<number, ArtifactEvidenceBlockV1>();
  for (const block of input.blocks) byOrdinal.set(block.ordinal, block);
  // 块正文是纯文本化 + 去空白之后比，所以同一块算一次就够。
  const plainByOrdinal = new Map<number, string>();
  const plainOf = (block: ArtifactEvidenceBlockV1): string => {
    const cached = plainByOrdinal.get(block.ordinal);
    if (cached !== undefined) return cached;
    const plain = squashWhitespaceV1(plainTextForGroundingV1(block.text));
    plainByOrdinal.set(block.ordinal, plain);
    return plain;
  };

  const nodes: ArtifactNodeV1[] = [];
  const rejected: ArtifactStepVerdictV1[] = [];
  const seenTitles = new Set<string>();

  input.steps.forEach((draft, position) => {
    const reject = (reason: ArtifactStepRejectionV1): void => {
      rejected.push({ ordinal: position, ok: false, reason });
    };
    const title = draft.title.trim();
    const narration = draft.narration.trim();
    const quote = draft.evidenceQuote.trim();
    if (!title || !narration || !quote || quote.length > EVIDENCE_QUOTE_MAX_V1) {
      reject("empty");
      return;
    }
    // 同名步骤在画面上是两枚一样的纸签：后面那枚永远盖着前面那枚。
    // 不改写、只丢掉——同一条知识过程里两个一样的名字，通常是模型把一条说了两遍。
    const titleKey = squashWhitespaceV1(title);
    if (seenTitles.has(titleKey)) {
      reject("empty");
      return;
    }
    const block = byOrdinal.get(draft.evidenceOrdinal);
    if (!block) {
      reject("unknown_block");
      return;
    }
    if (!plainOf(block).includes(squashWhitespaceV1(quote))) {
      reject("quote_not_found");
      return;
    }
    if (hasMeasurementClaimV1(title) || hasMeasurementClaimV1(narration) || hasMeasurementClaimV1(quote)) {
      reject("measurement_claim");
      return;
    }
    seenTitles.add(titleKey);
    nodes.push({
      index: nodes.length,
      title,
      narration,
      sectionLabel: sectionLabelForBlockV1(input.blocks, block.ordinal),
      quote,
    });
  });

  if (nodes.length < ARTIFACT_MIN_STEPS_V1) {
    return {
      ok: false,
      reason: nodes.length === 0 ? "empty" : "too_few",
      detail: `${input.steps.length} 步里只有 ${nodes.length} 步的笔记依据核对得上，不成其为一次演示`,
    };
  }
  return { ok: true, nodes, rejected };
}

/**
 * 模型可能写进来的「假装实测过」那一类话（§6.1 明禁）。
 *
 * 范围刻意**窄**：只拦"声称测过真实系统"的说法，不拦正常教学内容——一篇讲数据库
 * 执行计划的笔记里出现"执行计划"三个字是完全正常的，把那也拒掉就成了误伤。拦下来
 * 的那一份走 `contract_rejected` 进失败表（§16.4 留痕），不静默改写：改写等于让
 * 界面上出现一句模型没写过的话。
 *
 * 大小写不敏感（"QPS"／"qps"）。
 */
export const MEASUREMENT_CLAIM_TOKENS_V1: readonly string[] = [
  "实测",
  "实测结果",
  "真实运行",
  "运行结果如下",
  "耗时",
  "毫秒",
  "qps",
  "benchmark",
  "压测",
];

/**
 * 否定／免责的说法。
 *
 * **这一段是被真模型跑出来的第一版翻车之后才有的**：qwen-plus 相当老实地写了
 * 「这不是对某次阅读行为的**实测**记录，仅示意理解路径」与「本演示仅示意操作顺序，
 * 不体现实际**耗时**或效果」两句，而"整段扫关键字"的那一版把这两句**诚实免责**判成了
 * 违规——8 个真实样本里毙掉 2 个（真实通过率 6/8）。判据要拦的是"这句话声称测过"，
 * 不是"这段文字里出现过这个词"，所以改成**分句 + 看否定在不在判词前面**。
 */
const MEASUREMENT_DISCLAIMERS_V1: readonly string[] = [
  "不是", "并非", "不代表", "不体现", "不涉及", "不反映", "不是对", "无从",
  "没有", "未有", "未做", "未测", "不会", "不可", "不能",
  "仅示意", "仅是示意", "只示意", "仅用来示意", "只用来示意", "仅为示意", "只是示意",
];

/** 中英文标点都算分句点：模型写的免责常常自带一个逗号。 */
const CLAUSE_SPLIT_V1 = /[，。；：、！？,.;:!?\n]+/;

/**
 * 这一句有没有在**声称**测过真实系统。命中即整条步骤丢掉。
 *
 * 逐句扫，且只在**判词之前没有免责说法**时才算违规：
 *   - 「这一步是实测结果，耗时 12 毫秒」 → 两句都没有免责 ⇒ 丢；
 *   - 「这不是对某次阅读行为的实测记录」 → 「不是」在「实测」之前 ⇒ 放行（诚实的免责）；
 *   - 「不体现实际耗时或效果」 → 放行；
 *   - 「压测了一下」 → 丢。
 *
 * **逐句**而不是整段：模型常把免责和声明写进同一段的两个分句（「仅示意理解路径，
 * 下面是实测步骤」），整段只要有一处免责就放行的话，后半句那处声明就漏了过去。
 */
export function hasMeasurementClaimV1(text: string): boolean {
  return text.split(CLAUSE_SPLIT_V1).some((clause) => {
    const lower = clause.toLowerCase();
    for (const token of MEASUREMENT_CLAIM_TOKENS_V1) {
      const at = lower.indexOf(token.toLowerCase());
      if (at < 0) continue;
      const before = lower.slice(0, at);
      if (MEASUREMENT_DISCLAIMERS_V1.some((disclaimer) => before.includes(disclaimer))) continue;
      return true;
    }
    return false;
  });
}

/**
 * 服务端**自己**加的那一句示意声明。
 *
 * 为什么模型写的 `caution` 不够：模型可以漏写、可以写得含糊、也可以整句不写。所以
 * 这一句由服务端**无条件**加在最前面（`round-artifact-render.ts`），模型的那句只能
 * 跟在后面补充，**替代不了**它。界面上于是永远有一句明确的"这是示意"。
 */
export const ARTIFACT_ILLUSTRATION_NOTICE_V1 =
  "这是按你这一轮的材料画出来的示意，用来帮助理解；它不是对任何数据库或系统的实测执行。";
