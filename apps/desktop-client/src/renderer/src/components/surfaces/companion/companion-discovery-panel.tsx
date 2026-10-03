/**
 * 40 §7 发现簿面板。
 *
 * ## 这个面板**只**做三件事
 *
 *  1. 列出用户自己留下来的东西，每条**标清作者与来源**（§7「各自标清作者和来源」）；
 *  2. 改批注、取消收藏；
 *  3. 显示书房里露出的那几条。
 *
 * 它**不做**的事同样重要：
 *
 *  - 不显示任何"成长里程碑"、正确率、连续天数。§7 明令「不按正确率或事件数量
 *    自动生产『成长里程碑』」——面板里出现一个需要被维护的指标，用户就会开始刷它。
 *  - 没有收藏时就是一句话，不生成占位内容（§7「没有收藏时保持清爽」）。
 *  - 取消收藏叫「取消收藏」，不叫「删除」：它不动原始回答与日记。
 */
import { useEffect,useRef,useState } from "react";

import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import type { CompanionDiscoveryEntryV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { CenterFeedback,CenterSearch,SectionState } from "./companion-center-primitives";

const KIND_LABEL: Record<string, string> = {
  user_utterance: "你说过的",
  kept_ai_suggestion: "她整理的",
  question: "疑问",
  counter_example: "反例",
  diary_excerpt: "日记摘录",
};
const SOURCE_LABEL: Record<string, string> = {
  assistant_reply: "一次回答",
  diary: "日记",
  memory: "她记住的",
  learning_run: "一次学习",
};

type Section<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export interface DiscoveryPanelProps {
  readonly section: Section<{ version: 1; entries: CompanionDiscoveryEntryV1[]; studyVisible: CompanionDiscoveryEntryV1[] }>;
  readonly busy: string | null;
  readonly error: string | null;
  readonly notice: string | null;
  readonly onUncollect: (entry: CompanionDiscoveryEntryV1) => void;
  readonly onAnnotate: (entry: CompanionDiscoveryEntryV1, annotation: string) => Promise<boolean> | void;
  readonly onRetry: () => void;
}

function DiscoveryRow(props: {
  entry: CompanionDiscoveryEntryV1;
  busy: boolean;
  onUncollect: (entry: CompanionDiscoveryEntryV1) => void;
  onAnnotate: (entry: CompanionDiscoveryEntryV1, annotation: string) => Promise<boolean> | void;
}) {
  const { entry } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.annotation ?? "");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  return <article className="cc-discovery-entry" data-kind={entry.kind} data-author={entry.author}>
    <header>
      {/* 作者是**必填**的（schema 里没有"未标"这一档），所以这里总能说出是谁说的。
          §7 要的就是这个：用户保留的 AI 建议若不标作者，读起来就像用户自己写的。 */}
      <strong>{entry.author === "user" ? "你" : "她"}</strong>
      <span className="cc-tag">{KIND_LABEL[entry.kind] ?? entry.kind}</span>
      <span className="cc-tag">{SOURCE_LABEL[entry.source] ?? entry.source}</span>
    </header>
    <p>{entry.body}</p>
    {editing ? <div className="cc-form">
      <label>
        你的批注
        <textarea ref={inputRef} value={draft} maxLength={2000} onChange={(event) => setDraft(event.target.value)} />
      </label>
      <div className="cc-actions">
        <button type="button" className="button" disabled={props.busy} onClick={() => { setEditing(false); setDraft(entry.annotation ?? ""); }}>取消</button>
        <button type="button" className="button primary" disabled={props.busy} onClick={async () => { const saved = await props.onAnnotate(entry, draft); if (saved !== false) setEditing(false); }}>保存批注</button>
      </div>
    </div> : entry.annotation ? <blockquote>你的批注：{entry.annotation}</blockquote> : null}
    <footer><small>{new Date(entry.createdAt).toLocaleDateString("zh-CN")}</small>
      <button type="button" className="cc-link" disabled={props.busy} onClick={() => { if (!editing) setDraft(entry.annotation ?? ""); setEditing(value => !value); }}>{editing ? "收起" : "加批注"}</button>
      {/*
        措辞是刻意的：不是「删除」。§7「取消收藏不删除原始回答或日记」——
        叫「删除」会让用户以为那篇日记也没了，而它没有。
      */}
      <button type="button" className="cc-link" disabled={props.busy} onClick={() => props.onUncollect(entry)}>取消收藏</button>
    </footer>
  </article>;
}

export function DiscoveryPanel(props: DiscoveryPanelProps) {
  const [query, setQuery] = useState("");
  const [author, setAuthor] = useState<"all" | "user" | "assistant" | "study">("all");
  const book = props.section.ok ? props.section.value : null;
  const entries = (book?.entries ?? []).filter(entry => (author === "all" || author === "study" ? author !== "study" || entry.visibility === "study" : entry.author === author) && `${entry.body} ${entry.annotation ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const readable: PageReadableV1 = {
    pageId: "companion", title: "伴星中心",
    statusLine: !props.section.ok ? "发现簿暂时读不到" : `${entries.length} 条收藏`,
    ...(props.error || props.notice ? { notice: (props.error ?? props.notice)!.slice(0, 160) } : {}),
    ...(query.trim() ? { filters: [{ label: "搜索", value: query.trim().slice(0, 40) }] } : {}),
    items: entries.slice(0, 12).map((entry, index) => ({ ordinal: index + 1, label: entry.body.slice(0, 120), state: `${entry.author === "user" ? "你" : "她"} · ${SOURCE_LABEL[entry.source] ?? entry.source}`.slice(0, 40) })),
  };
  usePageReadableView(readable);
  if (!props.section.ok) return <div role="alert"><SectionState message="发现簿暂时读不到" detail={props.section.message} onRetry={props.onRetry} /></div>;
  return <div className="cc-discovery">
    <div className="cc-toolbar"><CenterSearch value={query} onChange={setQuery} label="搜索收藏与批注" placeholder="搜索收藏与批注" /><span className="cc-muted">{entries.length} 条收藏</span></div>
    <div className="cc-segments" role="group" aria-label="发现簿筛选">{([["all", "全部"], ["user", "你留下的话"], ["assistant", "她写的话"], ["study", "书房里放出的"]] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={author === id} onClick={() => setAuthor(id)}>{label}</button>)}</div>
    <CenterFeedback error={props.error} notice={props.notice} />
    {!book?.entries.length ? <SectionState message="还没有收藏" detail="你在回答旁留下的话会收在这里，之后可以随时补充批注。" />
      : !entries.length ? <SectionState message="没有符合筛选的收藏" detail="换个关键词，或查看全部收藏。" />
      : <ol className="cc-discovery-list">{entries.map(entry => <li key={entry.entryId}><DiscoveryRow entry={entry} busy={props.busy !== null} onUncollect={props.onUncollect} onAnnotate={props.onAnnotate} /></li>)}</ol>}
    {book?.studyVisible.length ? <div className="cc-page-note"><span>书房里放出的 {book.studyVisible.length} 条</span><small>只有你标出来的收藏才会放到书房。</small></div> : null}
    <p className="cc-muted cc-discovery-footnote">取消收藏会移出发现簿，原始回答和日记仍然保留。</p>
  </div>;
}
