import type { CompanionDiscoveryKind, CompanionDiscoverySource } from "@ailearn/shared/desktop-ipc-contracts";
import { AlertCircle, Bookmark, BookmarkCheck, RefreshCw } from "lucide-react";

export interface DiscoveryKeepIdentity {
  readonly kind: CompanionDiscoveryKind;
  readonly source: CompanionDiscoverySource;
  readonly sourceId: string;
}
export interface DiscoveryKeepRequest extends DiscoveryKeepIdentity {
  readonly author: "user" | "assistant";
  readonly body: string;
}
export const DISCOVERY_BODY_MAX = 4000;
export function clipDiscoveryBody(text: string, limit = DISCOVERY_BODY_MAX): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}
export function discoveryIdentityKey(identity: DiscoveryKeepIdentity): string {
  return `${identity.kind}|${identity.source}|${identity.sourceId}`;
}
export function discoveryAuthorFor(role: "user" | "assistant"): "user" | "assistant" { return role; }
export function discoveryKindFor(role: "user" | "assistant"): CompanionDiscoveryKind {
  return role === "user" ? "user_utterance" : "kept_ai_suggestion";
}

export interface DiscoveryKeepProps {
  readonly state: "offer" | "kept";
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly feedback: string | null;
  readonly failure: string | null;
  readonly onKeep: () => void;
  readonly onRemove?: () => void;
}

export function DiscoveryKeepAction(props: DiscoveryKeepProps) {
  const kept = props.state === "kept";
  const label = props.busy ? (kept ? "正在取消收藏…" : "正在收藏…") : props.failure ? (kept ? "重试取消收藏" : "重试收藏到发现簿") : kept ? "已收藏 · 再点取消" : "留在发现簿";
  const Icon = props.failure ? RefreshCw : kept ? BookmarkCheck : Bookmark;
  return <button type="button" className="discovery-keep__bookmark"
    aria-disabled={props.disabled || props.busy} data-busy={props.busy || undefined} data-failed={Boolean(props.failure) || undefined} aria-pressed={kept} aria-busy={props.busy}
    aria-label={kept ? "取消这段原话的收藏" : props.failure ? "重试把这一段原话留在发现簿" : "把这一段原话留在发现簿"}
    title={label} onClick={() => { if (!props.disabled && !props.busy) (kept ? props.onRemove : props.onKeep)?.(); }}>
    <Icon size={16} aria-hidden="true" />
  </button>;
}

/** Keep normal reading free of extra rows; only failed writes need a visible explanation. */
export function DiscoveryKeepFeedback(props: DiscoveryKeepProps) {
  const kept = props.state === "kept";
  return <>
    {props.failure ? <div className="discovery-keep__error" role="alert"><AlertCircle size={17} aria-hidden="true" /><div><strong>{kept ? "收藏还没取消" : "这段话还没存下"}</strong><p>{props.failure}</p></div></div> : null}
    {props.feedback ? <p className="discovery-keep__notice" role="status">{props.feedback}</p> : null}
  </>;
}
