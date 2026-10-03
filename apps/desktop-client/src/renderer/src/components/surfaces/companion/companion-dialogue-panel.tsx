import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import type { CompanionHistoryItemV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import { MessageCircle } from "lucide-react";
import { useLayoutEffect,useMemo,useRef,type ReactNode } from "react";
import type { CompanionChatSession } from "../../../app/companion-chat-session";
import { plainCompanionBubbleText,renderCompanionMarkdown } from "../../companion/companion-markdown";
import { CompanionMessageRichBlocks,CompanionQuoteBlock,messageDayKey,messageDayLabel } from "../../companion/CompanionChatRecord";
import { CompanionProposalChoice } from "../../companion/CompanionProposalChoice";
import { HUD_PAGES } from "../../hud/hud-pages";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { formatRelative } from "../notebook/surface-data";
import type { Section } from "./companion-center-model";
import { messageText } from "./companion-center-model";
import { CenterFeedback,CenterSearch,SectionState } from "./companion-center-primitives";
import { DiscoveryKeepAction,type DiscoveryKeepProps } from "./companion-discovery-offer";

type DialogueKeepProps = DiscoveryKeepProps & { readonly anchorMessageId: string | null };

type DialoguePanelProps = { section: Section<{ version: 1; items: CompanionHistoryItemV1[]; nextCursor: string | null }>; items: CompanionHistoryItemV1[]; cursor: string | null; query: string; searching: boolean; loadingMore: boolean; error: string | null; onQuery: (value: string) => void; onSearch: () => void; onLoadMore: () => void; onContinue: () => void; onRetry: () => void; keep?: DialogueKeepProps | null; chat?: CompanionChatSession; composer?: ReactNode; appliedQuery?: string; initialLoading?: boolean; historyKey?: string; onLatest?: () => void };

const DIALOGUE_UNAVAILABLE = "连续对话当前不可用";

const DIALOGUE_EMPTY = {
  message: "还没有对话记录",
  detail: "开始交流后，消息会连续出现在这里。",
} as const;

const DIALOGUE_NO_BODY = "这条记录不含可展示正文。";

const DIALOGUE_KEEP_LINE = "最新一句回答旁可以留下一条到发现簿，只问这一次。";

function dialogueRoleLabel(role: CompanionHistoryItemV1["role"]): string {
  return role === "user" ? "你" : role === "assistant" ? "伴星" : "系统";
}

function dialogueResultLine(props: DialoguePanelProps): string {
  const line = props.searching ? (props.appliedQuery ?? props.query).trim() ? "正在搜索对话" : "正在读取对话"
    : (props.appliedQuery ?? props.query).trim() ? `找到 ${props.items.length} 条对话` : "";
  return line && props.appliedQuery ? `${line} · “${props.appliedQuery}”` : line;

}

function dialogueKeepLine(props: DialoguePanelProps): string | undefined {
  const keep = props.keep;
  if (!keep) return undefined;
  if (keep.failure) return `留在发现簿没有成功：${keep.failure.slice(0, 60)}`;
  if (keep.feedback) return keep.feedback.slice(0, 120);
  return keep.state === "offer" ? DIALOGUE_KEEP_LINE : undefined;
}

function paragraphLines(text: string): string[] {
  const parts = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : [text];
}

export function DialoguePanel(props: DialoguePanelProps) {
  const threadRef = useRef<HTMLDivElement>(null);
  const nearEnd = useRef(true);
  const previous = useRef<{ key: string; first?: string; last?: string; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = threadRef.current;
    if (!element || !props.section.ok) return;
    const key = props.historyKey ?? "latest";
    const first = props.items[0]?.messageId;
    const last = props.items.at(-1)?.messageId;
    const before = previous.current;
    if (!before || before.key !== key) {
      element.scrollTop = props.appliedQuery ? 0 : element.scrollHeight;
      nearEnd.current = !props.appliedQuery;
    } else if (first !== before.first && last === before.last) {
      // Prepending older records keeps the paragraph being read in the same place.
      element.scrollTop += element.scrollHeight - before.height;
    } else if (nearEnd.current && !props.appliedQuery) element.scrollTop = element.scrollHeight;
    previous.current = { key, first, last, height: element.scrollHeight };
  }, [props.items, props.historyKey, props.appliedQuery, props.section.ok, props.chat?.draft?.text, props.chat?.phase]);
  // 屏上那一格与她读到的那一句同源：单独算一次，别在下面再拼一遍。
  const keepLine = dialogueKeepLine(props);
  const dialogueReadableView = useMemo<PageReadableV1 | null>(() => {
    // 这一格只有一行清单和几句状态字，**没有本地二次筛选**：`props.items` 就是
    // 服务端按关键词回给这一屏的那一批，屏上露出的也就是它（与记忆那一格不同）。
    if (props.initialLoading) return { pageId: "companion", title: HUD_PAGES.companion.title, statusLine: "正在读取对话" };
    if (!props.section.ok) {
      return {
        pageId: "companion",
        title: HUD_PAGES.companion.title,
        statusLine: DIALOGUE_UNAVAILABLE,
        notice: `${DIALOGUE_UNAVAILABLE}：${props.section.message.slice(0, 60)}`,
      };
    }
    const resultLine = dialogueResultLine(props);
    const rows = props.items.slice(0, 12).map((item, index) => ({
      ordinal: index + 1,
      label: (paragraphLines(plainCompanionBubbleText(messageText(item)) || DIALOGUE_NO_BODY)[0] ?? DIALOGUE_NO_BODY).slice(0, 120),
      state: item.role === "assistant" ? props.chat?.companionName ?? "伴星" : dialogueRoleLabel(item.role),
    }));
    return {
      pageId: "companion",
      title: HUD_PAGES.companion.title,
      statusLine: resultLine || props.error || (props.items.length === 0 ? DIALOGUE_EMPTY.message : undefined),
      ...((props.appliedQuery ?? props.query).trim() ? { filters: [{ label: "关键词", value: (props.appliedQuery ?? props.query).trim().slice(0, 40) }] } : {}),
      ...(rows.length > 0 ? { items: rows } : {}),
      ...(props.items.length === 0 ? { notice: `${DIALOGUE_EMPTY.message}：${DIALOGUE_EMPTY.detail}` } : {}),
      ...(keepLine && props.items.length > 0 ? { notice: keepLine } : {}),
    };
  }, [keepLine, props.chat?.companionName, props.error, props.items, props.query, props.appliedQuery, props.initialLoading, props.searching, props.section]);
  usePageReadableView(dialogueReadableView);
  return <div className="cc-dialogue">
    <div className="cc-dialogue__tools"><CenterSearch value={props.query} onChange={props.onQuery} placeholder="搜索说过的话…" label="搜索全部对话正文" onSubmit={props.onSearch} busy={props.searching} />{props.onLatest ? <button type="button" className="cc-link" onClick={props.onLatest}>返回最新对话</button> : null}{!props.composer ? <button type="button" className="cc-button is-primary" onClick={props.onContinue}><MessageCircle size={16} />继续交流</button> : null}</div>
    <CenterFeedback error={props.error} />
    {dialogueResultLine(props) ? <p className="cc-result" aria-live="polite">{dialogueResultLine(props)}</p> : null}
    <div ref={threadRef} className="cc-thread" aria-label="连续对话记录" onScroll={event => { const element = event.currentTarget; nearEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64; }}>
      {props.initialLoading ? <SectionState message="正在读取对话" /> : !props.section.ok ? <SectionState message={DIALOGUE_UNAVAILABLE} detail={props.section.message} onRetry={props.onRetry} /> : <>
        {props.cursor ? <button type="button" className="cc-thread__earlier cc-link" disabled={props.loadingMore} onClick={props.onLoadMore}>{props.loadingMore ? "正在读取更早记录…" : "加载更早记录"}</button> : null}
        {!props.items.length ? <SectionState message={DIALOGUE_EMPTY.message} detail={DIALOGUE_EMPTY.detail} /> : props.items.map((item, index) => {
          const text = item.blocks.filter(block => block.type === "text").map(block => block.type === "text" ? block.text : "").join("\n\n");
          const day = messageDayKey(item.createdAt); const previous = props.items[index - 1];
          return <div key={item.messageId}>{!previous || messageDayKey(previous.createdAt) !== day ? <div className="cc-thread__day"><time>{messageDayLabel(day)}</time></div> : null}<article tabIndex={-1} data-role={item.role} data-kind={item.kind} id={`companion-message-${item.messageId}`}><header><strong>{item.role === "assistant" ? props.chat?.companionName ?? "伴星" : dialogueRoleLabel(item.role)}</strong><time>{formatRelative(item.createdAt)}</time></header>
            {item.selection ? <CompanionQuoteBlock block={{ type: "quote", label: "引用的原文", text: item.selection.text }} /> : null}
            <div className="cc-prose">{text ? renderCompanionMarkdown(text) : !item.blocks.length ? <p>{DIALOGUE_NO_BODY}</p> : null}</div>
            {props.chat ? <><CompanionMessageRichBlocks blocks={item.blocks} chat={props.chat} />{item.blocks.map(block => block.type === "action_ref" ? <CompanionProposalChoice key={block.proposalId} proposalId={block.proposalId} state={props.chat!.proposalStates[block.proposalId]} context="history" onDecide={decision => void props.chat!.decideProposal(block.proposalId, decision)} onRetry={() => props.chat!.retryProposal(block.proposalId)} /> : null)}</> : null}
            {item.kind === "cancelled" ? <small>这是一条被你停止的未完成回复。</small> : item.kind === "error" ? <small>这一轮没有完成。</small> : null}
            {props.keep?.anchorMessageId === item.messageId ? <DiscoveryKeepAction {...props.keep} /> : null}
          </article></div>;
        })}
      </>}
      {props.chat?.draft?.text ? <article data-role="assistant" aria-label="正在回复"><header><strong>{props.chat.companionName}</strong><span>正在回复…</span></header><div className="cc-prose">{renderCompanionMarkdown(props.chat.draft.text)}</div></article> : props.chat?.phase === "sending" ? <p className="cc-thread__waiting" role="status">她正在想这句话…</p> : null}
    </div>
    {props.composer}
  </div>;
}
