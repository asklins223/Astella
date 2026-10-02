import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Check, Code2, Eye, PencilLine } from "lucide-react";
import * as Y from "yjs";
import type { NoteExpansionDraftV1, NoteExpansionTaskV1 } from "@ailearn/shared/note-expansion-contracts";
import { markdownToBlocks } from "@ailearn/shared/markdown-parser";
import { NoteDocumentEditor } from "./note-document-editor";
import { NOTE_BODY_MODES } from "./note-document-mode";
import type { NoteMarkdownEditorHandle } from "./note-markdown-editor";
import { ReadingBlock } from "./notebook-reading-block";
import { useNotebookBodyMode } from "./use-notebook-body-mode";
import { useNotebookPageTurn, useNotebookPaperMotion } from "./use-notebook-paper-motion";

const icons = { preview: Eye, "live-preview": PencilLine, source: Code2 };

type Props = {
  readonly task: NoteExpansionTaskV1;
  readonly saving: boolean;
  readonly locateTeachingReference: (ordinal: number) => void;
  readonly setExpansionTask: Dispatch<SetStateAction<NoteExpansionTaskV1 | null>>;
  readonly persistNoteExpansionReview: (drafts: NoteExpansionDraftV1[]) => Promise<void>;
};

/** Covers choose what to read; only the opened draft occupies the reading page. */
export function NoteExpansionDrafts(props: Props) {
  const [opened, setOpened] = useState<string | null>(null);
  const [visited, setVisited] = useState<readonly string[]>([]);
  const booksRef = useRef<HTMLDivElement | null>(null);
  const savedRef = useRef<HTMLParagraphElement | null>(null);
  const confirmed = useRef(props.task.confirmedCandidateIds?.length ?? 0);
  const play = useNotebookPaperMotion();
  const positions = useRef(new Map<string, number>());
  useNotebookPageTurn(booksRef, opened === null ? "covers" : "opened", play);
  useLayoutEffect(() => {
    const saved = props.task.confirmedCandidateIds?.length ?? 0;
    if (saved > confirmed.current) play(savedRef.current, "stamp");
    confirmed.current = saved;
  }, [props.task.confirmedCandidateIds?.length, play]);
  const latest = useRef(props);
  latest.current = props;
  const locked = props.saving || props.task.status !== "ready";
  const index = props.task.drafts.findIndex((draft) => draft.candidateId === opened);
  const open = (id: string | null) => {
    const scroller = booksRef.current?.closest<HTMLDivElement>(".notebook-desk__scroll");
    if (scroller) positions.current.set(opened ?? "covers", scroller.scrollTop);
    if (opened) void props.persistNoteExpansionReview(latest.current.task.drafts);
    if (id && !visited.includes(id)) setVisited([...visited, id]);
    setOpened(id);
  };
  useLayoutEffect(() => {
    const scroller = booksRef.current?.closest<HTMLDivElement>(".notebook-desk__scroll");
    if (scroller) scroller.scrollTop = positions.current.get(opened ?? "covers") ?? 0;
  }, [opened]);
  const update = (id: string, changes: Partial<Pick<NoteExpansionDraftV1, "title" | "blocks" | "selected">>, persist = false) => {
    if (locked || props.task.confirmedCandidateIds?.includes(id)) return;
    const drafts = latest.current.task.drafts.map((draft) => draft.candidateId === id ? { ...draft, ...changes } : draft);
    props.setExpansionTask((current) => current ? { ...current, drafts } : current);
    // Blur can follow a keystroke before React renders the new task.
    latest.current = { ...latest.current, task: { ...latest.current.task, drafts } };
    if (persist) void props.persistNoteExpansionReview(drafts);
  };
  useEffect(() => { setOpened(null); setVisited([]); }, [props.task.taskId]);

  return <div className="note-expansion-drafts">
    {props.task.confirmedCandidateIds?.length ? <p className="note-expansion-drafts__saved" role="status" ref={savedRef}><Check size={16} aria-hidden="true" />已收下 {props.task.confirmedCandidateIds.length} 篇 · {props.task.status === "confirmed" ? "可从关联笔记再次打开" : "其余草稿还可以继续读、修改和收下"}</p> : null}
    <div className="note-expansion-drafts__heading" hidden={opened !== null}><p>每篇都有来处。先翻开看看，再决定收下哪篇。</p></div>
    <div className="note-expansion-drafts__books" hidden={opened !== null} ref={booksRef}>
      {props.task.drafts.map((draft, position) => {
        const saved = props.task.confirmedCandidateIds?.includes(draft.candidateId) ?? false;
        return <article className="note-expansion-draft" key={draft.candidateId} data-cover={position % 3} data-selected={draft.selected}>
          <span className="note-expansion-draft__state">{saved ? "已收下" : visited.includes(draft.candidateId) ? "已读草稿" : "未读草稿"}</span>
          <h2>{draft.title}</h2><p className="note-expansion-draft__relationship">{draft.relationship}</p>
          <button type="button" className="text-action" onClick={() => open(draft.candidateId)}><BookOpen size={16} aria-hidden="true" />翻开看看</button>
          <DraftSelection draft={draft} saved={saved} locked={locked} onChange={selected => update(draft.candidateId, { selected }, true)} />
        </article>;
      })}
    </div>
    {opened ? <nav className="note-expansion-drafts__navigation" aria-label="拓展草稿导航">
      <button type="button" className="text-action" onClick={() => open(null)}><ArrowLeft size={15} aria-hidden="true" />所有草稿</button>
      <div><button type="button" className="text-action" aria-label="上一篇草稿" disabled={index <= 0} onClick={() => open(props.task.drafts[index - 1]!.candidateId)}><ArrowLeft size={17} aria-hidden="true" /></button>
        <span>{index + 1} / {props.task.drafts.length}</span>
        <button type="button" className="text-action" aria-label="下一篇草稿" disabled={index >= props.task.drafts.length - 1} onClick={() => open(props.task.drafts[index + 1]!.candidateId)}><ArrowRight size={17} aria-hidden="true" /></button></div>
    </nav> : null}
    {props.task.drafts.filter((draft) => visited.includes(draft.candidateId)).map((draft) => <div key={draft.candidateId} hidden={opened !== draft.candidateId}>
      <ExpansionDraftPage draft={draft} active={opened === draft.candidateId} saved={props.task.confirmedCandidateIds?.includes(draft.candidateId) ?? false} index={props.task.drafts.indexOf(draft)} locked={locked || Boolean(props.task.confirmedCandidateIds?.includes(draft.candidateId))} canEdit={props.task.status === "ready" && !props.task.confirmedCandidateIds?.includes(draft.candidateId)}
        onUpdate={(changes) => update(draft.candidateId, changes)}
        onPersist={() => { if (!locked) void props.persistNoteExpansionReview(latest.current.task.drafts); }}
        onLocate={props.locateTeachingReference} />
    </div>)}
  </div>;
}

function DraftSelection(props: { draft: NoteExpansionDraftV1; locked: boolean; saved?: boolean; onChange: (selected: boolean) => void }) {
  return <label className="note-expansion-draft__select" data-selected={props.draft.selected}>
    {props.saved ? <><Check size={16} aria-hidden="true" />已收下</> : <>
      <input type="checkbox" checked={props.draft.selected} disabled={props.locked} aria-label={`选择收下 ${props.draft.title}`} onChange={event => props.onChange(event.currentTarget.checked)} />
      <span className="note-expansion-draft__stamp" aria-hidden="true"><Check size={17} /></span>
      <span>{props.draft.selected ? "已选 · 再点取消" : "选择收下"}</span>
    </>}
  </label>;
}

/** Every visited candidate keeps its own document and mode until this task is replaced. */
function ExpansionDraftPage(props: {
  readonly draft: NoteExpansionDraftV1;
  readonly active: boolean;
  readonly saved: boolean;
  readonly index: number;
  readonly locked: boolean;
  readonly canEdit: boolean;
  readonly onUpdate: (changes: Partial<Pick<NoteExpansionDraftV1, "title" | "blocks" | "selected">>) => void;
  readonly onPersist: () => void;
  readonly onLocate: (block: number) => void;
}) {
  const [document] = useState(() => new Y.Doc());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<NoteMarkdownEditorHandle | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { mode, changeMode, pendingMode } = useNotebookBodyMode({ noteId: props.draft.candidateId, initialMode: "preview", canEdit: props.canEdit, editorRef, scrollRef, readingRoot: rootRef, onChange: () => undefined });
  const play = useNotebookPaperMotion();
  const shown = useRef(false);
  useLayoutEffect(() => {
    if (props.active && !shown.current) {
      play(rootRef.current, "page");
      rootRef.current?.querySelector<HTMLElement>(".note-expansion-draft__title")?.focus({ preventScroll: true });
    }
    shown.current = props.active;
  }, [props.active, play]);
  const markdown = props.draft.blocks.map((block) => block.content).join("\n\n");
  const initialMarkdown = useRef(markdown);
  const seeded = useRef(false);
  const connectEditor = useCallback((handle: NoteMarkdownEditorHandle | null) => {
    editorRef.current = handle;
    // This document belongs to an unsaved candidate, so seed it once after the
    // editor is ready. Never replay a candidate's initial text on later visits.
    if (handle && !seeded.current) {
      seeded.current = true;
      // Keep ySync's binding intact and keep initial text out of user undo.
      document.transact(() => handle.setMarkdown(initialMarkdown.current), "candidate-bootstrap");
    }
  }, [document]);
  useLayoutEffect(() => { scrollRef.current = rootRef.current?.closest<HTMLDivElement>(".notebook-desk__scroll") ?? null; }, []);
  useEffect(() => () => document.destroy(), [document]);
  return <div className="note-expansion-draft__page" ref={rootRef} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) props.onPersist(); }}>
    <div className="note-expansion-draft__modes" role="group" aria-label="草稿正文视图">
      {NOTE_BODY_MODES.map(({ id, label }) => { const Icon = icons[id]; return <button key={id} type="button" className="text-action" aria-pressed={mode === id} disabled={props.locked && id !== "preview"}
        onMouseDown={(event) => event.preventDefault()} onClick={() => changeMode(id)}><Icon size={15} aria-hidden="true" />{label}</button>; })}
      <DraftSelection draft={props.draft} saved={props.saved} locked={props.locked} onChange={selected => { props.onUpdate({ selected }); props.onPersist(); }} />
    </div>
    {mode === "preview" ? <h2 className="note-expansion-draft__title" tabIndex={-1}>{props.draft.title}</h2> : <textarea className="note-expansion-draft__title" aria-label={`拓展草稿 ${props.index + 1} 标题`} rows={1} maxLength={200} value={props.draft.title} disabled={props.locked} onChange={(event) => props.onUpdate({ title: event.currentTarget.value.replace(/\r?\n/g, " ") })} />}
    <p className="note-expansion-draft__relationship">{props.draft.relationship}</p>
    <details className="note-expansion-draft__sources"><summary>这篇草稿从哪里接出来</summary>{props.draft.sourceReferences.map((reference) => <button key={`${reference.blockOrdinal}:${reference.quote}`} type="button" className="text-action" onClick={() => props.onLocate(reference.blockOrdinal)}><q>{reference.quote}</q>回原文</button>)}</details>
    {pendingMode ? <p role="status">输入法确认后会切换草稿视图。</p> : null}
    <div className="note-transcript" hidden={mode !== "preview"}>{props.draft.blocks.map((block, ordinal) => <ReadingBlock key={ordinal} block={{ ...block, ordinal }} mark={null} />)}</div>
    <div className="note-draft" hidden={mode === "preview"}>
      <NoteDocumentEditor fragment={document.getXmlFragment("draft")} initialMarkdown={markdown} mode={mode} ref={connectEditor} disabled={props.locked}
        onChange={(value) => { if (mode !== "preview" && !props.locked) props.onUpdate({ blocks: markdownToBlocks(value).map((block) => ({ ...block, type: block.type === "image" ? "paragraph" as const : block.type })) }); }} />
    </div>
  </div>;
}
