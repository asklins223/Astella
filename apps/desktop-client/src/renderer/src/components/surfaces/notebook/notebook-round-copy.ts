/**
 * 笔记那一轮的全部屏上文案。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * 它 115 行、**纯数据**——一张键值表，不含逻辑、不读状态、不 import 任何东西。
 * 之前它躺在 `notebook-surface.tsx` 第 332 行，是那个 4900 行文件里最容易被
 * 「顺手改一句」改坏的东西：文案与逻辑混在一个文件，改文案要翻 4900 行才能确认
 * 没碰到别的。
 *
 * 抽出来之后，「回顾一眼这一轮都有哪些说法」变成读一个 115 行的文件，
 * 而不是在一个巨型组件里 Ctrl-F。`notebook-round-history` 那一块也因为它
 * 才有办法切出去。
 *
 * ⚠️ 一字未改。措辞按 `AGENTS.md` 的口径：不报服务端版本号这类用户用不上的字，
 * 不把用户那句话写成「作废」。
 */
import { ROUND_RECORD_COPY_V1 } from "./round-record-copy.ts";

export const ROUND_COPY = {
  ask: "你想弄懂的是哪一件事？",
  start: "开始这一轮",
  starting: "正在开始…",
  /** 已经有一轮在进行中时，那颗提交按钮是"改写这一句"，不是"再开一轮"。 */
  save: "保存这个问题",
  revise: "换一个问题",
  saving: "正在改写…",
  end: "先到这里",
  ending: "正在收尾…",
  /**
   * 「接着学下去」（39d W4-5 ④ 的前置）：只有**停住**的那一轮摆这一颗。
   * 恢复不需要「暂停」那颗欠的那道活跃度判据——它是用户明确的动作。
   *
   * 措辞从「继续这一轮」改成这句，是因为这一页上"这一轮"已经是主语（标题牌上写着），
   * 按钮再说一遍就成了系统词；一个动词短语比一个内部名词更像"接着做下去"（39f UI-4）。
   */
  resume: "接着学下去",
  reopenWithCurrent: "按当前内容新开一轮",
  /**
   * 这一轮冻的正文后来又保存过一版。与教学面那句 `teaching.staleVersion`（依据不再在这里定位）
   * 不是一句话，也与笔记页那颗"有内容更新"的徽标不是一句话（D3 §5.1 后果②：徽标说内容，这句说这一轮）。
   */
  contentMoved: "这一轮当时用的正文，这一篇后来又保存过一版。",
  resuming: "正在继续…",
  reopening: "正在另起一轮…",
  /**
   * 迟到的那一句那三格（§16.39）。措辞按伴星那条口径走：说**这一发没进去**这个事实，
   * 不报"服务端版本号"这类她用不上的字，也不把她那句写成"作废"——它只是没交上去。
   */
  lostDraft: (question: string) => `这一句没有交上去，先替你留着：${question}`,
  applyLost: "把这一句改到新版本上",
  dropLost: "不要这一句了",
  fromStructure: "或从这篇的小节里另选一句：",
  /**
   * 那一块的第一句。`hasMore` 会改这句话的**量词**：只回了最近几条时报"开过 N 轮"
   * 就是个假总数（§10.3 要的是完整历史，而这一版没做分页）——所以那种情况下
   * 只说"最近的这几轮"，不替整篇报数。
   */
  historyLead: ROUND_RECORD_COPY_V1.noteLead,
  loadOlder: ROUND_RECORD_COPY_V1.loadOlder,
  loadingOlder: ROUND_RECORD_COPY_V1.loadingOlder,
  /** §10.3 那一格里"完成／部分完成／中断"这三个字由这一处签发；`active` 不在其中。 */
  historyState: ROUND_RECORD_COPY_V1.state,
  /**
   * §10.3 那一行的「实际方式」与「系统不确定项」（W4-8 刀一）。两格的字都**由服务端那两个
   * 事实决定**，界面不重算也不猜：没讲过也没练过时这两格整格不出（不是"这一轮什么都没干"
   * ——那需要另一种判断，而记录只报发生过什么）。
   */
  historyMode: ROUND_RECORD_COPY_V1.mode,
  historyUncertain: ROUND_RECORD_COPY_V1.uncertain,
  followUp: ROUND_RECORD_COPY_V1.followUp,
  historyOutcome: ROUND_RECORD_COPY_V1.outcome,
  /**
   * 教学面（39d W4-6 刀二）。这一轮讲没讲过、按哪一版讲的、依据是哪几段，
   * 这三句话由这一处签发——屏上与剧本读的是同一份（与状态那几档同一条规矩）。
   */
  teaching: {
    start: "先讲讲这一节",
    starting: "正在讲这一节…",
    /**
     * 缺口帮助停止之后摆的那四档（W4-6 刀四；PRD §5.3）。
     *
     * 第一句只说**读数**（帮了几次、还没有看到改善的证据），不许说成"你没弄懂"——
     * 那是对用户下判断，而系统在这一档有的只是"没有证据"。
     */
    stopLead: (count: number) => `帮了 ${count} 次，还没有看到改善的证据——先不自动加题了。你想怎么走？`,
    switchExplanation: "换一种解释",
    backToMaterial: "回材料核对",
    endRound: "先结束这一轮",
    /**
     * 动态产物（W4-6 刀五）。两句都只说这件事本身：动态这一版没起来**不是**
     * 学习失败，文字解释与练习照旧（"动态失败不冒充教学失败"）。
     */
    artifactFailed: "这一版动态讲解没能打开；上面的文字解释照旧，可以继续读、继续练。",
    artifactFallback: "动态这一版先停下了；步骤与解释在上面的文字里。",
    /** 教学面里"练一道"（W4-6 刀三）：只在有 active 目标时出现。 */
    practice: "练一道",
    practicing: "正在开这一道…",
    practicesLead: "这一轮练过：",
    exampleLead: "例子：",
    referencesLead: "依据（点开定位到正文）：",
    /**
     * 快照不是屏幕上这一版时，依据**不定位**：正文后来改过，块序号与屏上那段
     * 已经不是同一份材料，照序号跳过去会把手指点到别处。话要如实说。
     */
    staleVersion: "这一轮是按开始那一版的正文讲的；正文后来改过，依据就不在这里定位了。",
  },
  openLine: (question: string) => `这一轮：${question}`,
  revisedLine: (revision: number) => `这一句话已经改过 ${revision - 1} 次。`,
  hint: "改这句话不用重编笔记；这一轮先只对你自己可见。",
} as const;

/**
 * 那颗提交按钮的字。真窗口跑出来的第一个缺陷就在这里（2026-09-26，§16.16 实机读数）：
 * 旧写法把"在途"与"空闲"两档接反了——已经有一轮在进行中、请求**根本没在跑**的时候
 * 屏上写着「正在改写…」，而改写真的在跑时写的是「正在开始…」。
 * "正在…"只许出现在真有一次请求在途的那一段时间里，这是这一页所有按钮共用的规矩。
 */
/**
 * 一场练习现在到哪一步（W4-6 刀三）：**一处签发**，屏上与剧本读同一份。
 *
 * 结算过 ⇒ 说结论（七档与 run 自己的 `result.outcome` 一一对应，不另造词）；
 * 没结算 ⇒ 按 phase 说"正在进行／停住了／中断了"。`not_assessable` 不是"没弄通"，
 * 它是"这一次判不了"——两者都是要走下去的状态，说法必须分开（§3.2 那条老规矩）。
 */
export const ROUND_PRACTICE_OUTCOME_LABEL_V1: Record<string, string> = {
  demonstrated: "做出来了",
  partial: "做出一部分",
  needs_repair: "还有一处要补",
  not_assessable: "这一次判不了",
  practice_completed: "练完了",
  skipped: "跳过了",
  declared_unable: "说没想起来",
};

/* ── 三个纯函数：练习状态字、提交按钮那行字、以及它们要的类型 ──────────────────
 *
 * 原先这三个也在 `notebook-surface.tsx` 里，于是「这一轮」的左栏（237 行）想抽成组件时
 * 引用不到 `roundPracticeStateLabelV1` / `roundSubmitLabelV1`——**形状不在可引用的
 * 地方，是「切不动」的一个根因**（2026-09-29）。
 */
import type { RoundPracticeV1 } from "@astella/shared/note-learning-round-contracts";

export function roundPracticeStateLabelV1(practice: Pick<RoundPracticeV1, "phase" | "outcome">): string {
  if (practice.outcome) {
    return ROUND_PRACTICE_OUTCOME_LABEL_V1[practice.outcome] ?? practice.outcome;
  }
  if (practice.phase === "paused") return "停住了";
  if (["ended", "cancelled", "stale", "completed", "skipped"].includes(practice.phase)) return "中断了";
  return "正在进行";
}

/**
 * 轮次那一块里此刻在途的那一发。`"resume"` 与其余四档共用同一个状态，因为
 * （那颗提交按钮、教学面那几颗、输入框）的禁用判据是"这一块的某一发在途"——
 * 状态就会有一处忘了判，症状是"点两下发出两发"。
 */
export type RoundBusyV1 = "start" | "revise" | "end" | "resume" | "reopen" | null;

export function roundSubmitLabelV1(
  busy: RoundBusyV1,
  hasOpenRound: boolean,
): string {
  if (busy === "start") return ROUND_COPY.starting;
  if (busy === "revise") return ROUND_COPY.saving;
  return hasOpenRound ? ROUND_COPY.save : ROUND_COPY.start;
}
