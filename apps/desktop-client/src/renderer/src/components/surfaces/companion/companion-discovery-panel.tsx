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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CompanionDiscoveryEntryV1 } from "@ailearn/shared/desktop-ipc-contracts";

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
  readonly onAnnotate: (entry: CompanionDiscoveryEntryV1, annotation: string) => void;
  readonly onRetry: () => void;
}

function DiscoveryRow(props: {
  entry: CompanionDiscoveryEntryV1;
  busy: boolean;
  onUncollect: (entry: CompanionDiscoveryEntryV1) => void;
  onAnnotate: (entry: CompanionDiscoveryEntryV1, annotation: string) => void;
}) {
  const { entry } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.annotation ?? "");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  return <article className="discovery-row" data-kind={entry.kind} data-author={entry.author}>
    <header>
      {/* 作者是**必填**的（schema 里没有"未标"这一档），所以这里总能说出是谁说的。
          §7 要的就是这个：用户保留的 AI 建议若不标作者，读起来就像用户自己写的。 */}
      <strong>{entry.author === "user" ? "你" : "她"}</strong>
      <span className="tag">{KIND_LABEL[entry.kind] ?? entry.kind}</span>
      <span className="tag">{SOURCE_LABEL[entry.source] ?? entry.source}</span>
    </header>
    <p>{entry.body}</p>
    {editing ? <div className="discovery-row__edit">
      <label>
        你的批注
        <textarea ref={inputRef} value={draft} maxLength={2000} onChange={(event) => setDraft(event.target.value)} />
      </label>
      <div className="discovery-row__actions">
        <button type="button" className="button" onClick={() => { setEditing(false); setDraft(entry.annotation ?? ""); }}>取消</button>
        <button type="button" className="button primary" disabled={props.busy} onClick={() => { props.onAnnotate(entry, draft); setEditing(false); }}>保存批注</button>
      </div>
    </div> : entry.annotation ? <blockquote>你的批注：{entry.annotation}</blockquote> : null}
    <footer>
      <button type="button" className="text-action" onClick={() => setEditing((value) => !value)}>{editing ? "收起" : "加批注"}</button>
      {/*
        措辞是刻意的：不是「删除」。§7「取消收藏不删除原始回答或日记」——
        叫「删除」会让用户以为那篇日记也没了，而它没有。
      */}
      <button type="button" className="text-action" disabled={props.busy} onClick={() => props.onUncollect(entry)}>取消收藏</button>
    </footer>
  </article>;
}

export function DiscoveryPanel(props: DiscoveryPanelProps) {
  const book = props.section.ok ? props.section.value : null;
  const studyIds = useMemo(() => new Set((book?.studyVisible ?? []).map((entry) => entry.entryId)), [book]);

  if (!props.section.ok) {
    return <div className="companion-center__empty" role="alert">
      <p>发现簿暂时读不到：{props.section.message}</p>
      <button type="button" className="button" onClick={props.onRetry}>重试</button>
    </div>;
  }

  const entries = book?.entries ?? [];

  return <div className="discovery-panel">
    <header className="discovery-panel__head">
      <h2>发现簿</h2>
      <p>你自己留下来的东西：说过的话、她整理的建议、疑问、反例和日记摘录。取消收藏只是不再放在这里，原始回答和日记都还在。</p>
    </header>    {props.error ? <p role="alert" className="small">{props.error}</p> : null}
    {props.notice ? <p role="status" className="small">{props.notice}</p> : null}

    {/*
      没有收藏就是一句话。§7「没有收藏时保持清爽，不生成假内容」——
      这里刻意不画空卡片、不放示例、不"推荐你先收藏一条"。

      这句话刻意**不写「在日记或回答旁点『留在发现簿』」**：那一处入口按 §7 只出现
      一次，说过「先不留」之后就不再出现。指向一个可能根本不存在的按钮，是这一条
      文案原来最要命的毛病——用户照着去找，找不到，只会以为是自己漏了什么。
    */}
    {entries.length === 0 ? <div className="companion-center__empty">
      <p>还没有收藏。她在一句回答刚说完的时候会问一次要不要留下——你点了它就出现在这里，点了「先不留」她就不再问。</p>
    </div> : <ol className="discovery-list">
      {entries.map((entry) => <li key={entry.entryId}>
        <DiscoveryRow entry={entry} busy={props.busy !== null} onUncollect={props.onUncollect} onAnnotate={props.onAnnotate} />
      </li>)}
    </ol>}

    {book && book.studyVisible.length > 0 ? <section className="discovery-study" aria-label="书房里放出的痕迹">
      <h3>书房里放出的 {book.studyVisible.length} 条</h3>
      <p className="small">只有你标出来的才会出现在书房里，而且要能回到原内容。</p>
      <ul>
        {book.studyVisible.map((entry) => <li key={entry.entryId} data-listed={studyIds.has(entry.entryId) || undefined}>
          {entry.body.slice(0, 40)}{entry.body.length > 40 ? "…" : ""}
        </li>)}
      </ul>
    </section> : null}
  </div>;
}

/** 给外层用的小钩子：把 GatewayResult 变成 Section，形状与其它面板一致。 */
export function useDiscoverySection(load: () => Promise<unknown>): {
  section: Section<{ version: 1; entries: CompanionDiscoveryEntryV1[]; studyVisible: CompanionDiscoveryEntryV1[] }>;
  reload: () => void;
} {
  const [section, setSection] = useState<Section<{ version: 1; entries: CompanionDiscoveryEntryV1[]; studyVisible: CompanionDiscoveryEntryV1[] }>>({ ok: false, message: "还没读过" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    // `load` 可能是**同步**抛的（通道不存在时读 `window.ailearn...discovery` 就是
    // undefined.get）。那会让整个伴星中心跟着崩，而它只该让这一个面板说
    // 「暂时读不到」。所以先包成 async：同步抛也变成一个 rejected promise。
    Promise.resolve().then(load).then(
      (value) => { if (alive) setSection({ ok: true, value: value as never }); },
      (error: unknown) => { if (alive) setSection({ ok: false, message: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { alive = false; };
  }, [load, tick]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { section, reload };
}
