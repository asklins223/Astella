import { useCallback, useEffect, useRef, useState } from "react";
import { BookmarkPlus, Pencil, Sparkles, X } from "lucide-react";
import type { NoteReflectionCommandV1, NoteReflectionPageV1, NoteReflectionV1, ReflectionSourceV1 } from "@ailearn/shared/note-learning-reflection-contracts";
import { createRequestMeta, gatewayErrorMessage, RendererGatewayError, unwrapGatewayResult } from "../../app/desktop-client";
import { PendingReflectionAppendError, reflectionDocumentLines } from "./note-reflection-document";

type Props = {
  noteId: string;
  roundId?: string;
  refreshKey: string;
  workspaceEpoch?: number;
  canAppend: boolean;
  shared: boolean;
  openSources?: boolean;
  canUseForTeaching?: boolean;
  selectedForTeaching?: string[];
  onSelectionChange?: (ids: string[]) => void;
  onAppend: (source: ReflectionSourceV1, annotation: string) => Promise<boolean>;
  onInspectBody: () => void;
};
const desktopApi = () => typeof window === "undefined" ? undefined : window.ailearn;
const originLabel = (source: ReflectionSourceV1) => source.ref.kind === "teaching" ? "AI 整理建议" : "本人原话";
const sameSource = (a: ReflectionSourceV1, b: ReflectionSourceV1) => a.ref.kind === b.ref.kind && a.ref.id === b.ref.id;
const sourceExcerpt = (source: ReflectionSourceV1) => {
  const compact = source.text.replace(/\s+/g, " ").trim();
  return compact.length > 34 ? `${compact.slice(0, 34)}…` : compact;
};

/** Optional paper tuck shared by the note body and the learning record leaves. */
export function NoteReflectionShelf(props: Props) {
  const [page, setPage] = useState<NoteReflectionPageV1 | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [source, setSource] = useState<ReflectionSourceV1 | null>(null);
  const [editing, setEditing] = useState<NoteReflectionV1 | null>(null);
  const [annotation, setAnnotation] = useState("");
  const [destination, setDestination] = useState<"private" | "body">("private");
  const [bodyPending, setBodyPending] = useState(false);
  const [open, setOpen] = useState(Boolean(props.openSources));
  const sequence = useRef(0);
  const alive = useRef(true);
  const previousRoundId = useRef(props.roundId);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  useEffect(() => {
    if (previousRoundId.current === props.roundId) return;
    previousRoundId.current = props.roundId;
    setSource(null); setEditing(null); setAnnotation(""); setDestination("private"); setBodyPending(false); setStatus(null); setError(null);
  }, [props.roundId]);
  const load = useCallback(async (before?: string) => {
    const api = desktopApi();
    if (!api?.noteReflection) return;
    const seq = ++sequence.current;
    setLoading(true); setError(null);
    try {
      const next = unwrapGatewayResult(await api.noteReflection.list({ meta: createRequestMeta(props.workspaceEpoch), noteId: props.noteId, roundId: props.roundId, before }));
      if (seq !== sequence.current || !alive.current) return;
      setPage(old => before && old ? { ...next, items: [...old.items, ...next.items] } : next);
    } catch (err) {
      if (seq === sequence.current && alive.current) {
        setError(gatewayErrorMessage(err));
        if (err instanceof RendererGatewayError && ["not_found", "forbidden", "stale_workspace", "unauthorized"].includes(err.code)) { setPage(null); setSource(null); setEditing(null); }
      }
    } finally { if (seq === sequence.current && alive.current) setLoading(false); }
  }, [props.noteId, props.roundId, props.workspaceEpoch]);
  useEffect(() => { void load(); }, [load, props.refreshKey]);
  useEffect(() => { if (props.openSources) setOpen(true); }, [props.openSources, props.roundId]);

  const choose = (next: ReflectionSourceV1, saved?: NoteReflectionV1) => {
    if (busy || bodyPending) return;
    const existing = saved ?? page?.items.find(item => sameSource(item.source, next)) ?? null;
    setSource(next); setEditing(existing); setAnnotation(existing?.annotation ?? "");
    setDestination("private"); setError(null); setStatus(null);
  };
  const write = async (command: NoteReflectionCommandV1) => {
    const api = desktopApi();
    if (!api?.noteReflection || busy) return;
    setBusy(true); setError(null);
    try {
      unwrapGatewayResult(await api.noteReflection.write({ meta: createRequestMeta(props.workspaceEpoch), noteId: props.noteId, command }));
      if (!alive.current) return;
      setStatus(command.kind === "remove" ? "收藏已取消，原始讲解和作答仍在学习记录里。" : "已留在本人私有备注里。正文没有改变。");
      setSource(null); setEditing(null); await load();
    } catch (err) { if (alive.current) setError(gatewayErrorMessage(err)); }
    finally { if (alive.current) setBusy(false); }
  };
  const readLatestAnnotation = async () => {
    const api = desktopApi();
    if (!api?.noteReflection || !editing || busy) return;
    setBusy(true);
    try {
      const latest = unwrapGatewayResult(await api.noteReflection.list({ meta: createRequestMeta(props.workspaceEpoch), noteId: props.noteId, reflectionId: editing.reflectionId }));
      if (!alive.current) return;
      const current = latest.items[0];
      if (!current) { setError("这条收藏已经取消。你的批注仍在，可以重新留为私有备注。"); setEditing(null); }
      else { setEditing(current); setError(null); setStatus("已读到最新保存的批注。你的输入保留，确认后再保存。"); }
    } catch (err) { if (alive.current) setError(gatewayErrorMessage(err)); }
    finally { if (alive.current) setBusy(false); }
  };
  const save = async () => {
    if (!source || busy) return;
    if (destination === "private") return write(editing ? { kind: "update", reflectionId: editing.reflectionId, expectedRevision: editing.revision, annotation }
      : { kind: "create", source: source.ref, annotation });
    setBusy(true); setError(null);
    try {
      if (!await props.onAppend(source, annotation)) {
        setBodyPending(true); setError("文字已留在本机正文，保存尚未确认。重试会保存同一份文字；也可以回正文检查。"); return;
      }
      if (!alive.current) return;
      setBodyPending(false); setSource(null); setStatus("已添到正文末尾并保存为新版本。这一轮仍使用开始时的内容。");
    } catch (err) { if (alive.current) setError(err instanceof PendingReflectionAppendError ? err.message : gatewayErrorMessage(err)); }
    finally { if (alive.current) setBusy(false); }
  };
  return <details className="note-reflection-tuck" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><BookmarkPlus size={18} aria-hidden="true" />留下这次的理解{page?.items.length ? <span> · 私有备注 {page.items.length}{page.nextCursor ? "+" : ""}</span> : null}</summary>
    <p className="small notebook-note">挑一句讲解或自己的回答，再添一点批注。只在你想留的时候做。</p>
    {loading ? <p role="status">正在翻找学习记录…</p> : null}
    {status ? <p role="status">{status}</p> : null}
    {error ? <p role="alert">{error} <button className="text-action" type="button" disabled={loading || busy} onClick={() => void load()}>重新读取</button></p> : null}
    {props.roundId && page?.sources.length ? <div className="note-reflection-sources" aria-label="选择要留下的记录">
      {page.sources.map((item, index) => <button key={`${item.ref.kind}:${item.ref.id}`} type="button" className="button" disabled={busy || bodyPending}
        aria-pressed={source ? sameSource(source, item) : false} onClick={() => choose(item)}>
          <span>{originLabel(item)} · {index + 1}</span><span className="note-reflection-source-chip__excerpt">{sourceExcerpt(item)}</span>
        </button>)}
    </div> : !loading && !error ? <p className="small notebook-note">{props.roundId ? "这一轮还没有可以留下的文字。讲解或提交回答后再来看看。" : "可以从本轮学习或某条学习足迹里挑选记录。"}</p> : null}
    {source ? <form className="note-reflection-compose" onSubmit={event => { event.preventDefault(); void save(); }}>
      <h4>{editing ? "修改自己的批注" : "留在笔记里"}</h4>
      <p className="small notebook-note">{originLabel(source)} · {source.question}</p>
      <details className="note-reflection-original" open><summary>原始文字（保留原样）</summary><p>{source.text}</p></details>
      {editing ? <p className="small notebook-note">最新保存的批注：{editing.annotation || "（未填写）"} <button type="button" className="text-action" disabled={busy} onClick={() => void readLatestAnnotation()}>读取最新批注</button></p> : null}
      <label>本人批注（可留空）<textarea value={annotation} maxLength={4000} rows={3} disabled={busy || bodyPending} onChange={event => setAnnotation(event.target.value)} placeholder="我想补充的理解，或还没想明白的地方…" /></label>
      <fieldset disabled={busy || bodyPending}><legend>留在哪里</legend>
        <label><input type="radio" name="reflection-destination" checked={destination === "private"} onChange={() => setDestination("private")} />本人私有备注 · 只有自己可见</label>
        {props.canAppend ? <label><input type="radio" name="reflection-destination" checked={destination === "body"} onChange={() => setDestination("body")} />{props.shared ? "公共正文 · 空间内可见" : "笔记正文"} · 添在末尾</label>
          : <p className="small notebook-note">你现在只能阅读正文，仍可保存自己的私有备注。</p>}
      </fieldset>
      {destination === "body" ? <div className="note-reflection-preview"><b>正文末尾将加入</b>{reflectionDocumentLines(source, annotation).map((line, i) => <p key={i}>{line}</p>)}</div> : <p className="small notebook-note">收藏这条原始记录和你的批注，不会生成卡片或加入复习。</p>}
      <div className="note-reflection-actions"><button type="submit" className="button primary" disabled={busy || annotation.length > 4000}>{busy ? "正在保存…" : bodyPending ? "重试保存正文" : destination === "body" ? "添到正文并保存" : editing ? "保存批注" : "留为私有备注"}</button>
        <button type="button" className="button" disabled={busy} onClick={() => {
          if (bodyPending) props.onInspectBody();
          setSource(null); setBodyPending(false); setError(null);
        }}>{bodyPending ? "回正文检查" : "先不留"}</button></div>
    </form> : null}
    {page?.items.length ? <div className="note-reflection-bookmarks"><h4>本人私有备注</h4>
      {props.canUseForTeaching ? <p className="small notebook-note">勾选最多三条，供下一次个人讲解参考。选中的文字会随这次讲解发送给 AI；只作理解背景，不进正文、卡片或正式判定。</p> : null}
      {page.items.map(item => <article key={item.reflectionId}>
        <details><summary>{originLabel(item.source)} · {new Date(item.createdAt).toLocaleDateString("zh-CN")} · {item.source.question}</summary><p className="note-reflection-source-text">{item.source.text}</p></details>
        {item.annotation ? <p className="note-reflection-annotation">本人批注：{item.annotation}</p> : null}
        {props.canUseForTeaching ? <label className="note-reflection-use-context"
          data-selected={props.selectedForTeaching?.includes(item.reflectionId) ? "true" : "false"}><input type="checkbox"
          checked={props.selectedForTeaching?.includes(item.reflectionId) ?? false}
          disabled={busy || (!props.selectedForTeaching?.includes(item.reflectionId) && (props.selectedForTeaching?.length ?? 0) >= 3)}
          onChange={(event) => {
            const selected = props.selectedForTeaching ?? [];
            props.onSelectionChange?.(event.target.checked
              ? [...selected, item.reflectionId]
              : selected.filter(id => id !== item.reflectionId));
          }} /><Sparkles size={14} aria-hidden="true" /><span>作为下一次讲解的个人参考</span></label> : null}
        <div className="note-reflection-actions"><button type="button" className="text-action" disabled={busy || bodyPending} onClick={() => choose(item.source, item)}><Pencil size={14} aria-hidden="true" />修改批注</button>
          <button type="button" className="text-action" disabled={busy || bodyPending} onClick={() => void write({ kind: "remove", reflectionId: item.reflectionId, expectedRevision: item.revision })}><X size={14} aria-hidden="true" />取消收藏</button></div>
      </article>)}
      {page.nextCursor ? <button className="button" type="button" disabled={loading || busy} onClick={() => void load(page.nextCursor!)}>更早的私有备注</button> : null}
    </div> : null}
  </details>;
}
