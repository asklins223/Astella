import { isCardGenerationInFlight, isCardGenerationReviewOpen } from "../review/card-generation-status";

type NoteGeneration = { readonly status: string; readonly noteVersionId: string };

/**
 * 笔记页那一格上，按下去会去哪 / 旁边还摆不摆「重新生成学习卡」。
 *
 * 这一格要回答的是两个不同的问题，所以**可以有两颗按钮**：
 *   1. 「我这一批现在怎么样」——后台在做就去进度页，已经摆到审核台就去审核页。
 *   2. 「我能不能再来一批」——这是**另一个决定**，藏在前一颗里面就没法单独按了。
 *
 * 过去把它们并成一颗（2026-10-04 的一次改动，事后被用户收回）：那颗按钮在"有事发生"
 * 时去进度页、在"没事发生"时开方案屏，于是"再做一批"这件事在有事发生的时候**完全
 * 不存在**，用户只能先去进度页找。而且笔记改过版之后它仍然读作「查看生成进度」，
 * 明明这一版正文还没有任何一批卡——那正是用户抱怨的那一句。
 *
 * 现在的判据：
 *
 * | 这篇笔记此刻的样子        | 主按钮                    | 旁边那颗                    |
 * | ------------------------ | ------------------------- | --------------------------- |
 * | 从没做过卡                | 生成学习卡                | —（没做过就谈不上"重新"）  |
 * | 改过正文（已存或没存）    | 生成学习卡（按新正文）    | 查看旧版生成                |
 * | 上次那批停了（失败/取消…）| 重新生成学习卡            | 查看上次生成                |
 * | 后台还在做                | 查看生成进度              | —（先停止，停了才有"重新"）|
 * | 摆着等人逐张决定 / 已完成 | 审核学习卡 / 查看学习卡   | 重新生成学习卡              |
 *
 * 「重新生成」在**正在生成时一律不出现**：此刻能做的只有"停下来"，而那一颗在进度页上。
 */
export function noteCardGenerationEntry(run: NoteGeneration | null, noteVersionId: string | undefined, hasUnversionedChanges: boolean) {
  // 历史上那一批描述的是它自己封存下来的那一版正文，从不是此刻正在编辑的这一版。
  const sourceChanged = Boolean(run && (hasUnversionedChanges || run.noteVersionId !== noteVersionId));
  const working = Boolean(run && isCardGenerationInFlight(run.status));
  const stopped = Boolean(run && !working && !isCardGenerationReviewOpen(run.status) && run.status !== "activated");
  /** 主按钮这一下是**另开一批**，而不是去看手上那一批。 */
  const startsNewRun = !run || sourceChanged || stopped;
  /**
   * 旧版还在跑：不能让它被新的一批顶掉，也不该让用户在正文已经改了的情况下看着一颗
   * 灰按钮猜为什么。理由就写在那一颗的 title 上。
   */
  const blockedByGeneration = startsNewRun && working;
  /**
   * 主按钮已经是"另开一批"的时候，旁边**不再**挂第二颗同义按钮（按下去是同一件事，
   * 两颗只是要用户先认出哪一颗是哪一颗）；只有当主按钮去看手上那一批时，它才补位。
   */
  const offersRegenerate = Boolean(run) && !startsNewRun && !working;
  return { sourceChanged, startsNewRun, blockedByGeneration, offersRegenerate };
}