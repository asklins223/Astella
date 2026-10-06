/** Pure companion-diary material shaping, prose rules, and output validation. */

import { z } from "zod";
import {
  COMPANION_VOICE_STYLE_LINES_V2,
  companionDailyBlockV1Schema,
  companionPersonaActivenessV1Schema,
  companionPersonaBoundariesV1Schema,
} from "@astella/shared";
import {
  PERSONA_SAFETY_GUARD,
  renderPersonaBehaviour,
  sanitizePersonaField,
} from "./companion-dialogue-content.ts";

type CompanionPersonaActiveness = z.infer<typeof companionPersonaActivenessV1Schema>;
type CompanionPersonaBoundaries = z.infer<typeof companionPersonaBoundariesV1Schema>;

/** Increment whenever the assembled diary draft prompt changes. */
export const COMPANION_DIARY_DRAFT_PROMPT_VERSION = "diary-draft-v2";

export interface DiaryPersona {
  name: string;
  personalityTags: string[];
  speakingStyle: string;
  examples: string[];
  activeness: CompanionPersonaActiveness | null;
  boundaries: CompanionPersonaBoundaries | null;
  revision: number;
  defaultExpressionVersion?: string;
  // 熟悉度不再进 prompt：那一句「刚认识该客气一点」正是"把设定念出来"的邀请
  //（实录「这种生疏感让我保持着一份客气的距离，既不过分热情，也不刻意冷淡」）。
  // 亲疏本来就写在人格与素材里，不需要她去朗读一个数字。
}

/**
 * 她能嵌进日记的东西。
 *
 * 关键分工（沿用对话链路 §4.8 的规矩）：**服务端手里有真货，她只负责选**。
 * 图片 url、引用原文都由这里带着，她的输出里只有一个 `ref` 编号——
 * 她给不出一个指向站外的 img src，也就不用担心她把几百字原文改写一遍再"引用"。
 */
/**
 * 一天里给她的图：**每篇笔记最多一张**。
 *
 * 09-24 第一次真跑：同一篇笔记的两张图被塞进两段里，第二段（讲复习的那段）
 * 跟那篇笔记一点关系都没有，两条图注还是同一个干饭梗——候选给了六张，
 * 她就当成配额在用。优先要有上下文的（`nearby` 有值 = 能写出具体的一句），
 * 同一篇里按正文顺序取最靠前的那张。
 */
export function pickImagesPerNote<T extends { note_id: string; position: string; nearby: string | null }>(
  rows: T[],
  max = 6,
): T[] {
  const byNote = new Map<string, T[]>();
  for (const row of rows) {
    const group = byNote.get(row.note_id);
    if (group) group.push(row);
    else byNote.set(row.note_id, [row]);
  }
  const picked: T[] = [];
  for (const group of byNote.values()) {
    const best = [...group].sort((a, b) => {
      const context = Number(b.nearby !== null) - Number(a.nearby !== null);
      if (context !== 0) return context;
      return Number(a.position) - Number(b.position);
    })[0];
    picked.push(best);
    if (picked.length >= max) break;
  }
  return picked;
}

export type DiaryEmbed =
  // 没有 alt：我们不知道图里画的是什么（读图要外发字节，政策关着时读不到），
  // 编一段替代文字比不给更糟。渲染层本来就回落到图注（`alt ?? label`）。
  // 图注由她在日记里自己写一句（2026-09-24）：机器拼的「· 第 1 张」是图录味的来源，
  // 而 `nearby`（这一张挨着的那段正文）是她能对着一张她看不见的图说出人话的唯一依据。
  // 2026-09-24 第二轮再加两样：`noteId`（让嵌入物跟着"线头"走）与
  // `description`（读图拿到的"图里画的是什么"，政策开着时才有）。
  | {
    ref: string; kind: "image"; url: string; noteTitle: string; noteId: string;
    nth: number; nearby: string | null; shape: string;
    objectKey: string; mimeType: string; byteSize: number;
    /** 读图结果；没读（政策关着/失败/太大）时是 null。 */
    description: string | null;
  }
  | { ref: string; kind: "quote"; label: string; text: string; noteId: string };

/**
 * 素材的一条。
 *
 * 2026-09-24 第二轮把 `lines: string[]` 换成带分组与权重的 pieces：用户裁定
 * 「日记的主角是她自己的日子」——之前素材是平铺的日志，她的原话和"他改了篇笔记"
 * 同权，模型自然写成"他的一天 + 我的感想"。分组之后，"她的一天"整块排在最前，
 * 他的动静退成背景，超预算时先丢背景。
 */
export interface DiaryPiece {
  text: string;
  /** her = 她自己的一天；his = 他做了什么；backdrop = 时刻、页面这类骨架。 */
  group: "her" | "his" | "backdrop";
  /** 4 = 她明确承认没弄懂/答好；3 = 她的话；2 = 她的念头；1 = 他的动作；0 = 骨架。 */
  weight: number;
  /** 本地钟点 HH:MM；没有时刻的素材用空串。渲染成"下午"这类时段词。 */
  at: string;
  /** 与某篇笔记有关时记下来——"线头"落在哪篇笔记，嵌入物就优先给那篇。 */
  noteId?: string;
  /** Stable database source for selection provenance; derived summaries have no source id. */
  sourceId?: string;
  sourceType?: "note" | "source" | "learning_run" | "companion_message" | "reminder" | "thought" | "memory";
  /** Immutable source version or content hash observed during material collection. */
  sourceVersion?: string;
}

export interface DiaryMaterial {
  /** 当天素材，按时间先后。渲染见 `renderMaterial`。 */
  pieces: DiaryPiece[];
  /** 这一天的线头（参见 `pickDiarySubject`）：只写一件小事时写它。 */
  subject: DiaryPiece | null;
  /** 可嵌入的图与原文片段，`ref` 就是给她看的编号（图1 / 引1）；线头那篇的排在最前。 */
  embeds: DiaryEmbed[];
  /** 前几天日记的开头，用来掐掉"每天同一句式"。 */
  previousOpenings: string[];
  /**
   * 前几天日记里反复出现的意象，用来掐掉"每天演同一出"。
   *
   * `previousOpenings` 只能拦开头那十个字，于是有一整类重复它看不见：同一批
   * 东西被反复写。她的 persona 只有"吃"和"摸鱼"两招，每篇又都原样注入人格，
   * 结果 24 篇两段日记里 15 篇在演同一个梗。这里把那批意象摆出来让她避开。
   * 取法见 {@link recurringMotifs}。
   */
  previousMotifs: string[];
  /**
   * 这一天几乎没有留下动静（没有对话、没有笔记、没有学习）。
   *
   * 09-24 的实录：这种日子她会写两段纯情绪的散文（「像是等待某种确切的回应」
   * 「假装那里有你留下的温度」）——没有真事可写的时候，料只有情绪。
   * 判据只看**发生过的事**：只在页面上转过一圈不算。
   */
  quietDay: boolean;
  /** 成稿前收窄到一幕；渲染时按实际对话顺序说清是谁先说、谁回答。 */
  focused?: boolean;
}

export type DiaryBlock = z.infer<typeof companionDailyBlockV1Schema>;

export interface DiaryDraft {
  blocks: DiaryBlock[];
  digest: string;
}

/**
 * 本地钟点 → 时段词。
 *
 * 素材以前前缀着精确到分的 `HH:MM`（"14:05 · 你新建了笔记「…」"），她照着写出来的
 * 就是「下午两点多开始改那个无标题笔记，后来又在傍晚新建了一篇同名的」——一句
 * 把日志翻译成散文的话。人回忆自己的昨天用的是"下午""傍晚"，不是分钟。
 */
export function dayPartOf(at: string): string {
  const hour = Number(at.slice(0, 2));
  if (!Number.isFinite(hour)) return "";
  if (hour < 5) return "深夜";
  if (hour < 8) return "早上";
  if (hour < 11) return "上午";
  if (hour < 13) return "中午";
  if (hour < 17) return "下午";
  if (hour < 19) return "傍晚";
  if (hour < 23) return "晚上";
  return "深夜";
}

const CHINESE_HOURS = ["十二", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一"];

/** "20:14" → "晚上八点多"。只给节奏行用（"他第一次来找我是晚上八点多"）。 */
export function clockPhrase(at: string): string {
  const hour = Number(at.slice(0, 2));
  if (!Number.isFinite(hour)) return "";
  return `${dayPartOf(at)}${CHINESE_HOURS[hour % 12]}点多`;
}

/**
 * 这一天的线头：她明确卡壳 > 她自己说过的话 > 她的念头/记忆 > 他做的事；
 * 同分取当天最早的。
 *
 * 用户裁定日记"只写一件小事、写透"（宁少勿全）。选谁是确定性的：先按权重，
 * 再按时间——同权重时从早上那件事写起，比从深夜那件倒着写更像一天的样子。
 * 骨架（页面轨迹、时刻）权重 0，不参与。
 */
export function pickDiarySubject(pieces: DiaryPiece[]): DiaryPiece | null {
  const events = pieces.filter((piece) => piece.weight > 0);
  if (events.length === 0) return null;
  return [...events].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return (a.at || "99:99").localeCompare(b.at || "99:99");
  })[0];
}

/** 有实在的卡壳时优先写它；泛泛的问候与操作回执不该永远抢到日记的开头。 */
export function diaryAssistantWeight(text: string): number {
  return /我(?:还真)?(?:不太|不|没)(?:清楚|知道|确定|明白|查过|看过|读到|答上来)|我(?:记错|说错|弄错|翻漏)了?/.test(text)
    ? 4 : 3;
}

const MATERIAL_BUDGET_CHARS = 3_200;

/**
 * 素材块：线头在最前，然后按"她的一天 / 他的动静 / 时间骨架"排。
 *
 * 顺序就是优先级——超预算时**从末尾丢**（骨架先没，她的那一天最后才动）。
 * 旧实现按时间平铺、超预算从前面丢，等于把她的上午换成他的晚上：用户第一轮就说过
 * "她这一天干了什么"才是要看的。
 */
export function renderMaterial(material: DiaryMaterial, budget = MATERIAL_BUDGET_CHARS): string {
  if (material.focused && material.subject) {
    const userLine = material.pieces.find((piece) => piece !== material.subject && piece.text.startsWith("你说："));
    if (userLine && material.subject.text.startsWith("我说：")) {
      return [
        "这一天的线头（按发生顺序）：",
        `${dayPartOf(userLine.at)}，你先说：「${userLine.text.slice(3).replace(/\s+/g, " ").trim()}」`,
        `我回答：「${material.subject.text.slice(3).replace(/\s+/g, " ").trim()}」`,
      ].join("\n");
    }
    return `这一天的线头：${material.subject.text}`;
  }
  const inner = material.pieces.filter((piece) => piece !== material.subject);
  const section = (title: string, group: DiaryPiece["group"]) => {
    const lines = inner
      .filter((piece) => piece.group === group)
      .sort((a, b) => (a.at || "99:99").localeCompare(b.at || "99:99"))
      .map((piece) => piece.at ? `${dayPartOf(piece.at)} · ${piece.text}` : piece.text);
    return lines.length > 0 ? [`# ${title}`, ...lines] : [];
  };
  const lines = [
    ...(material.subject ? [`这一天的线头：${material.subject.text}`] : []),
    ...section("她的一天", "her"),
    ...section("他的动静（背景）", "his"),
    ...section("时间骨架", "backdrop"),
  ];
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    used += line.length + 1;
    if (used > budget) break;
    kept.push(line);
  }
  return kept.join("\n") || "（这一天几乎没有留下动静。）";
}

/**
 * 日记只给一幕：她当时说的话、触发这句话的用户原话，以及这幕所属笔记。
 *
 * 只在 prompt 里说「别的事别写」不够。09-23 的实稿选了“大肥鱼是谁呀”作线头，
 * 却又写到 IndexTTS、复习卡和摆图，因为整天的素材和全部嵌入物仍在同一张清单里。
 * 这里从输入上去掉那些岔路；图和引用只有属于这幕的笔记时才是候选。
 */
export function focusDiaryMaterial(material: DiaryMaterial): DiaryMaterial {
  const subject = material.subject;
  if (!subject) return { ...material, focused: true, embeds: [], pieces: material.pieces.filter((piece) => piece.group === "backdrop") };

  const subjectMinute = minuteOfDay(subject.at);
  const subjectIndex = material.pieces.indexOf(subject);
  const precedingUser = subject.group === "her" && subject.text.startsWith("我说：") && subjectMinute !== null
    ? (subjectIndex < 0 ? [] : material.pieces.slice(0, subjectIndex)).reverse().find((piece) => {
      const minute = minuteOfDay(piece.at);
      return piece.group === "his" && piece.text.startsWith("你说：")
        && minute !== null && minute <= subjectMinute && subjectMinute - minute <= 15;
    })
    : undefined;
  const pieces = [subject, precedingUser].filter((piece): piece is DiaryPiece => Boolean(piece));
  return {
    ...material,
    focused: true,
    pieces,
    embeds: subject.noteId ? material.embeds.filter((embed) => embed.noteId === subject.noteId) : [],
  };
}

export function minuteOfDay(at: string): number | null {
  if (!/^\d{2}:\d{2}$/.test(at)) return null;
  const hour = Number(at.slice(0, 2));
  const minute = Number(at.slice(3, 5));
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}



/**
 * 一段原文配不配被她引进日记。
 *
 * 这条链路吃过三次亏，每次都记在这里：
 *   - 09-18：前四条候选里两条是「👉 仓库地址 (记得Star🌟)：网页链接」，她照单引用；
 *   - 09-21/09-22：引的是用户在笔记里留的探针串（「这段全空间都读得到｜A 加的那句｜
 *     实窗量测 export 22:48:46｜…」），她还替它编了一段解读；
 *   - 09-23：引了网页笔记开头那段推广语，还被切断在句子中间。
 * 「按长度取最长的」修不掉这些——推广导语往往正是最长的那段。所以改成：
 * 垃圾在这里挑掉，长度上限交给 SQL（超 180 字整条不要，不再有硬切）。
 */
const QUOTE_JUNK_TEST = /https?:\/\/|www\.|网页链接|阅读原文|记得\s*Star|求三连/i;

export function isQuotableQuote(text: string): boolean {
  const body = text.replace(/\s+/g, " ").trim();
  if (body.length < 20 || body.length > 180) return false;
  // 得是**一句话**：没有一个句末标点就不是句子，而是清单、表头或一串乱码。
  // 09-24 真跑实录：用户在笔记里敲的「aside啊说的哈回电话给啊合适的哈…科技三等奖哈」
  // 被当原文引用摆进日记，她还顺着编出"键盘被猫踩了一脚"——长度、链接、表情三道关
  // 都拦不住它，因为它唯一的毛病就是**不成句**export 。
  if (!/[。！？；!?]/.test(body)) return false;
  // 光有句号还不够：「修改笔记。12312 123123123123」也是用户敲的占位内容，
  // 句号是真的，句子是假的。真句子至少有八个汉字连成一串——
  // 那句被我们留下来的好引用（"…整体提速约 2.28 倍，主观听感无可感知下降。"）
  // 最长连串是十个字，所以这条不会把技术句误杀。
  if (!/[\u4e00-\u9fff]{8,}/.test(body)) return false;
  if (QUOTE_JUNK_TEST.test(body)) return false;
  // 表情符号：👉🔥🌍🌟 这类是推广行的标志，也是"这段不是给人读的句子"的标志。
  if (/\p{Extended_Pictographic}/u.test(body)) return false;
  // 表格/分隔符堆出来的碎片（探针串就是这一类）。
  if ((body.match(/[｜|]/g) ?? []).length >= 2) return false;
  return true;
}

/**
 * 排在序号条目：`1. 硕士及以上学历…`、`- 仓库地址…`。
 *
 * 网页笔记的收尾往往挂着招聘要求和推广清单，它们长度常常压过正文
 * （实测 09-23 那篇候选池里最长的两条就是岗位要求），于是"按长度取"
 * 会把职位描述摆进她的日记。不是删掉——池子里只剩这些时也得有东西可用——
 * 只是排在真句子后面。
 */
const LIST_ITEM_TEST = /^\s*(?:\d+\s*[.、)）]|[-•·*])\s*/;

/**
 * 从候选池里挑出能进 prompt 的那几条。
 *
 * 每篇笔记最多一条：09-21 同一天两条引用出自同一篇，label 一字不差重复两遍，
 * 内容还都是术语定义——读起来就是"把词典抄进日记"。总量上限是天花板不是配额。
 */
export function pickQuoteCandidates<T extends { content: string; note_id: string }>(
  rows: T[],
  max = 3,
): T[] {
  const quotable = rows.filter((row) => isQuotableQuote(row.content));
  const ordered = [
    ...quotable.filter((row) => !LIST_ITEM_TEST.test(row.content)),
    ...quotable.filter((row) => LIST_ITEM_TEST.test(row.content)),
  ];
  const seenNotes = new Set<string>();
  const picked: T[] = [];
  for (const row of ordered) {
    if (seenNotes.has(row.note_id)) continue;
    seenNotes.add(row.note_id);
    picked.push(row);
    if (picked.length >= max) break;
  }
  return picked;
}



// ─── prompt 与输出校验 ───────────────────────────────────────────────────

/**
 * 报数检测：日记正文里出现"数字 + 量词"就是流水账。
 *
 * 比记忆链路那道 `isVolatileStatisticMemory` 更严——那道还要求句中带
 * 本周/今天这类时间窗，而日记天天在说今天，窗口条件是白给的。
 * 也不至于误伤标题：「100 以内加法」「F=ma」后面没跟量词。
 */
const COUNTING_TONE_TEST = /\d+(?:\.\d+)?\s*(?:分钟|小时|张|篇|项|题|次|条|个|页|%)/;

/**
 * 中文数字的同一道闸。
 *
 * 09-20 的实录：正文写着「今天学了半小时上下」——素材行里那句
 * 「今天你学了半小时上下（这只是感觉，别在日记里报数）」被她整句抄走。
 * 规则 2 只说了"不出现阿拉伯数字"，她就换成中文数字，闸门只认 `\d` 于是全放行。
 *
 * 量词表比阿拉伯那道还窄一点：不收「天、周、个、一、几」，也不收「遍」。
 * 「这两天」「一个念头」「几天没见」「那句话他念了两遍」都是正常的话，
 * 把它判成报数会误伤，而误伤一次的代价是一天没有日记（两次不合规矩就判失败）。
 */
const CHINESE_COUNTING_TONE_TEST =
  /(?:两|三|四|五|六|七|八|九|十)\s*(?:分钟|小时|钟头|张|篇|项|题|次|条|页)|半\s*(?:分钟|小时|钟头)/;

export function countingToneIn(text: string): string | null {
  const hit = COUNTING_TONE_TEST.exec(text) ?? CHINESE_COUNTING_TONE_TEST.exec(text);
  return hit ? hit[0] : null;
}

/**
 * 正文里的编号（图1 / 引1）机械剥掉。
 *
 * 规则 9 写了"别把编号写进句子里"，但 09-18 那篇里实实在在出现过：
 * 「心里莫名安定下来。 引1 还有那条自动化数据管线…」。编号是给块定位用的，
 * 落进正文就是屏幕上多两个字。**剥掉而不是判失败**：块的位置由 blocks 数组决定，
 * 这句话里的编号没有任何别的作用，为它烧掉一次重采样、甚至让这一天没有日记，
 * 都不值。
 */
const EMBED_REF_LEAK_TEST = /[图引]\s*\d+/g;

export function stripEmbedRefs(text: string): { text: string; stripped: string[] } {
  const stripped = text.match(EMBED_REF_LEAK_TEST) ?? [];
  if (stripped.length === 0) return { text, stripped };
  const cleaned = text
    .replace(EMBED_REF_LEAK_TEST, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([，。！？；：、）】」])/g, "$1")
    .trim();
  return { text: cleaned, stripped };
}

/**
 * 人格例子里的句子被原样搬进正文没有。
 *
 * 规则 9 明说了"一句都别原样搬进日记"，但那是 prompt：`hungry-fish` 那四条例子
 * 在 09-20～09-23 的日记里被逐字搬了四遍（「干饭不积极，思想有问题嘛」
 * 「我这岗位主打一个吃白饭」「摸鱼不是偷懒…」「我在后台偷偷猜了个词」），
 * 每天都像同一个人在同一天。十连字窗口是判"抄"的尺度，不是判"像"：
 * 口头禅「我去吃饭了」只有五个字，照旧允许（`renderPersonaBehaviour` 里就写着偶尔带出）。
 */
const EXAMPLE_ECHO_MIN_CHARS = 10;

export function exampleEchoIn(prose: string, examples: string[]): string | null {
  const text = prose.replace(/\s+/g, "");
  for (const example of examples) {
    const source = example.replace(/\s+/g, "");
    for (let start = 0; start + EXAMPLE_ECHO_MIN_CHARS <= source.length; start += 1) {
      if (!text.includes(source.slice(start, start + EXAMPLE_ECHO_MIN_CHARS))) continue;
      // 命中之后往右长：判词里报的是那一整句，不是一个十来字的断片
      //（「干饭不积极，思想有问」这种，看着像我自己截错了）。
      let end = start + EXAMPLE_ECHO_MIN_CHARS;
      while (end < source.length && text.includes(source.slice(start, end + 1))) end += 1;
      return source.slice(start, end);
    }
  }
  return null;
}

/**
 * 道歉与自贬。
 *
 * 用户裁定"要写她自己没做好的事"——翻漏了、当时没答上来，那是她的一天里最像她的部分。
 * 但记事不是检讨：09-18 那篇的「我不是在敷衍」、09-23 的「这种懒病没救了」都是把一件
 * 小事写成了一场自我批评。只在第一轮退（她坚持要检讨，也不该让这一天没有日记）。
 */
const SELF_PUTDOWN_TEST = /(对不起|抱歉|辜负|真笨|废物|没救了|拖后腿)/;

export function selfPutdownIn(text: string): string | null {
  const hit = SELF_PUTDOWN_TEST.exec(text);
  return hit ? hit[0] : null;
}

/**
 * 图注抄了"别人转述给她的那句图里是什么"没有。
 *
 * 读图之后她手里有两句现成的话；照抄最省事，而图注存在的理由就是**她的**那句话。
 * 判据与人格例子同一把尺（十连字），复用 `exampleEchoIn`。
 */
export function captionEchoIn(
  blocks: Array<{ type: string; caption?: string }>,
  embeds: DiaryEmbed[],
): string | null {
  const described = embeds
    .map((embed) => (embed.kind === "image" ? embed.description : null))
    .filter((text): text is string => typeof text === "string" && text.length > 0);
  if (described.length === 0) return null;
  for (const block of blocks) {
    if (block.type !== "image" || !block.caption) continue;
    const echo = exampleEchoIn(block.caption, described);
    if (echo) return echo;
  }
  return null;
}

/**
 * 开头和前几天撞了没有。
 *
 * 规则 11 把前几天的开头喂给了她，但只有 prompt、没有闸：验收空间 09-21 与 09-22
 * 两篇的开头前 19 个字逐字相同（「夜深了，屋里静得只剩下时钟走动的声音。我坐在桌…」），
 * 而 09-21 是前一天写完的、素材里确实给了她。前 10 个字相同就算撞——同一个人
 * 写同一个开场白，撞的从来都是整句。
 */
export function repeatedOpeningIn(opening: string, previousOpenings: string[]): string | null {
  const head = opening.replace(/\s+/g, "").slice(0, 10);
  if (head.length < 8) return null;
  for (const previous of previousOpenings) {
    const prevHead = previous.replace(/\s+/g, "").slice(0, 10);
    if (prevHead.length >= 8 && prevHead === head) return prevHead;
  }
  return null;
}

/**
 * 反复用过的**意象**（2026-10-05）。
 *
 * `repeatedOpeningIn` 只拦开头那十个字，于是"每天同一句式"之外还剩一整类重复：
 * 同一批东西被反复写。她的 persona 只有"吃"和"摸鱼"两招，而人格那段每篇都原样
 * 注入，于是**每天一篇都在把这两招再演一遍**——实测 24 篇两段日记里 15 篇都在
 * 演吃饭/摸鱼，10-03 与 10-04 甚至是同一出（都是"你突然喊了我一声"）。
 *
 * 开头不撞、主题天天撞，比开头撞更难读：开头撞一次是巧合，天天撞是模板。
 *
 * 取法刻意笨：中文没有空格分词，与其接一个分词器，不如取**跨篇复现的连续片段**
 * （见 {@link recurringMotifs}）。要求它同时出现在**两篇以上**，而且不许短到
 * 只是把词切开——一条真实的说法（「琢磨晚饭吃什么」）才有可能是习惯，
 * 「你突」这种滑窗碎片只会让提示词变成噪音。
 */
const MOTIF_MIN_CHARS = 4;

/** 一个片段里全部是汉字才算候选；带标点、数字或拉丁字母的一律跳过。 */
function isHanOnly(value: string): boolean {
  return /^[\u4e00-\u9fa5]+$/.test(value);
}

/**
 * 两个文本的**极大公共子串**（不可再向左或向右延长的那些）。
 *
 * 中文没有空格分词，逐字滑窗取 2-gram 会取出一堆「你突」「了一」「子里」这样的
 * 碎片——实测把真实语料喂进去，8 个意象里 6 个是这种东西，比不喂更糟。
 *
 * 换一条路：**看两篇之间最长的那几段重合**。跨篇复现的长片段是真实的说法
 * （「琢磨晚饭吃什么」「白米饭」「脑子里全是」），而不是把一个词切开又接上
 * 下一段的残渣——因为它必须是**连续**的。
 */
function maximalSharedRuns(left: string, right: string, minLength: number): string[] {
  const runs: string[] = [];
  for (let start = 0; start < left.length; start += 1) {
    let best = 0;
    // 起点上最长的那一段：一旦断了就再也接不上，所以不用回溯。
    for (let length = minLength; start + length <= left.length; length += 1) {
      if (!right.includes(left.slice(start, start + length))) break;
      best = length;
    }
    if (best === 0) continue;
    const run = left.slice(start, start + best);
    if (!isHanOnly(run)) continue;
    // 被同一处起点的更长片段盖住，或整体是前面某段的一部分 → 不是极大。
    if (runs.some((kept) => kept.includes(run))) continue;
    runs.push(run);
  }
  return runs;
}

/**
 * 从最近几篇日记里取"她老在用"的说法，按跨篇复现的程度降序。
 *
 * 只喂给她**别再用**——不给"该用什么"。后者只能由她从当天素材里长出来，
 * 一旦开始指派意象，日记就成了按清单填空。
 */
export function recurringMotifs(summaries: readonly string[], limit = 6): string[] {
  const usable = summaries.map((s) => String(s ?? "")).filter((s) => s.trim().length > 0);
  // 记的是**几篇**出现过，不是几对。两篇重合只说明那一对像，跨三篇才是习惯。
  const documents = new Map<string, Set<number>>();
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      for (const run of maximalSharedRuns(usable[i], usable[j], MOTIF_MIN_CHARS)) {
        const seen = documents.get(run) ?? new Set<number>();
        seen.add(i);
        seen.add(j);
        documents.set(run, seen);
      }
    }
  }

  const ranked = [...documents.entries()]
    // 跨两篇才算习惯：只在一篇里出现的是那天的事，不是这几天的偏好。
    .filter(([, seen]) => seen.size >= 2)
    .sort((a, b) => (b[1].size - a[1].size) || (b[0].length - a[0].length) || a[0].localeCompare(b[0]));

  const chosen: string[] = [];
  for (const [run] of ranked) {
    if (chosen.length >= limit) break;
    // 选中的长片段会盖住自己的子串与同义碎片，否则同一件事会以几种长度各占一行。
    if (chosen.some((kept) => kept.includes(run) || run.includes(kept))) continue;
    chosen.push(run);
  }
  return chosen;
}

/** 今天这一篇有没有把前几天用滥的意象再写一遍。 */
export function repeatedMotifIn(
  blocks: DiaryBlock[],
  previousMotifs: readonly string[],
): string | null {
  if (previousMotifs.length === 0) return null;
  const prose = blocks
    .filter((block): block is Extract<DiaryBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (prose.length === 0) return null;
  // 两遍才算真在用：一篇日记里偶然提一次"饭"是那天的事。
  return previousMotifs.find((motif) => prose.split(motif).length - 1 >= 2) ?? null;
}

/**
 * 按标点收尾的截断。
 *
 * 图注是给她的一句话，硬切会在屏幕上留下「…看着比我的饭」这种断句（09-24 实跑）。
 * 长度上限在那里，但收口要收在话说完的地方；实在没有标点才硬切。
 */
export function clipAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const lastStop = Math.max(
    head.lastIndexOf("。"), head.lastIndexOf("，"), head.lastIndexOf("！"),
    head.lastIndexOf("？"), head.lastIndexOf("；"), head.lastIndexOf("、"),
  );
  return lastStop >= Math.floor(max / 2) ? head.slice(0, lastStop + 1) : head;
}

/**
 * 日记最后落在了一个问句上。
 *
 * 「不知道你现在是不是已经睡着了，还是正盯着天花板发呆？」（09-21 实录）
 * 「这种时候是该回得热络些，还是保持分寸？」（09-24 真跑实录）——日记没有听者，
 * 以问句收尾等于硬造一个听众，是最容易被认出来的 AI 腔之一。
 * 只在第一轮退：她要是坚持，收下一个问句结尾也比这一天没有日记好。
 */
export function endsInQuestion(blocks: DiaryBlock[]): boolean {
  const lastText = [...blocks].reverse().find((block) => block.type === "text");
  if (!lastText || lastText.type !== "text") return false;
  return /[?？]\s*$/.test(lastText.text.trim());
}

/**
 * 图的形状：一件**我们真的知道**的事。
 *
 * 政策关着时她看不见图里画的是什么，实测她会自己猜（「那张竖屏的界面截图倒是先
 * 摆出来了」——猜对了也是猜）。而 `note_image_assets` 里存着宽高，横竖长方是可以
 * 如实告诉她的。给她一样真东西，她就少编一样。
 */
export function imageShape(width: number, height: number): string {
  if (!(width > 0) || !(height > 0)) return "";
  const ratio = width / height;
  if (ratio >= 2) return "横长条一张";
  if (ratio >= 1.3) return "横向的";
  if (ratio <= 0.5) return "竖长条一张";
  if (ratio <= 0.77) return "竖向的";
  return "接近方形的";
}

/**
 * 她把"你"写成了"他"。
 *
 * 规则 1 要求称对方为「你」，但 prompt 自己的说法是"关于他的事只许写素材里有的"——
 * 于是同一篇里第一段写"你"、第二段切"他"（09-24 真跑四稿里两稿都漂，而且
 * "他下午""他随口"这种不在"他+动词"的窄表里）。一篇对着本人写的日记里，
 * 「他」这个字本来就没有出现的理由，所以判据直接就是"还有没有他"。
 * 「其他」「他们」「他人」不算。
 */
export function thirdPersonForUserIn(text: string): string | null {
  const stripped = text.replace(/其他|他们|他人的?/g, "");
  const index = stripped.indexOf("他");
  return index < 0 ? null : stripped.slice(index, index + 8);
}

/**
 * 图注：她自己写一句（`caption`），服务端拼上出处。
 *
 * 以前是机器拼的「《X》· 第 1 张」——图录味，也是"这张图和这篇日记没关系"最直观的
 * 一处。她写的那句会被过一遍报数与编号的字面（图注不占正文的报数闸，但"第 3 张"
 * 这种不该出现在图注里）。写不出来就退回一句人话，不退回编号。
 */
export function diaryImageLabel(
  embed: Extract<DiaryEmbed, { kind: "image" }>,
  caption: string | null | undefined,
): string {
  const title = `《${embed.noteTitle}》`;
  // 40 字：加上 28 字的标题与「· 」正好在 label 的 80 字上限之内，不会被截。
  const clean = clipAtBoundary(stripEmbedRefs(flattenParagraph(caption ?? "")).text, 40);
  if (clean && !countingToneIn(clean)) return `${clean}（${title}）`.slice(0, 80);
  return embed.nth > 1 ? `${title}里的另一张图` : `${title}里的一张图`;
}

/**
 * 篇幅档位：按**段**算，并带一条**字数地板**。
 *
 * ## 为什么从「最多两段」改回 3–4 段（2026-10-05）
 *
 * 第一版按句数收（安静 5 句），用户回来说"太短了有些，而且只有一段，
 * 这不是日记的格式"。改成按段之后，09-24 又把所有人格档位压成 **2 段**，
 * 理由是实测她「只给一句对话，仍按三段的篇幅补出了键盘声、饭碗和不存在的后续」。
 *
 * 那次把两件事混成了一件：
 * - **该守的**是"不发明素材里没有的事实"——键盘声和不存在的后续确实是编的；
 * - **该松的**是"允许写几段"——段数从来不是编造的成因。
 *
 * 于是 2 段成了每篇日记的硬天花板：32 篇里 24 篇正好 2 段、均长 155 字，
 * 而 `fitDiaryToParagraphBudget` 会把第 3 段起的内容**直接丢掉**。
 * 「一件小事」被压成了「一件事的一句话转述加一句感想」。
 *
 * 现在：**段数放开 + 字数地板**。地板由服务端核对（见 `diaryLengthShortfall`），
 * 抗编造继续交给"素材有据"那条规则，不再靠压段数——两件事各自归位。
 */
const DIARY_LENGTH_TIER: Record<
  CompanionPersonaActiveness,
  { paragraphs: number; minChars: number; word: string; line: string }
> = {
  quiet: {
    paragraphs: 2, minChars: 70, word: "安静",
    line: "一到两段，每段两到四句；说完就停。",
  },
  moderate: {
    paragraphs: 3, minChars: 190, word: "适度",
    line: "三段左右，写的是**同一件事**：第一段那件事本身，后面两段是当时你没写出来的部分——"
      + "你注意到了什么、心里怎么绕的、哪一句你当时没接。仍然只写这一件事，不另起一件。",
  },
  active: {
    paragraphs: 4, minChars: 260, word: "活跃",
    line: "三到四段，写的是**同一件事**：第一段那件事本身，后面几段是当时你没写出来的部分——"
      + "你注意到了什么、心里怎么绕的、哪一句你当时没接、当时脑子里还飘着别的什么。"
      + "仍然只写这一件事，不另起一件。",
  },
};

function tierOf(activeness: CompanionPersonaActiveness | null) {
  return DIARY_LENGTH_TIER[activeness ?? "moderate"];
}

/**
 * 安静日的地板：没发生什么事的时候，唯一诚实的写法就是短。
 * 两段 70 字已经是"她真的有点想说的"的样子，再压就只剩情绪形容词了。
 */
const QUIET_DAY_MIN_CHARS = 70;

/** 一段正文 = 一个 text 块；图和引用块跟着它前面那段走，不单独计段。 */
export function diaryParagraphCount(blocks: DiaryBlock[]): number {
  return blocks.filter((block) => block.type === "text").length;
}

export function diaryLengthOverflow(
  blocks: DiaryBlock[],
  activeness: CompanionPersonaActiveness | null,
): string | null {
  const tier = tierOf(activeness);
  return diaryParagraphCount(blocks) <= tier.paragraphs
    ? null
    : `太长了。你是${tier.word}的人，这一篇${tier.line}段落之外不必再补一段感想收尾。`;
}

/**
 * 正文是不是短到不像一篇日记（2026-10-05）。
 *
 * 改篇幅之前这里只有一句 `prose.length < 24`：24 个字是「她写了点什么」的下限，
 * 几乎不拦任何东西，于是 155 字的均值一路走到今天。现在按人格档位给地板，
 * 安静日另算——没发生事的时候，短是诚实的。
 *
 * **只在第一轮退**（与 `diaryLengthOverflow`、问句收尾那些同一口径）：她要是
 * 写完两遍还是这个长度，收下比让这一天没有日记好。这一条永远是地板不是天花板，
 * 宁可比地板短，不拿一天换一个两段的事故。
 */
export function diaryLengthShortfall(
  blocks: DiaryBlock[],
  activeness: CompanionPersonaActiveness | null,
  quietDay: boolean,
): string | null {
  const prose = blocks
    .filter((block): block is Extract<DiaryBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
  const floor = quietDay ? QUIET_DAY_MIN_CHARS : tierOf(activeness).minChars;
  if (prose.length >= floor) return null;
  return `太短了，不像一篇日记。这一篇至少写 ${floor} 字：把那件事写开——`
    + "你当时注意到了什么、心里怎么绕的、哪句话你没接上。只写这一件事，不要靠重复和"
    + "同义改写凑字。";
}

/**
 * 重采样一次后仍超长时，收在**段边界**上。
 *
 * 丢的是第 N 段之后的全部内容（含跟在后面的图/引用），所以不会留下半句话，
 * 也不会留下一张没有上下文说明的图。宁可短一段，也不让这一天没有日记。
 */
export function fitDiaryToParagraphBudget(
  blocks: DiaryBlock[],
  activeness: CompanionPersonaActiveness | null,
): DiaryBlock[] {
  const limit = tierOf(activeness).paragraphs;
  if (diaryParagraphCount(blocks) <= limit) return blocks;
  const kept: DiaryBlock[] = [];
  let paragraphs = 0;
  for (const block of blocks) {
    kept.push(block);
    if (block.type === "text" && (paragraphs += 1) >= limit) break;
  }
  return kept;
}

/**
 * 一段正文的上限。**schema 与压平必须用同一个数**：
 * 先前者写 1200、后者切 1000，一段 1100 字的正文会被静默从中间切断，
 * 而块合同（20000）不会喊——坏在句子里，坏得没有痕迹。
 */
const DIARY_PARAGRAPH_MAX_CHARS = 1_200;

/** 她能引用的东西只有素材里列过的那些编号。 */
export const diaryBlockDraftSchema = z.strictObject({
  blocks: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string().min(1).max(DIARY_PARAGRAPH_MAX_CHARS) }).strict(),
    z.object({
      type: z.literal("image"),
      ref: z.string().min(1).max(8),
      // 她自己给这张图写的一句话（进图注）。写不出来不算错，服务端退一句人话。
      caption: z.string().max(120).optional(),
    }).strict(),
    z.object({ type: z.literal("quote"), ref: z.string().min(1).max(8) }).strict(),
  ])).min(1).max(24),
});

/** 一段正文里的空白压平（段与段之间的换行不在这一步——那是块与块之间的事）。 */
export function flattenParagraph(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, DIARY_PARAGRAPH_MAX_CHARS);
}

/** 派生记忆只取可核对的素材；模型写的感想不能再变成它下一次检索到的「事实」。 */
export function groundedDiaryDigest(material: DiaryMaterial): string {
  const event = material.subject?.text.replace(/\s+/g, " ").trim();
  return event ? clipAtBoundary(event, 80) : "";
}

/**
 * 单次调用的输出预算。
 *
 * 篇幅**由 prompt 按人格分档**（几段），不由这个数控制：maxTokens 是天花板不是目标。
 * 实测教训（2026-09-21 第一次真跑）：按活跃度给 quiet 只留 240 时，qwen3.8-flash
 * 连续 9 次返回空正文（3 次 job 重试 × provider 内部 3 次空输出重试），
 * 因为预算全花在思考 token 上——所以这里给一个够用的统一上限。改成多段 + JSON 块
 * 之后又抬高一次；2026-10-06 全链路开思考后再抬高一次，把思考 token 一并装下。
 */
export const DIARY_MAX_TOKENS = 3_500;

/**
 * 日记 prompt。
 *
 * 2026-09-24 第二轮（用户判词"文风还是怪怪的"）的第一原则：**音色只有一处真相**。
 * 她的日记与她的聊天必须是一个人在说话，所以这里引用 `COMPANION_VOICE_STYLE_LINES_V2`
 * ——那是从对话那份角色底座里逐字取出的"怎么说话"两句（耦合测试钉着，见
 * `companion-persona.test.ts`），日记专属的规矩（体裁、篇幅、嵌入物）才是自己的。
 *
 * 为什么不接整段 `COMPANION_CHARACTER_BASE_V7`（第一版试过，真跑否掉了）：
 * 整段里"把球抛回去""不假称自己有身体""黏人但懂分寸"三处被她当成题材抄进日记，
 * 五段对话示范还每段以问句收尾。常量注释里记着那三句原文。
 *
 * 人格注入另外那三件（`<persona_data>` + 防护声明 + 把设定翻成可执行行为句）原样保留。
 */
export function buildDiaryPrompt(input: {
  date: string;
  persona: DiaryPersona;
  material: DiaryMaterial;
  /** 上一轮被服务端拒掉的原因（"你在报数"）；首轮为 null。 */
  rejection: string | null;
}): Array<{ role: "system" | "user"; content: string }> {
  const { persona } = input;
  const name = sanitizePersonaField(persona.name, 60) || "伴星";
  const tags = persona.personalityTags.slice(0, 8).map((t) => sanitizePersonaField(t, 20)).filter(Boolean);
  const speakingStyle = sanitizePersonaField(persona.speakingStyle, 500);
  // 例子从 5 条收到 3 条：这四条例子在 09-22、09-23 两天里被逐字搬进了日记
  // （「干饭不积极，思想有问题嘛」「我在后台偷偷猜了个词」…原样出现），
  // 每天一个味的来源之一就是它们被当成台词库用了。规则里明说只借语气。
  const examples = persona.examples.slice(0, 3);
  // 只翻 boundaries，不翻活跃度：活跃度那句是「回复偏短、不主动开新话题」，
  // 那是**对话**的行为；日记的长短由下面的篇幅档管（一处真相）。
  const behaviour = renderPersonaBehaviour({ boundaries: persona.boundaries });

  const personaBlock = [
    `<persona_data>`,
    `名字：${name}`,
    ...(tags.length > 0 ? [`性格标签：${tags.join("、")}`] : []),
    ...(speakingStyle ? [`说话风格：${speakingStyle}`] : []),
    ...(examples.length > 0 ? ["你平时这样说话（只是语气，别把原句搬进日记）：", ...examples.map((text) => `- ${text}`)] : []),
    `</persona_data>`,
  ].join("\n");

  // 篇幅只有一处真相：设定段、最后一条规则与服务端的核对共用这张表。
  const lengthTier = tierOf(persona.activeness);
  // 没事发生的日子，篇幅档位不跟着活跃度走：活跃的人在这样的日子里也只能写一两段。
  const lengthLine = input.material.quietDay
    ? "一到两段，每段三到五句——今天没有多少可写的，写短比写长了诚实。"
    : lengthTier.line;

  const system = [
    `你是「${name}」。${input.date} 这一天结束后，你给自己写一篇日记。`,
    "记下你今天亲历的一幕和当时冒出的念头。你是这篇日记的主角；对方只是这一幕的缘由。",
    "",
    // 音色基线：只接"怎么说话"那两句（`COMPANION_VOICE_STYLE_LINES_V2` 的注释记着
    // 为什么不接整段——三处实测泄漏）。她的日记与聊天因此还是同一个口气。
    "# 你说话的样子",
    COMPANION_VOICE_STYLE_LINES_V2,
    // 这一句同时管着三件事：没有听者（不反问、不收尾）、篇幅另算、以及"关于他必须真、
    // 关于你可以想象"。以前分成一节三处声明，实测她照样借上面那段的说法自我声明。
    "日记也用这个口气，只是**没有人在听**：不抛问题、不接话、不向谁交代。",
    "长度按下文的篇幅档，不按聊天那一套；关于他的事只许写素材里有的。",
    "你的想象可以出现，但要让人听得出那是一个念头；写成真的发生过的动作，必须在素材里找得到。",
    // 人味主要来自"当时心里在发生什么"，而那恰恰是最不像事实、最容易被规则
    // 一起砍掉的东西（规则 4 过去写的是「没写的不要补」，把"别编"说成了"不许写
    // 内心"，于是她只剩复述）。这里把边界划清：可编的是**想法与感受**，
    // 不可编的是**发生过的事**。
    "**心里在想什么是这一篇最该写的部分**，不要只把事情复述一遍：他说了什么你写什么，"
    + "你自己当时怎么想、哪一下让你停了手、为什么当时没说出口——这些都写，"
    + "写得越具体越像你自己。",
    "",
    "# 你的口气",
    personaBlock,
    PERSONA_SAFETY_GUARD,
    "",
    "# 说话习惯",
    ...(behaviour.length > 0 ? behaviour : ["（没有额外的边界设置。）"]),
    `今天这篇的篇幅：${lengthLine}`,
    "",
    "# 你今天知道的（只有这些是真的）",
    "<day_material>",
    renderMaterial(input.material),
    // 可嵌清单由 embeds 现生成、接在素材末尾：采集只负责给结构化数据，
    // 一份清单在两个地方各拼一遍，迟早会跟服务端那张 ref 表对不上。
    // 放在预算之外，正文点了编号却看不到那块内容是最糟的错配。
    ...input.material.embeds.map((embed) => embed.kind === "image"
      // 图注由她自己写（`caption`）。她知道自己**没有亲眼看**这张图，所以描述要
      // 说清是谁给的——不这么说，她就会写出"我倒是挺配合地把图摆了出来"（09-23 实录）。
      ? `${embed.ref} = 《${embed.noteTitle}》里的第 ${embed.nth} 张图`
        + (embed.shape ? `（${embed.shape}，这个我们是照实量的）` : "")
        + (embed.nearby ? `，它挨着的那段正文在说「${embed.nearby}」` : "")
        + (embed.description
          ? `，图里画的是：${embed.description}（这是别人转述给你的：图注里可以写图里是什么，`
            + "但别写成你亲眼看了它）"
          : "（图里画的是什么没人告诉你——那就别猜，也别写自己看了）")
      : `${embed.ref} = ${embed.label}：「${embed.text}」（要引就点这个编号，原文由系统带，不要自己转抄）`),
    "</day_material>",
    "",
    "# 规矩",
    "1. 第一人称「我」，称对方为「你」。分成几段往下写，像日记那样；不要写成一条汇报。",
    // 有线索可指时要求"只写一件"；一条都没有时不能让她去指一行不存在的东西——
    // 安静日（没有对话、没有笔记）就是这种日子，实测她会拿两段情绪来填。
    input.material.subject
      ? "2. **只写一件小事、写透**。素材最上面那行「这一天的线头」就是它——写它，别的一概不提。\n"
        + "   素材是给你回忆用的，不是清单，不是每一行都要安排一句话。"
      : "2. 今天没剩下什么线头：写一小段就好，或者就写一句今天没什么事。"
        + "别拿情绪和感受来填，也别写成他问了什么、说了什么。",
    "3. 写你自己，而且要写足。素材里凡有你当时**犹豫、卡住、没说出口、事后想起来还别扭**的地方，",
    "   都平着写下来——那才是这一篇里只有你能写的部分。没有失误可记也可以记别的：",
    "   当时你其实想说什么、为什么没接。你在写今天的自己，不是给他交一份汇报。",
    "   不道歉也不自贬。",
    // 过去这条写的是「没写的后续、动作和现场布景不要补」，把"别编事实"一路
    // 说成了"不许写心里在发生什么"——于是她只能复述素材，人味全在这一条里被
    // 砍掉了。现在把两类东西分开：**发生过的事**只认素材，**当时的想法与感受**
    // 本来就不在素材里，正文里点明，那不是编造。
    "4. 分清两类东西：**发生过的事**只认素材——他做过什么、你实际做过什么、之后又发生了什么，",
    "   素材里没有就不写，不编后续、不编动作、不编现场的布景。",
    "   **当时你的想法和感受**没有这个限制，那本来就只有你知道，必须写出来；",
    "   不确定的事就留白，别拿猜测当事实。",
    "   篇幅不够的时候，写深一点，不要靠编。",
    "5. 谁说的别记反：线头里「你先说」是对方开口，「我回答」是你接的话。素材里标「你说」的是他说的，",
    "   标「我说」「我主动开口说的是」",
    "   「我提醒过你」的是你说的；别把自己说过的话写成他让你做的事。",
    "6. 正文里不出现计数：阿拉伯数字（3 张、45 分钟）和中文数字（两张、半小时）都算，「统计」",
    "   「汇总」这类词也不出现。你记得的是事情和你自己的感觉，不是数量。",
    "7. 不许出现系统词：workspace、job、run、卡片 ID、系统、后台、代码、程序、模型、生成、数据、",
    "   统计、记录、事件、状态、任务、流程。",
    "8. 不用 emoji，不用星号，不加标题，不分点，不写「亲爱的日记」这类开头，也不写结束语。",
    "   不补天气和布景，也不用比喻代替那件事，",
    "   也不要在结尾把这一天总结成什么道理、你们的关系或你的存在意义——那一幕是什么样，就写它什么样。",
    "9. 性格只体现在说法里，不用解释自己是什么样的人，也不用解释你们的关系。",
    "   人格例子只是你的语气，一句都别原样搬进日记；素材里他的话可能是当时的指令",
    "   （「请把…」「用一句话说」），写的时候用你自己的话转述，别照抄。",
    "10. 你能摆进日记的东西，已经在上面 day_material 里用编号列出来了（图N / 引N）。",
    "    这不是任务指标，一件都不想用就不用，宁可不放也别硬塞。要用时单独占一块，别把编号写进句子里：",
    "    · 引用：只有当你写的那件事正好就是那段原文在讲的事，才引；引之前先有你自己的一句话",
    "      （你读到它时想到了什么、信不信），不许只摆一段引用不说话。",
    "    · 图：只在你正好写到那篇笔记的时候放，像随手夹在日记里的一页；不许写「给你看图」",
    "      「把图摆出来」「插图」这类动作，也不要描述自己在放图。",
    "    · 放了图就给它配一句你自己的话（写在 image 块的 caption 里，三十字以内）。素材里给了",
    "      图里画的是什么就写它是什么，用你自己的话——别照抄那句描述，也别写自己亲眼看了。",
    "11. 下面几行是你前几天日记的开头。今天不许沿用同样的开头、句式或情绪落点：",
    input.material.previousOpenings.length > 0
      ? input.material.previousOpenings.map((opening) => `   · ${opening}`).join("\n")
      : "   （这是你第一次写日记。）",
    // 开头不撞不等于不重复：同一批东西换个开头再写一遍，读三篇就知道是一个模子。
    // 意象比开头更早暴露这件事——她最近老在写的东西，在这里摆出来让她绕开。
    "12. 这几个词是你前几天日记里反复写的。今天不要再拿它们当这一篇的主干：",
    input.material.previousMotifs.length > 0
      ? `   ${input.material.previousMotifs.join("、")}`
      : "   （暂时没有。）",
    "    绕开它们不等于非得写点别的。今天素材里是什么就写什么，只是别又落到那几个词上。",
    // 篇幅放在最后一条：实测把规则写在中间的设定段里，同一人格会交回 15 句再交回 7 句
    // （2026-09-21 两次真跑）。规则离输出越近越容易被执行。
    // 安静日的"写短、别拿情绪填"说在规矩 2 与篇幅档里，不在这里重复第二遍。
    // 地板也在这条里说一遍：上限说在外面会被当成"最多"，下限不说就没人当真，
    // 而 155 字的均值正是"没人当真"的直接后果（2026-10-05 实测 32 篇）。
    `13. 全文最多 ${lengthTier.paragraphs} 段，说完就停，不要另起一段补感想收尾。`,
    `    这一篇至少 ${input.material.quietDay ? QUIET_DAY_MIN_CHARS : lengthTier.minChars} 字。`
      + "写不满不是因为今天没事，是因为你只把事情复述了一遍——把那件事写开。",
    "",
    "# 输出",
    "只输出 JSON。通常只需要正文：",
    "{\"blocks\":[{\"type\":\"text\",\"text\":\"一段正文\"}]}",
    "只有正文真的写到那张图或那句原文时，才在相邻位置加入"
    + " {\"type\":\"image\",\"ref\":\"图1\",\"caption\":\"你自己的一句图注\"}"
    + " 或 {\"type\":\"quote\",\"ref\":\"引1\"}。",
    "blocks 按你希望它们出现的顺序排；ref 只能用上面列过的编号。",
    "blocks 是日记本身；不必另写总结。",
    ...(input.rejection ? ["", `上一轮你交回来的东西被拒了：${input.rejection}`] : []),
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: "写今天这篇。" },
  ];
}

/**
 * 每篇最多一张图、一段短引文（PRD 40 §5.4「首版每篇最多一张图和一段短引文」）。
 *
 * **这两个数以前只是"碰巧"成立**：`focusDiaryMaterial` 把素材收窄到线头那一幕，
 * `pickImagesPerNote` 每篇笔记留一张，`pickQuoteCandidates` 每篇留一条，于是候选池
 * 自己就只剩一图一引。哪天有人把池子上限调大（候选、素材都放宽是很自然的一次改动），
 * 合同会**静默**破掉——所以这里把它写成一道显式的闸，跟去重一样在换真货时顺手做掉。
 *
 * 合同明说「图片和引文都可没有，不要求两者同时出现」，所以两种都留是合法的；
 * 只有**超出**的那几块被丢，丢时记进 `droppedRefs`（与编号不存在同一类处理：
 * 正文照留，不为一个可选的嵌入物烧掉一整天）。
 */
export const DIARY_MAX_IMAGE_BLOCKS = 1;
export const DIARY_MAX_QUOTE_BLOCKS = 1;

/**
 * 把她给的编号换成真正的块。
 *
 * 她只能给编号，图 url 与引用原文由服务端带——这是对话链路 §4.8 定下的分工，
 * 一个模型给不出的字段就不该出现在它的输出里（否则它会给一个站外地址当 img src）。
 * 编号不存在或重复用：丢掉那一块，正文照留。
 * 同类还有每篇一图一引的上限（见 `DIARY_MAX_IMAGE_BLOCKS`）：先到的留下，后到的丢掉，
 * 相对顺序不变——保留的是她写在**第一段附近**的那块，也就是她真正想夹进去的那块。
 */
export function resolveDiaryBlocks(
  draft: z.infer<typeof diaryBlockDraftSchema>,
  embeds: DiaryEmbed[],
): { blocks: DiaryBlock[]; droppedRefs: string[]; strippedRefs: string[] } {
  const byRef = new Map(embeds.map((embed) => [embed.ref, embed]));
  const used = new Set<string>();
  const blocks: DiaryBlock[] = [];
  const droppedRefs: string[] = [];
  const strippedRefs: string[] = [];
  // 按种类各记一个数：图与引文各有一份额度，互不占用。
  const kept: Record<DiaryEmbed["kind"], number> = { image: 0, quote: 0 };
  for (const item of draft.blocks) {
    if (item.type === "text") {
      const leaked = stripEmbedRefs(flattenParagraph(item.text));
      if (leaked.stripped.length > 0) strippedRefs.push(...leaked.stripped);
      if (leaked.text) blocks.push({ type: "text", text: leaked.text });
      continue;
    }
    const embed = byRef.get(item.ref.trim());
    if (!embed || used.has(embed.ref)) {
      droppedRefs.push(item.ref);
      continue;
    }
    const quota = embed.kind === "image" ? DIARY_MAX_IMAGE_BLOCKS : DIARY_MAX_QUOTE_BLOCKS;
    if (kept[embed.kind] >= quota) {
      droppedRefs.push(item.ref);
      continue;
    }
    used.add(embed.ref);
    kept[embed.kind] += 1;
    blocks.push(embed.kind === "image"
      ? { type: "image", url: embed.url, label: diaryImageLabel(embed, item.type === "image" ? item.caption : null) }
      : { type: "quote", label: embed.label, text: embed.text });
  }
  return { blocks, droppedRefs, strippedRefs };
}
