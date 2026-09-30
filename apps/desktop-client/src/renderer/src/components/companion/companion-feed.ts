/**
 * 划选/拖拽投喂的事件总线（2026-09-18，设计文档 §二 切片①③）。
 *
 * 采集侧（右键菜单 / 窗口 drop）通过 window CustomEvent 把选中文本递给
 * CompanionPresence → 聊天抽屉；解耦为事件而不直接 import，避免菜单组件
 * 与伴星树互相依赖。文本上限 2000 字（与 turn 契约一致）。
 */

const COMPANION_FEED_EVENT = "ailearn:companion-feed";
const COMPANION_OPEN_CHAT_EVENT = "ailearn:companion-open-chat";
const COMPANION_NOTE_INTENT_EVENT = "ailearn:companion-note-intent";

export const COMPANION_FEED_MAX_CHARS = 2_000;

export interface CompanionFeedNoteAnchor {
  readonly noteId: string;
  readonly anchor: NoteAnnotationAnchorV1;
}

export interface CompanionNoteIntent {
  /** Each explicit notebook action gets its own send-once identity. */
  readonly requestId?: string;
  readonly kind: "overview" | "recall" | "recall_hint" | "expansion";
  readonly noteId: string;
  readonly noteVersionId: string;
  readonly noteTitle: string;
  readonly recallId?: string;
  readonly question?: string;
}

export interface CompanionFeedSelection {
  /** Present for selections forwarded through the renderer event bus. */
  readonly requestId?: string;
  readonly text: string;
  readonly source: "selection" | "drop";
  /** 可选的起始问题；用户仍可在发送前修改。 */
  readonly initialPrompt?: string;
  /** 笔记页传来的可保存原文锚点；回复完成后默认贴回，发送前可取消这个锚点。 */
  readonly noteAnchor?: CompanionFeedNoteAnchor;
}

export function feedSelectionToCompanion(selection: CompanionFeedSelection): void {
  const text = selection.text.trim();
  if (text.length === 0) return;
  const initialPrompt = selection.initialPrompt?.trim().slice(0, 500);
  const noteId = z.string().uuid().safeParse(selection.noteAnchor?.noteId);
  const anchor = noteAnnotationAnchorV1Schema.safeParse(selection.noteAnchor?.anchor);
  window.dispatchEvent(new CustomEvent<CompanionFeedSelection>(COMPANION_FEED_EVENT, {
    detail: {
      requestId: crypto.randomUUID(),
      text: text.slice(0, COMPANION_FEED_MAX_CHARS),
      source: selection.source,
      ...(initialPrompt ? { initialPrompt } : {}),
      ...(noteId.success && anchor.success ? { noteAnchor: { noteId: noteId.data, anchor: anchor.data } } : {}),
    },
  }));
  window.dispatchEvent(new CustomEvent(COMPANION_OPEN_CHAT_EVENT));
}

export function feedNoteIntentToCompanion(intent: CompanionNoteIntent): void {
  const noteId = z.string().uuid().safeParse(intent.noteId);
  const noteVersionId = z.string().uuid().safeParse(intent.noteVersionId);
  const noteTitle = intent.noteTitle.trim().slice(0, 200);
  if (!noteId.success || !noteVersionId.success || !noteTitle) return;
  const recallId = intent.kind === "recall_hint" ? z.string().uuid().safeParse(intent.recallId) : null;
  const question = intent.kind === "recall_hint" ? intent.question?.trim().slice(0, 500) : undefined;
  if (intent.kind === "recall_hint" && (!recallId?.success || !question)) return;
  window.dispatchEvent(new CustomEvent<CompanionNoteIntent>(COMPANION_NOTE_INTENT_EVENT, {
    detail: {
      requestId: crypto.randomUUID(),
      kind: intent.kind,
      noteId: noteId.data,
      noteVersionId: noteVersionId.data,
      noteTitle,
      ...(recallId?.success && question ? { recallId: recallId.data, question } : {}),
    },
  }));
  window.dispatchEvent(new CustomEvent(COMPANION_OPEN_CHAT_EVENT));
}

export function truncateFeedText(text: string): string {
  return text.trim().slice(0, COMPANION_FEED_MAX_CHARS);
}

/** 订阅投喂/开抽屉事件；返回退订函数。 */
export function subscribeCompanionFeed(handlers: {
  onFeed: (selection: CompanionFeedSelection) => void;
  onNoteIntent: (intent: CompanionNoteIntent) => void;
  onOpenChat: () => void;
}): () => void {
  const onFeed = (event: Event) => {
    const detail = (event as CustomEvent<CompanionFeedSelection>).detail;
    if (detail && typeof detail.text === "string" && detail.text.length > 0) {
      handlers.onFeed({
        ...(z.string().uuid().safeParse(detail.requestId).success
          ? { requestId: detail.requestId }
          : {}),
        text: detail.text,
        source: detail.source === "drop" ? "drop" : "selection",
        ...(typeof detail.initialPrompt === "string" && detail.initialPrompt.trim().length > 0
          ? { initialPrompt: detail.initialPrompt.trim().slice(0, 500) }
          : {}),
        ...(detail.noteAnchor && z.string().uuid().safeParse(detail.noteAnchor.noteId).success
          && noteAnnotationAnchorV1Schema.safeParse(detail.noteAnchor.anchor).success
          ? { noteAnchor: {
            noteId: detail.noteAnchor.noteId,
            anchor: noteAnnotationAnchorV1Schema.parse(detail.noteAnchor.anchor),
          } }
          : {}),
      });
    }
  };
  const onOpenChat = () => handlers.onOpenChat();
  const onNoteIntent = (event: Event) => {
    const detail = (event as CustomEvent<CompanionNoteIntent>).detail;
    const noteId = z.string().uuid().safeParse(detail?.noteId);
    const noteVersionId = z.string().uuid().safeParse(detail?.noteVersionId);
    if (!noteId.success || !noteVersionId.success
      || !["overview", "recall", "recall_hint", "expansion"].includes(detail?.kind ?? "")
      || typeof detail?.noteTitle !== "string") return;
    const noteTitle = detail.noteTitle.trim().slice(0, 200);
    if (detail.kind === "recall_hint") {
      const recallId = z.string().uuid().safeParse(detail.recallId);
      const question = typeof detail.question === "string" ? detail.question.trim().slice(0, 500) : "";
      if (!recallId.success || !question) return;
      handlers.onNoteIntent({
        ...(z.string().uuid().safeParse(detail.requestId).success ? { requestId: detail.requestId } : {}),
        kind: "recall_hint",
        noteId: noteId.data,
        noteVersionId: noteVersionId.data,
        noteTitle,
        recallId: recallId.data,
        question,
      });
      return;
    }
    handlers.onNoteIntent({
      ...(z.string().uuid().safeParse(detail.requestId).success ? { requestId: detail.requestId } : {}),
      kind: detail.kind as "overview" | "recall" | "expansion",
      noteId: noteId.data,
      noteVersionId: noteVersionId.data,
      noteTitle,
    });
  };
  window.addEventListener(COMPANION_FEED_EVENT, onFeed);
  window.addEventListener(COMPANION_OPEN_CHAT_EVENT, onOpenChat);
  window.addEventListener(COMPANION_NOTE_INTENT_EVENT, onNoteIntent);
  return () => {
    window.removeEventListener(COMPANION_FEED_EVENT, onFeed);
    window.removeEventListener(COMPANION_OPEN_CHAT_EVENT, onOpenChat);
    window.removeEventListener(COMPANION_NOTE_INTENT_EVENT, onNoteIntent);
  };
}
import { z } from "zod";
import { noteAnnotationAnchorV1Schema, type NoteAnnotationAnchorV1 } from "@ailearn/shared/note-annotation-contracts";
