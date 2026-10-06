import type { ReactNode } from "react";
import type { DesktopSearchItem, DesktopSourceDetail } from "@astella/shared/desktop-surface-contracts";
import type { LearningObjectiveSurfaceV3 } from "@astella/shared/learning-objective-surface-contracts";
import type { NoteDetailV1, NoteBlockProjectionV1 } from "@astella/shared/note-projection-contracts";
import type { SearchTypeFilter } from "../../../app/room-store";
import { createRequestMeta, unwrapGatewayResult } from "../../../app/desktop-client";
import { freshnessLabel } from "../run/objective-state-copy";

export const PAGE_SIZE = 24;
export const TYPE_FILTERS = ["all", "note", "source", "objective"] as const;
export type SearchPreview =
  | { kind: "loading"; key: string }
  | { kind: "note"; key: string; detail: NoteDetailV1 }
  | { kind: "source"; key: string; detail: DesktopSourceDetail }
  | { kind: "objective"; key: string; detail: LearningObjectiveSurfaceV3 }
  | { kind: "error"; key: string; message: string };

export function objectKey(item: Pick<DesktopSearchItem, "objectType" | "objectId">): string {
  return `${item.objectType}:${item.objectId}`;
}

export function typeLabel(objectType: DesktopSearchItem["objectType"]): string {
  switch (objectType) {
    case "note": return "笔记";
    case "source": return "来源";
    case "objective": return "学习卡";
  }
}

export function typeFilterLabel(filter: SearchTypeFilter): string {
  switch (filter) {
    case "all": return "全部类型";
    case "note": return "只看笔记";
    case "source": return "只看来源";
    case "objective": return "只看学习卡";
  }
}

/** The one action the preview offers, named for the record it would open. */
export function openLabel(objectType: DesktopSearchItem["objectType"]): string {
  switch (objectType) {
    case "note": return "打开完整笔记";
    case "source": return "打开这份来源";
    case "objective": return "打开学习卡";
  }
}

/**
 * 这一屏那几句状态字各写一次：JSX 与登记给伴星的可读视图共用同一份。
 * 抄成两处就是两个来源，而**视图字段写错不会红**（只有形状校验那道会喊），
 * 最后只会变成"她说的与屏幕上不是一句"。
 */
export const SEARCH_STATE_LINES = {
  confirmingSession: "正在确认工作区",
  searchingList: "正在搜索",
  sessionUnavailable: "搜索范围暂时不可用",
  listUnavailable: "搜索暂时不可用",
  cannotCheckStates: "暂时无法核对学习卡状态",
} as const;
export const NO_QUERY_EMPTY = {
  message: "输入关键词开始查找",
  detail: "标题、原句里的词都可以找；点选纸签，就能接着读。",
} as const;
export const PREVIEW_EMPTY = {
  message: "点一张纸签，接着读",
  detail: "预览会围绕关键词展开，完整内容随时打开。",
} as const;
/** 空结果有两条不同的说法（普通关键词没命中 vs 证据不足筛没了），两句都必须在屏上。 */
export function noResultEmpty(weakOnly: boolean, query: string, hasMore = false): { readonly message: string; readonly detail: string } {
  return weakOnly
    ? { message: hasMore ? "这一页没有待巩固的学习卡" : "没有待巩固的学习卡", detail: hasMore ? "可以继续查找后面的结果，或关掉“证据不足”。" : "关掉“证据不足”，就能查看全部命中的学习卡。" }
    : { message: `没有找到“${query.trim()}”`, detail: "试试更短的关键词，或看看全部类型。" };
}

/**
 * Highlight the searched phrase in the reading body without repeating the snippet.
 */
export function markQuery(text: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  if (parts.length === 1) return text;
  return parts.map((part, index) => (
    // `split` with a capture group alternates text / match / text / match…
    index % 2 === 1 ? <span className="mark" key={index}>{part}</span> : part
  ));
}

/** The server wraps snippet hits in «…»; the reading page highlights for real, so the markers come off. */
export function stripHighlight(text: string): string {
  return text.replace(/[«»]/g, "");
}

/** Note blocks are stored with light markup; the paper only wants reading text. */
export function displayBlockContent(value: string): string {
  if (!/<\/?[a-z][^>]*>/i.test(value)) return value.trim();
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/?(?:h[1-6]|p|strong|em|ul|ol|li|blockquote|code|pre)\b[^>]*>/gi, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .trim();
}

export function containsQuery(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle.length > 0 && text.toLowerCase().includes(needle);
}

/**
 * The window of paragraphs the reader should see. Taking the first N blocks
 * means a note whose match sits in block 40 previews as six unhighlighted
 * paragraphs while the row claims "匹配 3 处" — so the window follows the match
 * and keeps a little context on both sides.
 */
export function windowAroundMatch(texts: readonly string[], query: string, size: number): string[] {
  if (texts.length <= size) return [...texts];
  const hit = texts.findIndex((text) => containsQuery(text, query));
  if (hit < 0) return texts.slice(0, size);
  const start = Math.max(0, Math.min(hit - Math.floor(size / 2), texts.length - size));
  return texts.slice(start, start + size);
}

export function noteParagraphs(blocks: readonly NoteBlockProjectionV1[], query: string): string[] {
  const readable = blocks
    .filter((block) => block.type === "paragraph" || block.type === "quote" || block.type === "heading")
    .map((block) => displayBlockContent(block.content))
    .filter((text) => text.length > 0);
  return windowAroundMatch(readable, query, 6);
}

export function previewParagraphs(preview: SearchPreview, query: string): string[] {
  if (preview.kind === "note") return noteParagraphs(preview.detail.currentVersion.blocks, query);
  if (preview.kind === "source") {
    const readable = preview.detail.segments
      .map((segment) => segment.text.trim())
      .filter((text) => text.length > 0);
    return windowAroundMatch(readable, query, 5);
  }
  if (preview.kind === "objective") return [preview.detail.content.publicSummary];
  return [];
}

/** The gap note only appears when the server really reports a missing link. */
export function previewGap(preview: SearchPreview): string | null {
  if (preview.kind === "objective") {
    if (preview.detail.sources.missingOrigin) return "这张学习卡还没有出处，结论暂时追不回材料。";
    /**
     * 那两格**状态名一律取 `freshnessLabel` 那一份**，后半句才是搜索这一面自己的话。
     * 同一个服务端值在笔记页说「来源已有更新」、在这里说「来源已经过期」，
     * 是 `objective-state-copy` 这个模块存在时要拦的那一件事（它的注释写的就是这种形状）。
     */
    if (preview.detail.content.freshness === "source_outdated") {
      return `${freshnessLabel(preview.detail.content.freshness)}——这一条要重新核对。`;
    }
    if (preview.detail.content.freshness === "legacy_unreviewed") {
      return `${freshnessLabel(preview.detail.content.freshness)}——这张学习卡的结论需要重新核对。`;
    }
    if (preview.detail.personal.initialValidation?.status === "deferred") return "初次验证被推迟，证据仍待补齐。";
    return null;
  }
  if (preview.kind === "note") {
    if (preview.detail.sourceId === null) return "这篇笔记没有关联来源，可以先阅读自己的记录。";
    if (preview.detail.currentVersion.blocks.length === 0) return "这篇笔记当前版本还没有可读内容。";
    return null;
  }
  if (preview.kind === "source") {
    if (preview.detail.source.status === "failed") return "这份来源解析失败，正文段落可能不完整。";
    if (preview.detail.source.status === "processing") return "这份来源仍在解析，现在读到的是部分内容。";
    if (preview.detail.segments.length === 0) return "这份来源还没有可用正文段落。";
    return null;
  }
  return null;
}


export type SearchContent = Extract<SearchPreview, { kind: "note" | "source" | "objective" }>;
export async function readSearchContent(item: DesktopSearchItem, epoch: number | undefined): Promise<SearchContent> {
  const meta = createRequestMeta(epoch);
  const key = objectKey(item);
  if (item.objectType === "note") {
    const response = await window.astella.note.get({ meta, noteId: item.objectId });
    return { kind: "note", key, detail: unwrapGatewayResult(response) };
  }
  if (item.objectType === "source") {
    const response = await window.astella.source.get({ meta, sourceId: item.objectId });
    return { kind: "source", key, detail: unwrapGatewayResult(response) };
  }
  const response = await window.astella.objective.get({ meta, objectiveId: item.objectId });
  return { kind: "objective", key, detail: unwrapGatewayResult(response) };
}
