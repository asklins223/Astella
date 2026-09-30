/**
 * 「可以继续读的草稿」那一叠——从这篇笔记接出去的拓展，逐篇带着它引的那句原句。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * 83 行、4 个外部符号（`expansionTask` / `expansionReviewSaving` /
 * `selectedExpansionDraftCount` / `reference`），是「那一轮」之外最干净的一块。
 *
 * **拆它的前提同样是「形状有名字」**：`expansionTask` 的类型来自
 * `NoteExpansionTaskV1`（共享合同），组件直接引用；页面上 `reference` 是
 * 一个「正在取详情的轮次」派生值，作为 prop 传进来。
 *
 * ⚠️ JSX 逐字搬。每一篇是 `<details>`（收起的候选），`aria-label` 与那颗
 * 「收下这篇」的复选框都在里面——`note-expansion-task` 那一组测试盯的就是它们。
 *
 * 判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。
 */
import type { Dispatch, ReactElement, SetStateAction } from "react";
import type { NoteExpansionDraftV1, NoteExpansionTaskV1 } from "@ailearn/shared/note-expansion-contracts";
import { markdownToBlocks } from "@ailearn/shared/markdown-parser";

export function NoteExpansionDrafts(props: {
  readonly task: NoteExpansionTaskV1;
  /** 复核保存那一发在途。 */
  readonly saving: boolean;
  /** 「点某一篇的引用就跳到原文那一段」——定位逻辑在页面（它要读正文与教学面）。 */
  readonly locateTeachingReference: (ordinal: number) => void;
  readonly setExpansionTask: Dispatch<SetStateAction<NoteExpansionTaskV1 | null>>;
  /** 收下选中的那几篇：先落盘再回读。页面持有它，因为它要串 save 那一发。 */
  readonly persistNoteExpansionReview: (drafts: NoteExpansionDraftV1[]) => Promise<void>;
  readonly confirmNoteExpansionDrafts: () => Promise<void>;
}): ReactElement {
  const {
    task: expansionTask,
    saving: expansionReviewSaving,
    locateTeachingReference, setExpansionTask, persistNoteExpansionReview, confirmNoteExpansionDrafts,
  } = props;
  const selectedExpansionDraftCount = expansionTask.drafts.filter((draft) => draft.selected).length;
  return (
<div className="note-expansion-drafts">
  <div className="note-expansion-drafts__heading">
    <strong>可以继续读的草稿</strong>
    <span>每篇都带着它从这篇笔记接出来的原句。内容还没进笔记架，选好后再收下。</span>
  </div>
  {expansionTask.drafts.map((draft, index) => (
    <details className="note-expansion-draft" key={draft.candidateId}>
      <summary>
        <span>第 {index + 1} 篇</span>
        <strong>{draft.title}</strong>
        <small>{draft.selected ? "已选中" : "翻开看看"}</small>
      </summary>
      <div className="note-expansion-draft__inside">
      <p className="note-expansion-draft__relationship">{draft.relationship}</p>
      <div className="note-expansion-draft__sources" aria-label="这篇草稿从哪里接出来">
        {draft.sourceReferences.map((reference) => (
          <button type="button" key={`${reference.blockOrdinal}:${reference.quote}`} onClick={() => locateTeachingReference(reference.blockOrdinal)}>
            “{reference.quote}” <span>回原文</span>
          </button>
        ))}
      </div>
      <label className="note-expansion-draft__select">
        <input
          type="checkbox"
          checked={draft.selected}
          disabled={expansionTask.status !== "ready" || expansionReviewSaving}
          onChange={(event) => {
            const drafts = expansionTask.drafts.map((item) => item.candidateId === draft.candidateId
              ? { ...item, selected: event.currentTarget.checked }
              : item);
            setExpansionTask({ ...expansionTask, drafts });
            void persistNoteExpansionReview(drafts);
          }}
        />
        <span>收下这篇</span>
      </label>
      <label className="note-expansion-draft__field">
        <span>标题</span>
        <input
          aria-label={`拓展草稿 ${index + 1} 标题`}
          value={draft.title}
          maxLength={200}
          disabled={expansionTask.status !== "ready" || expansionReviewSaving}
          onChange={(event) => {
            const title = event.currentTarget.value;
            setExpansionTask((current) => current ? {
              ...current,
              drafts: current.drafts.map((item) => item.candidateId === draft.candidateId ? { ...item, title } : item),
            } : current);
          }}
          onBlur={() => void persistNoteExpansionReview(expansionTask.drafts)}
        />
      </label>
      <label className="note-expansion-draft__field">
        <span>草稿正文</span>
        <textarea
          aria-label={`拓展草稿 ${index + 1} 正文`}
          value={draft.blocks.map((block) => block.content).join("\n\n")}
          maxLength={20_000}
          rows={Math.min(12, Math.max(5, draft.blocks.length * 2))}
          disabled={expansionTask.status !== "ready" || expansionReviewSaving}
          onChange={(event) => {
            const rawBlocks = markdownToBlocks(event.currentTarget.value);
            const parsedBlocks: NoteExpansionDraftV1["blocks"] = rawBlocks.flatMap((block) => (
              block.type === "image" ? [] : [{ type: block.type, content: block.content }]
            ));
            setExpansionTask((current) => current ? {
              ...current,
              drafts: current.drafts.map((item) => item.candidateId === draft.candidateId ? { ...item, blocks: parsedBlocks } : item),
            } : current);
          }}
          onBlur={() => void persistNoteExpansionReview(expansionTask.drafts)}
        />
      </label>
      </div>
    </details>
  ))}
  {expansionTask.status === "ready" ? (
    <button type="button" className="note-expansion-drafts__confirm" disabled={selectedExpansionDraftCount === 0 || expansionReviewSaving} onClick={() => void confirmNoteExpansionDrafts()}>
      {expansionReviewSaving ? "正在保存…" : `确认收下 ${selectedExpansionDraftCount} 篇`}
    </button>
  ) : <p className="note-expansion-drafts__saved" role="status">这批笔记已经收下，可以从上方的关联书签再次打开。</p>}
</div>
  );
}
