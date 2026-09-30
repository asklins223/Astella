/**
 * 「这篇笔记的速看」那张纸。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * 那个文件的 `NotebookSurface` 单个函数有 4446 行、91 个 state。速看这一块是其中
 * **边界最清楚**的一片：一张纸、一个展开条件、七个 props，不读任何页面级状态。
 * 拆它的意义不在于减行数本身，而在于给后面的拆分立一个可复制的样板——
 * 「一个纸片 = 一个组件 + 显式 props」，而不是继续往那个函数里堆。
 *
 * 拆分的判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。
 */
import type { ReactElement, Ref } from "react";
import type { NoteOverviewV1 } from "@ailearn/shared/note-overview-contracts";

export function NoteOverviewPaper(props: {
  readonly overview: NoteOverviewV1;
  readonly paperRef: Ref<HTMLElement>;
  readonly dirty: boolean;
  readonly onCollapse: () => void;
  readonly onLocateReference: (blockOrdinal: number) => void;
  readonly onOpenExpansionPage: () => void;
  readonly onAskCompanion: () => void;
}): ReactElement {
  const latestNoteOverview = props.overview;
  return (
    <article className="note-overview-paper" aria-label="这篇笔记的速看" ref={props.paperRef}>
      <header>
        <span>这篇的速看 · 来自笔记 v{latestNoteOverview.noteVersionNumber}</span>
        <button type="button" className="text-action" onClick={props.onCollapse}>收起</button>
      </header>
      {latestNoteOverview.points?.length ? (
        <>
          <div className="note-overview-paper__gist"><span>一句话</span><p>{latestNoteOverview.body}</p></div>
          <ol className="note-overview-paper__points">
            {latestNoteOverview.points.map((point, index) => (
              <li key={`${point.blockOrdinal}:${point.quote}`}>
                <span className="note-overview-paper__number" aria-hidden="true">{index + 1}</span>
                <div>
                  <p>{point.explanation}</p>
                  <button type="button" onClick={() => props.onLocateReference(point.blockOrdinal)} title={point.quote}>
                    原文第 {point.blockOrdinal + 1} 段 <q>{point.quote}</q>
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </>
      ) : <div className="note-overview-paper__body">{latestNoteOverview.body}</div>}
      {latestNoteOverview.coverage?.imageBlocksNotRead ? (
        <p className="note-overview-paper__coverage">
          有 {latestNoteOverview.coverage.imageBlocksNotRead} 处图片没有读取，速看只根据文字整理。
        </p>
      ) : null}
      {!latestNoteOverview.points?.length && latestNoteOverview.references.length > 0 ? (
        <nav className="note-overview-paper__references" aria-label="速览对应的原文">
          {latestNoteOverview.references.slice(0, 3).map((reference) => (
            latestNoteOverview.versionState === "current" ? (
              <button
                type="button"
                key={`${reference.blockOrdinal}:${reference.quote}`}
                onClick={() => props.onLocateReference(reference.blockOrdinal)}
              >
                <span>回到第 {reference.blockOrdinal + 1} 段</span>
                <q>{reference.quote}</q>
              </button>
            ) : (
              <blockquote key={`${reference.blockOrdinal}:${reference.quote}`}>
                笔记 v{latestNoteOverview.noteVersionNumber} · {reference.quote}
              </blockquote>
            )
          ))}
          {latestNoteOverview.references.length > 3 ? (
            <details className="note-overview-paper__more-references">
              <summary>再看 {latestNoteOverview.references.length - 3} 条原文出处</summary>
              {latestNoteOverview.references.slice(3).map((reference) => (
                latestNoteOverview.versionState === "current" ? (
                  <button
                    type="button"
                    key={`${reference.blockOrdinal}:${reference.quote}`}
                    onClick={() => props.onLocateReference(reference.blockOrdinal)}
                  >
                    <span>回到第 {reference.blockOrdinal + 1} 段</span>
                    <q>{reference.quote}</q>
                  </button>
                ) : (
                  <blockquote key={`${reference.blockOrdinal}:${reference.quote}`}>
                    笔记 v{latestNoteOverview.noteVersionNumber} · {reference.quote}
                  </blockquote>
                )
              ))}
            </details>
          ) : null}
        </nav>
      ) : null}
      <footer>
        <span>这份速看已留在「学习记录」</span>
        <button type="button" className="text-action" onClick={props.onOpenExpansionPage}>继续往外学</button>
        <button type="button" className="text-action" disabled={props.dirty} onClick={props.onAskCompanion}>问问伴星</button>
      </footer>
    </article>
  );
}
