import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Code2, FileText, GitBranch, Image, Layers, Maximize2, Minimize2 } from "lucide-react";
import type { CompanionContentBlockV1 } from "@astella/shared/companion-conversation-contracts";
import { desktopRouteFromAgentRoute, type CompanionChatSession } from "../../../app/companion-session/companion-chat-session";
import { CompanionMessageRichBlocks } from "../hud/CompanionChatRecord";
import { CompanionFollowupPrompts } from "./CompanionFollowupPrompts";
import { useCompanionTransient } from "../notify/use-companion-transient";
import { useCompanionResultPreview } from "./companion-result-preview";
import { useJournalDisclosure } from "./companion-journal-view-state";
import { useRoomStore } from "../../../app/home/room-store";

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
function ReplyMaterial({ block, chat, identity }: { block: CompanionContentBlockV1; chat: CompanionChatSession; identity: string }) {
  const [open, toggle] = useJournalDisclosure(identity);
  return <details open={open} className="companion-reply-attachments__material">
    <summary onClick={event => { event.preventDefault(); toggle(); }}><span>{attachmentLabel(block)}</span></summary>
    <CompanionMessageRichBlocks blocks={[block]} chat={chat} />
  </details>;
}
const resultKinds = { image: { label: "图片", icon: Image }, diagram: { label: "步骤图", icon: GitBranch }, card: { label: "题面", icon: Layers }, code: { label: "代码", icon: Code2 } };

/** Content updates keep the selected reader mounted. Every object owns its
 * expansion and reading position, scoped to this message and workspace. */
function ReplyContentGallery({ blocks, chat, onReadingChange, messageId }: {
  blocks: readonly ResultBlock[]; chat: CompanionChatSession; onReadingChange: (reading: boolean) => void; messageId: string;
}) {
  const cache = useCompanionResultPreview.getState();
  const state = useRef(cache.galleries.get(messageId) ?? { selected: 0, expanded: new Set<number>() });
  const [index, setIndex] = useState(state.current.selected);
  const [, redraw] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const reader = useRef<HTMLDivElement>(null);
  const selected = Math.min(index, blocks.length - 1);
  const expanded = state.current.expanded.has(selected);
  const block = blocks[selected];
  const identity = `${useRoomStore.getState().workspaceScopeRevision}:${messageId}:${selected}:${block.type}`;
  useLayoutEffect(() => { if (reader.current) reader.current.scrollTop = cache.positions.get(identity) ?? 0; }, [identity]);
  const { label, icon: Icon } = resultKinds[block.type];
  useEffect(() => {
    onReadingChange(expanded || zoomed);
    return () => onReadingChange(false);
  }, [expanded, zoomed, onReadingChange]);
  const select = (next: number) => {
    if (reader.current) cache.positions.set(identity, reader.current.scrollTop);
    state.current.selected = next; cache.galleries.set(messageId, state.current); setIndex(next); setZoomed(false);
  };
  const toggle = () => {
    if (expanded) state.current.expanded.delete(selected); else state.current.expanded.add(selected);
    cache.galleries.set(messageId, state.current); redraw(value => value + 1);
  };
  return <section className="companion-reply-content" data-type={block.type} data-expanded={expanded || undefined} aria-label="伴星递来的内容">
    <header><span><Icon size={14} aria-hidden="true" />{label}</span>
      {block.type !== "image" ? <button type="button" aria-expanded={expanded} onClick={toggle}>
        {expanded ? <Minimize2 size={12} aria-hidden="true" /> : <Maximize2 size={12} aria-hidden="true" />}{expanded ? "收起阅读" : "展开阅读"}
      </button> : <small>点图片可放大</small>}
    </header>
    <div className="companion-reply-content__preview" key={identity} ref={reader} onScroll={event => cache.positions.set(identity, event.currentTarget.scrollTop)} tabIndex={block.type === "image" ? undefined : 0} role={block.type === "image" ? undefined : "region"} aria-label={block.type === "image" ? undefined : `${label}预览`}>
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
export function CompanionReplyAttachments({ chat, paused, followupsReady = true, onDismiss, representedNoteIds }: {
  chat: CompanionChatSession; paused: boolean; followupsReady?: boolean; onDismiss: () => void;
  representedNoteIds?: ReadonlySet<string>;
}) {
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const reply = chat.richReply;
  const [materialsOpen, toggleMaterials] = useJournalDisclosure(`${reply?.messageId}:materials`);
  const [readingContent, setReadingContent] = useState(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const life = useCompanionTransient(reply?.messageId ?? null, 60_000, paused || readingContent || (materialsOpen && Boolean(reply?.blocks.some(block => block.type === "quote" || block.type === "citation"))));
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
  const followups = blocks.flatMap((block) => block.type === "follow_up_suggestions" ? block.prompts : []);
  const links = blocks.filter(block => block.type === "nav" && !(block.route.kind === "note" && representedNoteIds?.has(block.route.noteId)));
  const recommendations = blocks.filter(block => block.type === "recommendation");
  const material = blocks.filter(block => block.type === "quote" || block.type === "citation");
  const results = blocks.filter((block): block is ResultBlock => block.type === "image" || block.type === "diagram" || block.type === "card" || block.type === "code");
  return <div className="companion-reply-attachments" onPointerMove={life.activity} onKeyDown={life.activity} onWheel={life.activity} onFocus={life.activity}>
    {followupsReady && followups.length > 0 ? <CompanionFollowupPrompts prompts={followups} chat={chat} /> : null}
    {links.length ? <div className="companion-reply-attachments__destinations"><CompanionMessageRichBlocks blocks={links} chat={chat} runId={chat.messages.find(message => message.id === reply.messageId)?.runId ?? chat.processRunId ?? undefined} onNavNavigated={onDismiss} /></div> : null}
    {recommendations.length ? <div className="companion-reply-attachments__recommendations" aria-label="伴星推荐的学习内容">
      <CompanionMessageRichBlocks blocks={recommendations} chat={chat} onNavNavigated={onDismiss} />
    </div> : null}
    {results.length ? <ReplyContentGallery key={`${scope}:${reply.messageId}`} messageId={reply.messageId} blocks={results} chat={chat} onReadingChange={setReadingContent} /> : null}
    {material.length ? <details open={materialsOpen} className="companion-reply-attachments__materials">
      <summary onClick={event => { event.preventDefault(); toggleMaterials(); }}><FileText size={14} aria-hidden="true" /><span>查阅的材料</span><small>{material.length}</small></summary>
      {materialsOpen ? <div className="companion-reply-attachments__reading">
        <p className="companion-reply-attachments__hint">本轮查阅的片段与出处，供你核对。</p>
        {material.map((block, index) => <ReplyMaterial key={index} block={block} chat={chat} identity={`${reply.messageId}:material:${index}`} />)}
      </div> : null}
    </details> : null}
  </div>;
}
