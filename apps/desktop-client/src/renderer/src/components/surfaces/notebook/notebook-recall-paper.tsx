/**
 * 「回想一下」那张纸。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * 那个文件里 `NotebookSurface` 单个函数 4100 多行。这块 47 行、外部符号 9 个，是少数
 * 依赖数够切的区域之一——**上一轮试过一次失败**，因为块内调用的 `actOnActiveRecall`
 * 带着一个匿名内联的判别联合，组件声明不了那个回调，只能自己重写分支（而且抄漏了
 * `reflection`）。
 *
 * 真正的修法不是「更小心地抄」，而是**先给那个联合起个名字**
 * （`notebook-recall-contract.ts` 的 `RecallActionV1`），两边引用同一份形状，
 * 然后这块就不用抄任何逻辑了。**先收敛契约、再搬实现**，比直接搬省事得多。
 *
 * ⚠️ JSX 逐字搬。那颗 `className="button primary"`（本屏唯一的主动作，由
 * `renderer-primary-action-guard` 钉着）、`role="alert"` / `role="status"`、
 * `aria-label` 与 `htmlFor`/`id` 配对都原样保留——这类改动任何守卫都抓不到。
 *
 * 判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。
 */
import type { ReactElement, Ref } from "react";
import type { NoteRecallCardV1, RecallActionV1, RecallBusyV1 } from "./notebook-recall-contract.ts";

export function NoteRecallPaper(props: {
  readonly recall: NoteRecallCardV1;
  readonly busy: RecallBusyV1;
  readonly failure: string | null;
  readonly reflection: string;
  readonly paperRef: Ref<HTMLElement>;
  /** 问题那句要按屏上长度折一下，所以传函数而不是传格式化好的串。 */
  readonly formatQuestion: (question: string) => string;
  readonly onCollapse: () => void;
  /** 三档自评共用一个入口，`kind` 决定服务端走哪一支。 */
  readonly onAct: (action: RecallActionV1) => Promise<void>;
  readonly onReflectionChange: (value: string) => void;
  readonly onLocateSection: (ordinal: number) => void;
}): ReactElement {
  const {
    recall: activeRecall,
    busy: recallBusy,
    failure: recallError,
    reflection: recallReflection,
    paperRef: recallPaperRef,
    formatQuestion: formatRecallQuestion,
    onAct: actOnActiveRecall,
    onReflectionChange: setRecallReflection,
    onLocateSection: locateTeachingReference,
  } = props;
  return (
<article className="note-recall-paper" aria-label="这篇笔记的回想" ref={recallPaperRef}>
  <header>
    <span>回想一下 · 笔记 v{activeRecall.noteVersionNumber}{activeRecall.versionState === "older" ? " · 旧版记录" : ""}</span>
    <button type="button" className="text-action" disabled={recallBusy !== null} onClick={() => props.onCollapse()}>收起</button>
  </header>
  <p className="note-recall-paper__question">{formatRecallQuestion(activeRecall.question)}</p>
  <p className="note-recall-paper__gentle">先在心里想一想；想不起来就看一点线索，再翻开原文对照。</p>
  {activeRecall.hint ? <aside className="note-recall-paper__hint"><strong>一点线索</strong><p>{activeRecall.hint}</p></aside> : null}
  {activeRecall.answer ? (
    <section className="note-recall-paper__answer" aria-label="笔记原文对照">
      <header>
        <strong>翻开对照 · 来自笔记 v{activeRecall.noteVersionNumber}{activeRecall.sectionTitle ? ` · ${activeRecall.sectionTitle}` : " · 笔记内容"}</strong>
        {activeRecall.versionState === "current" && activeRecall.sectionOrdinal !== null
          ? <button type="button" className="text-action" onClick={() => locateTeachingReference(activeRecall.sectionOrdinal! - 1)}>回到原文</button>
          : null}
      </header>
      <p>{activeRecall.answer}{activeRecall.answerTruncated ? "…（笔记较长，这里保留了前一部分；完整内容仍在原文中）" : ""}</p>
      {activeRecall.versionState === "older" ? <small>笔记后来改过，这里保留的是当时的原文快照。</small> : null}
    </section>
  ) : null}
  <div className="note-recall-paper__actions">
    {!activeRecall.hint ? (
      <button type="button" className="button" disabled={recallBusy !== null || activeRecall.versionState === "older"} onClick={() => void actOnActiveRecall({ kind: "hint" })}>
        {recallBusy === "hint" ? "正在取线索…" : "看一点线索"}
      </button>
    ) : null}
    {!activeRecall.answer ? (
      <button type="button" className="button primary" disabled={recallBusy !== null} onClick={() => void actOnActiveRecall({ kind: "reveal" })}>
        {recallBusy === "reveal" ? "正在翻开…" : "翻开原文对照"}
      </button>
    ) : null}
  </div>
  {activeRecall.answer && activeRecall.selfReport === null ? (
    <div className="note-recall-paper__report">
      <label htmlFor="note-recall-reflection">想留下一句话吗？（可不写）</label>
      <textarea id="note-recall-reflection" maxLength={2_000} value={recallReflection} onChange={(event) => setRecallReflection(event.currentTarget.value)} placeholder="刚才想起了什么，或是哪一点没想起来？" />
      <div>
        <button type="button" disabled={recallBusy !== null} onClick={() => void actOnActiveRecall({ kind: "self_report", value: "remembered", ...(recallReflection.trim() ? { reflection: recallReflection.trim() } : {}) })}>{recallBusy === "report" ? "正在记下…" : "基本想起来了"}</button>
        <button type="button" disabled={recallBusy !== null} onClick={() => void actOnActiveRecall({ kind: "self_report", value: "partly", ...(recallReflection.trim() ? { reflection: recallReflection.trim() } : {}) })}>想起了一部分</button>
        <button type="button" disabled={recallBusy !== null} onClick={() => void actOnActiveRecall({ kind: "self_report", value: "not_yet", ...(recallReflection.trim() ? { reflection: recallReflection.trim() } : {}) })}>还得重看</button>
      </div>
    </div>
  ) : activeRecall.selfReport ? (
    <p className="note-recall-paper__saved" role="status">这次回想已记下：{activeRecall.selfReport === "remembered" ? "基本想起来了" : activeRecall.selfReport === "partly" ? "想起了一部分" : "还得重看"}。不会据此打分或自动安排复习。</p>
  ) : null}
  {recallError ? <p className="note-recall-paper__error" role="alert">这一步没记下来：{recallError}</p> : null}
</article>
  );
}
