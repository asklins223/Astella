import type { CompanionActivityDeliveryV1,CompanionHistoryItemV1,CompanionMemoryItemV1,CompanionMemoryKindV1,CompanionMemoryScopeV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import type { GatewayResultV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { gatewayErrorMessage,unwrapGatewayResult } from "../../../app/desktop-client";

export type Section<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };
export type CompanionCenterTab = "overview" | "dialogue" | "diary" | "memory" | "discovery" | "activity" | "persona";

export const CENTER_PAGES = [
  { id: "overview", label: "近况", detail: "接着上次的话，翻翻新留下的事。" },
  { id: "dialogue", label: "对话", detail: "你们说过的话，可以接着聊，也可以慢慢回看。" },
  { id: "diary", label: "日记", detail: "那些值得写下的共同片段。" },
  { id: "memory", label: "记忆", detail: "看看她记住了什么，随时补充或纠正。" },
  { id: "discovery", label: "发现簿", detail: "把想留下的话收在一起，再写上自己的想法。" },
  { id: "activity", label: "动态", detail: "她留给你的消息、提议与学习进度。" },
  { id: "persona", label: "人格", detail: "认识她，也一起调整她表达自己的方式。" },
] as const satisfies ReadonlyArray<{ id: CompanionCenterTab; label: string; detail: string }>;

export const MEMORY_KIND_LABEL: Record<CompanionMemoryKindV1, string> = {
  preference: "偏好", goal: "目标", learning_context: "学习线索", interaction_note: "互动观察", episodic: "共同经历", judgment: "她的看法",
};
export const MEMORY_SCOPE_LABEL: Record<CompanionMemoryScopeV1, string> = { global: "所有书房", workspace: "这个书房", task: "只在这项任务里" };
export const MEMORY_STATE_LABEL: Record<string, string> = {
  candidate: "待确认", active: "已写入", pinned: "已固定", archived: "已归档", scheduled: "尚未生效", expired: "已过期", linked: "真实关联", orphaned: "关联失效",
};
export const MEMORY_KIND_OPTIONS = Object.entries(MEMORY_KIND_LABEL).map(([value, label]) => ({ value: value as CompanionMemoryKindV1, label }));
export const isCompanionJudgment = (item: { readonly kind: CompanionMemoryKindV1 }) => item.kind === "judgment";
export function memoryState(item: CompanionMemoryItemV1) {
  if (item.archived) return "archived";
  if (item.validUntil && Date.parse(item.validUntil) <= Date.now()) return "expired";
  if (item.candidate) return "candidate";
  if (item.validFrom && Date.parse(item.validFrom) > Date.now()) return "scheduled";
  return item.pinned ? "pinned" : "active";
}
export function messageText(item: CompanionHistoryItemV1) {
  return item.blocks.map(block => block.type === "text" ? block.text : block.type === "code" ? block.code : block.type === "citation" ? block.label : "").filter(Boolean).join("\n");
}
export function isPendingDelivery(item: CompanionActivityDeliveryV1) {
  return !item.expired && ["queued", "delivered", "displayed"].includes(item.state);
}
/** Reading a notification is different from responding to a proposed action. */
export function needsDeliveryResponse(item: CompanionActivityDeliveryV1) {
  return isPendingDelivery(item) && item.kind === "proposal" && item.target.kind === "proposal";
}
export async function readSection<T>(read: () => Promise<GatewayResultV1<T>>): Promise<Section<T>> {
  try { return { ok: true, value: unwrapGatewayResult(await read()) }; }
  catch (error) { return { ok: false, message: gatewayErrorMessage(error) }; }
}
