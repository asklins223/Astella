import { useState } from "react";
import type { NoteAnnotationV1 } from "@ailearn/shared/note-annotation-contracts";
import type { NoteLearningArtifactV1 } from "@ailearn/shared/note-learning-artifact-contracts";
import type { NoteExpansionLinkV1 } from "@ailearn/shared/note-expansion-contracts";
import type { NoteOverviewV1 } from "@ailearn/shared/note-overview-contracts";
import type { NoteRecallRecordV1 } from "@ailearn/shared/note-recall-contracts";
import { plainCompanionBubbleText } from "../../companion/companion-markdown";

export type FootprintKind = "overview" | "recall" | "annotation" | "artifact" | "expansion";
type FootprintEntry =
  | { kind: "overview"; id: string; createdAt: string; record: NoteOverviewV1 }
  | { kind: "recall"; id: string; createdAt: string; record: NoteRecallRecordV1 }
  | { kind: "annotation"; id: string; createdAt: string; record: NoteAnnotationV1 }
  | { kind: "artifact"; id: string; createdAt: string; record: NoteLearningArtifactV1 }
  | { kind: "expansion"; id: string; createdAt: string; record: NoteExpansionLinkV1 };

const KIND_LABEL: Record<FootprintKind, string> = {
  overview: "速看",
  recall: "回想",
  annotation: "难句批注",
  artifact: "互动讲解",
  expansion: "拓展笔记",
};

const FILTERS: readonly { kind: FootprintKind | "all"; label: string }[] = [
  { kind: "all", label: "全部" },
  { kind: "overview", label: "速看" },
  { kind: "recall", label: "回想" },
  { kind: "annotation", label: "批注" },
  { kind: "artifact", label: "演示" },
  { kind: "expansion", label: "新笔记" },
];

const MORE_LABEL: Record<FootprintKind, string> = {
  overview: "速览",
  recall: "回想",
  annotation: "批注",
  artifact: "互动讲解",
  expansion: "拓展笔记",
};

function preview(text: string, limit = 132): string {
  const normalized = plainCompanionBubbleText(text).replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function overviewPreview(text: string): string {
  return preview(text.split(/\n\s*\n/u, 1)[0] ?? text);
}

function recallPreview(text: string): string {
  return preview(text
    .replace(/^(?:好[，,]\s*)?(?:那我)?(?:不给答案[，,]\s*)?先问(?:你)?一个[：:]\s*/u, "")
    .replace(/\*\*/gu, ""));
}

function createdLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function versionLabel(version: number, state: "current" | "older"): string {
  return `笔记 v${version}${state === "older" ? " · 当时的旧版本" : ""}`;
}

export type NoteLearningFootprintProps = {
  overviews: readonly NoteOverviewV1[];
  recalls: readonly NoteRecallRecordV1[];
  annotations: readonly NoteAnnotationV1[];
  artifacts: readonly NoteLearningArtifactV1[];
  expansions: readonly NoteExpansionLinkV1[];
  hasMore: Readonly<Record<FootprintKind, boolean>>;
  loadingMore: Readonly<Record<FootprintKind, boolean>>;
  onLoadMore: (kind: FootprintKind) => void;
  onOpenRecall: (record: NoteRecallRecordV1) => void;
  onOpenAnnotation: (record: NoteAnnotationV1) => void;
  onOpenArtifact: (record: NoteLearningArtifactV1) => void;
  onOpenExpansion: (record: NoteExpansionLinkV1) => void;
  onLocateReference: (blockOrdinal: number) => void;
};

export function NoteLearningFootprint(props: NoteLearningFootprintProps) {
  const [filter, setFilter] = useState<FootprintKind | "all">("all");
  const entries: FootprintEntry[] = [
    ...props.overviews.map((record) => ({ kind: "overview" as const, id: record.overviewId, createdAt: record.createdAt, record })),
    ...props.recalls.map((record) => ({ kind: "recall" as const, id: record.recallId, createdAt: record.createdAt, record })),
    ...props.annotations.map((record) => ({ kind: "annotation" as const, id: record.annotationId, createdAt: record.createdAt, record })),
    ...props.artifacts.map((record) => ({ kind: "artifact" as const, id: record.artifactId, createdAt: record.createdAt, record })),
    ...props.expansions.map((record) => ({ kind: "expansion" as const, id: record.expansionId, createdAt: record.createdAt, record })),
  ].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
    || left.kind.localeCompare(right.kind)
    || left.id.localeCompare(right.id));
  const visibleEntries = filter === "all" ? entries : entries.filter((entry) => entry.kind === filter);
  const countFor = (kind: FootprintKind | "all") => kind === "all"
    ? entries.length
    : entries.filter((entry) => entry.kind === kind).length;

  return (
    <section className="note-footprint" aria-label="这篇笔记的学习记录" data-note-footprint="true">
      {entries.length ? <nav className="note-footprint__filters" aria-label="按记录类型查看">
        {FILTERS.map(({ kind, label }) => (
          <button type="button" key={kind} aria-pressed={filter === kind} onClick={() => setFilter(kind)}>
            {label}<span>{countFor(kind)}{kind !== "all" && props.hasMore[kind] ? "+" : ""}</span>
          </button>
        ))}
      </nav> : null}
      {visibleEntries.length ? (
        <ol className="note-footprint__list">
          {visibleEntries.map((entry) => (
            <li key={`${entry.kind}:${entry.id}`} data-footprint-kind={entry.kind}>
              {entry.kind === "overview" ? (
                <article className="note-footprint__paper note-footprint__paper--mint">
                  <header><strong>{entry.record.generationJobId ? KIND_LABEL.overview : "当时保存的伴星答复"}</strong><span>{createdLabel(entry.createdAt)} · {versionLabel(entry.record.noteVersionNumber, entry.record.versionState)}</span></header>
                  <p>{overviewPreview(entry.record.body)}</p>
                  <details>
                    <summary>{entry.record.generationJobId ? "翻开当时的重点和原文出处" : "翻开当时的答复和原文出处"}</summary>
                    <div className="note-footprint__full-text">{plainCompanionBubbleText(entry.record.body)}</div>
                    {entry.record.points?.length ? (
                      <ol className="note-footprint__points" aria-label="当时整理的重点">
                        {entry.record.points.map((point, index) => (
                          <li key={`${point.blockOrdinal}:${index}`}>
                            <p>{point.explanation}</p>
                            {entry.record.versionState === "current" ? (
                              <button type="button" onClick={() => props.onLocateReference(point.blockOrdinal)}>
                                原文第 {point.blockOrdinal + 1} 段 · “{point.quote}”
                              </button>
                            ) : <blockquote>当时的原文：{point.quote}</blockquote>}
                          </li>
                        ))}
                      </ol>
                    ) : entry.record.references.length ? <div className="note-footprint__sources" aria-label="速览对应的原文">
                      {entry.record.references.map((reference, index) => entry.record.versionState === "current" ? (
                        <button type="button" key={`${reference.blockOrdinal}:${index}`} onClick={() => props.onLocateReference(reference.blockOrdinal)}>
                          <span>回到第 {reference.blockOrdinal + 1} 段</span><q>{reference.quote}</q>
                        </button>
                      ) : (
                        <blockquote key={`${reference.blockOrdinal}:${index}`}>当时的原文：{reference.quote}</blockquote>
                      ))}
                    </div> : <small>这条记录没有单独标出段落引用。</small>}
                  </details>
                </article>
              ) : null}
              {entry.kind === "recall" ? (
                <article className="note-footprint__paper note-footprint__paper--butter">
                  <header><strong>{KIND_LABEL.recall}</strong><span>{createdLabel(entry.createdAt)} · {versionLabel(entry.record.noteVersionNumber, entry.record.versionState)}</span></header>
                  <p className="note-footprint__question">{recallPreview(entry.record.question)}</p>
                  {entry.record.reflection ? <blockquote>{plainCompanionBubbleText(entry.record.reflection)}</blockquote> : null}
                  <button type="button" className="text-action" onClick={() => props.onOpenRecall(entry.record)}>打开这次回想</button>
                </article>
              ) : null}
              {entry.kind === "annotation" ? (
                <article className="note-footprint__paper note-footprint__paper--pink">
                  <header><strong>{KIND_LABEL.annotation}</strong><span>{createdLabel(entry.createdAt)} · {entry.record.versionState === "older" ? "原句来自旧版本" : "当前笔记版本"}</span></header>
                  <blockquote>{entry.record.anchor.excerpt}</blockquote>
                  <p>{preview(entry.record.explanation.split("\n\n举个例子：")[0] ?? "", 100)}</p>
                  <button type="button" className="text-action" onClick={() => props.onOpenAnnotation(entry.record)}>
                    {entry.record.versionState === "current" ? "回到这句批注" : "查看旧版批注"}
                  </button>
                </article>
              ) : null}
              {entry.kind === "artifact" ? (
                <article className="note-footprint__paper note-footprint__paper--lavender">
                  <header><strong>{KIND_LABEL.artifact}</strong><span>{createdLabel(entry.createdAt)} · {versionLabel(entry.record.noteVersionNumber, entry.record.versionState)}</span></header>
                  <h3>{entry.record.title}</h3>
                  <p>{entry.record.subject}</p>
                  {entry.record.selectionText ? <blockquote>{entry.record.selectionText}</blockquote> : null}
                  <button type="button" className="text-action" onClick={() => props.onOpenArtifact(entry.record)}>打开这份互动讲解</button>
                </article>
              ) : null}
              {entry.kind === "expansion" ? (
                <article className="note-footprint__paper note-footprint__paper--blue">
                  <header><strong>{KIND_LABEL.expansion}</strong><span>{createdLabel(entry.createdAt)} · 来自笔记 v{entry.record.sourceNoteVersionNumber}</span></header>
                  <h3>{entry.record.otherNoteTitle}</h3>
                  <p>{entry.record.direction === "expanded_from_here" ? "从这篇笔记继续学到的新内容" : "这篇笔记是从相关内容拓展出来的"}</p>
                  <button type="button" className="text-action" onClick={() => props.onOpenExpansion(entry.record)}>打开这篇拓展笔记</button>
                </article>
              ) : null}
            </li>
          ))}
        </ol>
      ) : filter !== "all" ? <p className="note-footprint__filter-empty">这一类记录还没有留在这篇笔记里。</p> : null}
      {Object.entries(props.hasMore).some(([, hasMore]) => hasMore) ? (
        <details className="note-footprint__older">
          <summary>找更早的学习记录</summary>
          <div>
            {(Object.keys(MORE_LABEL) as FootprintKind[]).filter((kind) => props.hasMore[kind] && (filter === "all" || filter === kind)).map((kind) => (
              <button type="button" key={kind} disabled={props.loadingMore[kind]} onClick={() => props.onLoadMore(kind)}>
                {props.loadingMore[kind] ? "正在翻找…" : `再找一些${MORE_LABEL[kind]}`}
              </button>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
