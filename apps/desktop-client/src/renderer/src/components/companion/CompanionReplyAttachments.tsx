import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Code2, FileText, GitBranch, Image, Layers, Maximize2, Minimize2 } from "lucide-react";
import type { CompanionContentBlockV1 } from "@astella/shared/companion-conversation-contracts";
import { desktopRouteFromAgentRoute, type CompanionChatSession } from "../../app/companion-chat-session";
import { CompanionMessageRichBlocks } from "./CompanionChatRecord";
import { useCompanionTransient } from "./use-companion-transient";

function attachmentLabel(block: CompanionContentBlockV1): string {
  switch (block.type) {
    case "image": case "citation": case "quote": case "nav": return block.label;
    case "diagram": return block.title;
    case "card": return block.front;
    case "code": return block.language ? `${block.language} 代码` : "代码片段";
    default: return "附件";
  }
}

type ResultBlock = Extract<CompanionContentBlockV1, { type: "image" | "diagram" | "card" | "code" }>;
const resultKinds = { image: { label: "图片", icon: Image }, diagram: { label: "步骤图", icon: GitBranch }, card: { label: "题面", icon: Layers }, code: { label: "代码", icon: Code2 } };

/** One immediately readable preview, even when a turn delivers many objects.
 * Changing the selected object unmounts its viewer and resets its scroll. */
function ReplyContentGallery({ blocks, chat, onReadingChange }: {
  blocks: readonly ResultBlock[]; chat: CompanionChatSession; onReadingChange: (reading: boolean) => void;
}) {
  const [index, setIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const selected = Math.min(index, blocks.length - 1);
  const block = blocks[selected];
  const { label, icon: Icon } = resultKinds[block.type];
  useEffect(() => {
    onReadingChange(expanded || zoomed);
    return () => onReadingChange(false);
  }, [expanded, zoomed, onReadingChange]);
  const select = (next: number) => { setIndex(next); setZoomed(false); setExpanded(false); };
  return <section className="companion-reply-content" data-type={block.type} data-expanded={expanded || undefined} aria-label="伴星递来的内容">
    <header><span><Icon size={14} aria-hidden="true" />{label}</span>
      {block.type !== "image" ? <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        {expanded ? <Minimize2 size={12} aria-hidden="true" /> : <Maximize2 size={12} aria-hidden="true" />}{expanded ? "收起阅读" : "展开阅读"}
      </button> : <small>点图片可放大</small>}
    </header>
    <div className="companion-reply-content__preview" key={JSON.stringify(block)} tabIndex={block.type === "image" ? undefined : 0} role={block.type === "image" ? undefined : "region"} aria-label={block.type === "image" ? undefined : `${label}预览`}>
      <CompanionMessageRichBlocks blocks={[block]} chat={chat} onReadingChange={setZoomed} />
    </div>
    {blocks.length > 1 ? <nav className="companion-reply-content__paging" aria-label="切换本轮内容">
      <button type="button" aria-label="上一份内容" disabled={selected === 0} onClick={() => select(selected - 1)}><ChevronLeft size={16} aria-hidden="true" /></button>
      <span aria-live="polite">{selected + 1} / {blocks.length} · {label}</span>
      <button type="button" aria-label="下一份内容" disabled={selected === blocks.length - 1} onClick={() => select(selected + 1)}><ChevronRight size={16} aria-hidden="true" /></button>
    </nav> : null}
  </section>;
}

/** One reply owns its delivery, reading material and lifetime. Never queue old
 * blocks as new room notifications. Reading a note is not a claim of citation. */
export function CompanionReplyAttachments({ chat, paused, onDismiss }: {
  chat: CompanionChatSession; paused: boolean; onDismiss: () => void;
}) {
  const reply = chat.richReply;
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [readingContent, setReadingContent] = useState(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const life = useCompanionTransient(reply?.messageId ?? null, 60_000, paused || opened.size > 0 || readingContent);
  useEffect(() => { if (reply && !life.visible) dismissRef.current(); }, [reply?.messageId, life.visible]);
  // Exact duplicates can arrive from retries/paginated reads. Keep distinct
  // excerpts; their labels alone cannot prove they are the same material.
  const seen = new Set<string>();
  const blocks = reply?.blocks.filter(block => {
    if (block.type === "text" || block.type === "action_ref") return false;
    if (block.type === "citation" && block.referenceId) return false;
    if (block.type === "nav" && chat.autoNavigatedRoutes.has(JSON.stringify(desktopRouteFromAgentRoute(block.route)))) return false;
    const key = JSON.stringify(block);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }) ?? [];
  // An automatically opened destination leaves no delivery to keep on screen.
  // Retire only its rich part; an accompanying spoken reply keeps its own life.
  useEffect(() => {
    if (reply && blocks.length === 0) chat.dismissRichReply();
  }, [reply?.messageId, blocks.length, chat.dismissRichReply]);
  if (!reply || blocks.length === 0) return null;
  const links = blocks.filter(block => block.type === "nav");
  const material = blocks.filter(block => block.type === "quote" || block.type === "citation");
  const results = blocks.filter((block): block is ResultBlock => block.type === "image" || block.type === "diagram" || block.type === "card" || block.type === "code");
  const noteOpen = (key: string, open: boolean) => setOpened(previous => {
    const next = new Set(previous);
    if (open) next.add(key); else next.delete(key);
    return next;
  });
  return <div className="companion-reply-attachments" onPointerMove={life.activity} onKeyDown={life.activity} onWheel={life.activity} onFocus={life.activity}>
    {links.length ? <div className="companion-reply-attachments__destinations"><CompanionMessageRichBlocks blocks={links} chat={chat} onNavNavigated={onDismiss} /></div> : null}
    {results.length ? <ReplyContentGallery key={reply.messageId} blocks={results} chat={chat} onReadingChange={setReadingContent} /> : null}
    {material.length ? <details className="companion-reply-attachments__materials" onToggle={event => noteOpen("materials", event.currentTarget.open)}>
      <summary><FileText size={14} aria-hidden="true" /><span>查阅的材料</span><small>{material.length}</small></summary>
      {opened.has("materials") ? <div className="companion-reply-attachments__reading">
        <p className="companion-reply-attachments__hint">本轮查阅的片段与出处，供你核对。</p>
        {material.map((block, index) => <details key={index} name={`reply-material-${reply.messageId}`} className="companion-reply-attachments__material">
          <summary><span>{attachmentLabel(block)}</span></summary>
          <CompanionMessageRichBlocks blocks={[block]} chat={chat} />
        </details>)}
      </div> : null}
    </details> : null}
  </div>;
}
