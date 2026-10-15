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

import { noteBlockRenderedTextV1 } from "../note-doc-schema.ts";

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

/**
 * 少于这么多步就不成其为「走一遍」，整份拒绝。
 *
 * 只有**下界**：一份演示走几步由材料里真实的过程决定（流程型的笔记一节一步，自然就长），
 * 不设"最多几步"——那个数与窗口、与材料都无关。2026-10-12 的实测教训：上限 6 时，
 * 七步的笔记整份判形状错、重发再判错，用户最后看到的是「没有演示」。
 */
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
  | { readonly ok: false; readonly reason: "empty" | "too_few"; readonly detail: string };

/**
 * 引号字形与 markdown 标记是「怎么排的」，不是「说了什么」——引文核对时一律不看。
 *
 * 实测（2026-10-14，《瑞利散射与天空的颜色》脑图）：原文存的是 ASCII 直引号 `"`，
 * 模型按中文排版复述成 `“ ”`；核对把这一字之差判成"原文里找不到"，repair 那一发又
 * 写成同样的弯引号，一发烧两次调用判红——用户只看到"这次生成没有完成"。
 *
 * 竖线是同一个形状的第二种成因（2026-10-14，37 万字符长文的脑图）：提示里给模型看的是
 * **原始 markdown**（表格整行 `| 当前交流 | 当前请求… |`），核对用的却是**渲染后的正文**，
 * 而 `noteBlockRenderedTextV1` 把竖线去掉了。于是模型引的每一句表格行都核不回去——
 * 长笔记里表格行最多，必然在第一发就撞上（节点 g44c3 引第 891 段、节点 c42_objects
 * 引第 42 段，两发都判死）。竖线和反引号一样是排版骨架，不是文字。
 *
 * 这条判据此前同时住在四份实现里（脑图/速看/扩展各自的 compactEvidence 与演示那套
 * 整串比较），漏改一处就会静默分叉；这里收成唯一的一处。
 */
export const GROUNDING_MARKERS_V1 = "*_~`|\"'“”‘’‛„‟";

/** 逐字符核对用的判据：这些字符不参与"是否同一句"的比较（空白由调用方自己判）。 */
export function isGroundingMarkerV1(char: string): boolean {
  return GROUNDING_MARKERS_V1.includes(char);
}

/** 整串比较用的归一：弯引号一律按直引号看（拿不到原文偏移的那套核对走这条）。 */
export function normalizeGroundingQuotesV1(value: string): string {
  return value.replace(/[“„‟”‘‛’]/gu, '"');
}

/**
 * 去掉 markdown 标记，得到「这句话读起来是什么」——与教学那侧的 `plainTextOfBlockV1`
 * 同一套规则。核对只在纯文本上进行：带 `**` 与不带 `**` 的同一段话必须都算命中。
 */
export function plainTextForGroundingV1(content: string): string {
  return content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    // 列表符号在页面上画成圆点与编号，不是行首那个字符。留着它，模型照素材复述出来的
    // 引文就带着「- 」（2026-10-14 实测：演示的 outline 引文全是 `- 自主：…`），
    // 而读者在笔记上看到的那一句没有。权威形态是 noteBlockRenderedTextV1，
    // 这一份是它的纯文本近似——两者要对齐着改。
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}\d+[.)]\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/`{1,3}/g, "")
    // 表格竖线：权威形态那一步把 markdown 解析成节点，竖线落在单元格边界上、不进文本
    // （2026-10-14 实测：37 万字符长文的表格行整行渲染后没有一个 `|`）。这里剥掉它，
    // 才对得上"读者看到的那一句"；与 GROUNDING_MARKERS_V1 里那个 `|` 是同一条决定。
    .replace(/\|/g, "")
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

/** 字面命中那一句判据的唯一写法：`plain` 已经是去掉标记并压掉空白的那一份。 */
function containsQuoteV1(plainBlockText: string, quote: string): boolean {
  // 引文那一侧走**同一道剥离**：模型从素材里逐字复制时会把行首的 `- ` 一起抄下来，
  // 底本已经不看它，needle 再留着就变成"逐字对不上"的误伤。
  // 引号字形同理不参与判等（见 normalizeGroundingQuotesV1 的注释）。
  const needle = normalizeGroundingQuotesV1(
    squashWhitespaceV1(plainTextForGroundingV1(quote)),
  );
  return needle.length > 0 && normalizeGroundingQuotesV1(plainBlockText).includes(needle);
}

/**
 * 存给读者的那一句：到**渲染后的块文本**里把这句定位出来，取渲染文本的那一段。
 *
 * `plainTextForGroundingV1` 只剥行内标记，列表项的 `- ` 会留下——于是演示的引文卡上写着
 * 「- 自主：下一步动作由系统自己选…」，而笔记页面上读者看到的那一句没有那个短横。
 * 脑图/速看/扩展存的都是渲染文本，这里对齐成同一个口径。定位不到就照原样存，
 * 不因此丢掉那一步：这句是否真的在块里，上面 `containsQuoteV1` 已经判过。
 */
function readerVisibleQuoteV1(block: ArtifactEvidenceBlockV1, quote: string): string {
  const rendered = Array.from(noteBlockRenderedTextV1(block.type, block.text));
  const kept: number[] = [];
  for (let index = 0; index < rendered.length; index += 1) {
    const char = rendered[index]!;
    if (/\s/u.test(char) || isGroundingMarkerV1(char)) continue;
    kept.push(index);
  }
  const target = Array.from(plainTextForGroundingV1(quote))
    .filter(char => !/\s/u.test(char) && !isGroundingMarkerV1(char))
    .join("");
  if (target.length === 0 || kept.length < target.length) return quote;
  const flat = kept.map(index => rendered[index]!).join("");
  const at = flat.indexOf(target);
  if (at < 0) return quote;
  return rendered.slice(kept[at]!, kept[at + target.length - 1]! + 1).join("").trim() || quote;
}

/**
 * 「这一句真的出现在那一块里」。分段读正文的调用方也要按同一个口径核，所以把这一条
 * 单独交出去——**只**是字面命中；条数、重名与整份取舍仍由 `groundArtifactStepsV1` 裁定。
 */
export function evidenceQuoteMatchesBlockV1(blockText: string, quote: string): boolean {
  return containsQuoteV1(squashWhitespaceV1(plainTextForGroundingV1(blockText)), quote);
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
    if (!containsQuoteV1(plainOf(block), quote)) {
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
      quote: readerVisibleQuoteV1(block, quote),
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
      // 紧贴判词的否定前缀（「非实测」「未实测」「未经实测」）就是免责本身。
      // 2026-10-12 真窗口那一发实测：提示词要求把读数标成示意值，模型老实写「非实测结果」，
      // 整页跑了 163 秒之后被完成判据判死——拦的应该是"声称测过"，不是这三个字出现过。
      // 只认**紧贴**的那一片否定：「非但实测结果惊人」的「但」挡不住，仍然照拒。
      // 2026-10-12 又实测到三种同形写法被误杀——「不算实测」「算不上实测」「未经过实测」：
      // 它们的前缀是「不+算(得上)」「未+经过」，只认单字否定会漏掉中间那一个动词。
      // 这是**放行**方向的口径（拦的是"声称测过"，不是"出现过这个词"），
      // 放宽到「否定词 + 至多两个助动词」为止，不许跨过转折词。
      if (/(?:未经|非|未|无|没|不|别)(?:算|是|曾|经|有|做|进行|过|得|作|要|会|能|上|下){0,3}$/.test(before.trimEnd())) continue;
      // 判词**紧跟其后**的示意说法同样是免责：「耗时一栏只是示例」「这一步耗时仅为示意」。
      // 只在很短的一小段里认（≤8 字），免得「耗时 12 毫秒后不是最优」这种把闸放过去。
      if (/^(?:一栏|一列|这一格|这里)?(?:只是示例|仅为示意|是示意|为示意|属于示意|只是演示|仅作示意|仅为演示)/.test(lower.slice(at + token.length, at + token.length + 8))) continue;
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
