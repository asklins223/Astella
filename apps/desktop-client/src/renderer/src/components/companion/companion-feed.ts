/**
 * 划选/拖拽投喂的事件总线（2026-09-18，设计文档 §二 切片①③）。
 *
 * 采集侧（右键菜单 / 窗口 drop）通过 window CustomEvent 把选中文本递给
 * CompanionPresence → 聊天抽屉；解耦为事件而不直接 import，避免菜单组件
 * 与伴星树互相依赖。文本上限 2000 字（与 turn 契约一致）。
 */

const COMPANION_FEED_EVENT = "astella:companion-feed";
const COMPANION_OPEN_CHAT_EVENT = "astella:companion-open-chat";
const COMPANION_NOTE_INTENT_EVENT = "astella:companion-note-intent";

export const COMPANION_FEED_MAX_CHARS = 2_000;

export interface CompanionFeedNoteAnchor {
  readonly noteId: string;
  readonly anchor: NoteAnnotationAnchorV1;
  readonly explanationId?: string;
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

/**
 * 日记引用（40 §6 / A08「聊聊这篇」）。
 *
 * 合同原话：「点击只打开对话并附上该篇的明确引用，**不自动发送用户消息**。
 * 引用包含所属空间、日期和版本」。
 *
 * `version` 不是可选的：§5.5 保证已发布成稿不被后台重跑静默替换，所以
 * 「用户看到的那一版」是稳定的；没有版本，伴星就可能拿新版去解释用户看的旧版。
 * 空间不写在这里——它取会话上下文（§11.2：日记默认属于本人）。
 */
export interface CompanionFeedDiaryAnchor {
  readonly date: string;
  readonly version: number;
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
  /** 日记页传来的引用；存在时抽屉会显示它，并且**不会**自动发送。 */
  readonly diaryAnchor?: CompanionFeedDiaryAnchor;
}

export function feedSelectionToCompanion(selection: CompanionFeedSelection): string | null {
  const text = selection.text.trim();
  if (text.length === 0) return null;
  const initialPrompt = selection.initialPrompt?.trim().slice(0, 500);
  const noteId = z.string().uuid().safeParse(selection.noteAnchor?.noteId);
  const anchor = noteAnnotationAnchorV1Schema.safeParse(selection.noteAnchor?.anchor);
  const requestId = crypto.randomUUID();
  const target = noteId.success && anchor.success ? { noteId: noteId.data, anchor: anchor.data } : null;
  const explanation = target && initialPrompt ? beginNoteExplanation(target, requestId) : null;
  if (explanation && explanation.id !== requestId) {
    openNoteExplanation(explanation.id);
    return explanation.id;
  }
  window.dispatchEvent(new CustomEvent<CompanionFeedSelection>(COMPANION_FEED_EVENT, {
    detail: {
      requestId,
      text: text.slice(0, COMPANION_FEED_MAX_CHARS),
      source: selection.source,
      ...(initialPrompt ? { initialPrompt } : {}),
      ...(target ? { noteAnchor: { ...target, ...(explanation ? { explanationId: explanation.id } : {}) } } : {}),
    },
  }));
  window.dispatchEvent(new CustomEvent(COMPANION_OPEN_CHAT_EVENT));
  return explanation?.id ?? null;
}

/**
 * 日记页的次级动作「聊聊这篇」。
 *
 * 刻意**不填** `initialPrompt`：会话里自动发送的条件是
 * `noteAnchor && initialPrompt`（见 companion-chat-session 的 onFeed），
 * 没有它就只有"打开对话 + 附上引用"，用户自己接着打字——
 * 这正是 §6「不自动发送用户消息」的字面要求。
 */
export function feedDiaryReferenceToCompanion(anchor: CompanionFeedDiaryAnchor): void {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(anchor.date) ? anchor.date : null;
  const version = Number.isInteger(anchor.version) && anchor.version >= 1 ? anchor.version : null;
  if (!date || !version) return;
  window.dispatchEvent(new CustomEvent<CompanionFeedSelection>(COMPANION_FEED_EVENT, {
    detail: {
      requestId: crypto.randomUUID(),
      // 正文不进投喂：模型要按 ID 现读，而不是拿一段可能已被重写的副本。
      text: `日记 ${date}（第 ${version} 版）`,
      source: "selection",
      diaryAnchor: { date, version },
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
            ...(z.string().uuid().safeParse(detail.noteAnchor.explanationId).success ? { explanationId: detail.noteAnchor.explanationId } : {}),
          } }
          : {}),
        // 日记引用必须在这里透传，否则「聊聊这篇」只是打开对话：订阅端逐字段
        // 重建 selection，漏掉它下游就再也拿不到日期与版本（§6/A08 要求引用
        // 含空间、日期和版本）。校验规则与 feedDiaryReferenceToCompanion 写出的
        // 形状一致：日期是 YYYY-MM-DD、版本是正整数。
        ...(detail.diaryAnchor
          && /^\d{4}-\d{2}-\d{2}$/.test(String(detail.diaryAnchor.date ?? ""))
          && Number.isInteger(detail.diaryAnchor.version)
          && detail.diaryAnchor.version >= 1
          ? { diaryAnchor: {
            date: String(detail.diaryAnchor.date),
            version: detail.diaryAnchor.version,
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
import { noteAnnotationAnchorV1Schema, type NoteAnnotationAnchorV1 } from "@astella/shared/note-annotation-contracts";
import { beginNoteExplanation, openNoteExplanation } from "./note-companion-explanation";
