import { useRoomStore } from "./room-store";
import type { HudPageId } from "../components/hud/hud-pages";
import type { MainPageContextInputV2, PageReadableV1 } from "@astella/shared/companion-bridge-contracts";
import { companionPageRouteV2, SETTINGS_SECTION_IDS_V2 } from "@astella/shared/companion-bridge-contracts";

export function bridgePageContext(input: {
  hudPage: HudPageId;
  activeRunId: string | null;
  activeNoteId: string | null;
  activeNoteVersionId: string | null;
  activeSourceId: string | null;
  activeReviewScheduleId: string | null;
  settingsSection: string;
  readableView: PageReadableV1 | null;
}): MainPageContextInputV2 {
  // `credential_surface` 这一档**今天没有任何 HUD 页会产生**：`login`／`register` 两个
  // HudPageId 死分支已删除（2026-09-24，39d W2-1——没有任何组件发布它们），而真实的
  // 登录/注册屏由 `DesktopAccessGate` 在 HUD 之外渲染，不经过这条映射。
  // 契约值本身与服务端那道裁剪**保留**（`companion-agent-runtime.ts:710`）：将来出现
  // 应用内凭证面时，它仍是把关的那一层，不该因为今天没人用就一起删掉。
  const sensitivity: MainPageContextInputV2["sensitivity"] = input.hudPage === "assessment"
    ? "formal_assessment" as const
    : "normal" as const;
  const base: Pick<MainPageContextInputV2, "interactionState" | "capabilityHints" | "sensitivity" | "readableView"> = {
    interactionState: input.hudPage === "note-edit"
      ? "editing" as const
      : input.hudPage === "assessment"
        ? "formal_answer" as const
        : input.hudPage === "generating"
          ? "processing" as const
          : "idle" as const,
    capabilityHints: ["open_route"],
    sensitivity,
    // 可读内容原样发出：渲染层已不可能产生 `credential_surface`（见上），真正的裁剪
    // 在服务端按 sensitivity 做（`companion-agent-runtime.ts:710`）——那一层没有动。
    readableView: input.readableView ?? undefined,
  };
  if (input.hudPage === "today") return { ...base, routeRef: { kind: "today" }, pageKind: "today", entityRefs: [] };
  if (input.hudPage === "sources") return { ...base, routeRef: { kind: "source" }, pageKind: "source", entityRefs: [] };
  if (input.hudPage === "source-detail" && input.activeSourceId) {
    return { ...base, routeRef: { kind: "source", sourceId: input.activeSourceId }, pageKind: "source", entityRefs: [{ kind: "source", sourceId: input.activeSourceId }] };
  }
  if (["note-read", "note-edit", "generating", "candidate"].includes(input.hudPage) && input.activeNoteId) {
    return {
      ...base,
      routeRef: { kind: "note", noteId: input.activeNoteId },
      pageKind: "note",
      entityRefs: [{ kind: "note", noteId: input.activeNoteId, ...(input.activeNoteVersionId ? { noteVersionId: input.activeNoteVersionId } : {}) }],
    };
  }
  if (input.hudPage === "queue") {
    return {
      ...base,
      routeRef: { kind: "review", ...(input.activeReviewScheduleId ? { scheduleId: input.activeReviewScheduleId } : {}) },
      pageKind: "review",
      entityRefs: input.activeReviewScheduleId ? [{ kind: "review_schedule", scheduleId: input.activeReviewScheduleId }] : [],
    };
  }
  if (input.hudPage === "graph") {
    return { ...base, routeRef: { kind: "star_map" }, pageKind: "star_map", entityRefs: [], capabilityHints: ["open_route", "graph.focus", "graph.present_route", "graph.restore"] };
  }
  if ((input.hudPage === "assessment" || input.hudPage === "result") && input.activeRunId) {
    return { ...base, routeRef: { kind: "learning_run", runId: input.activeRunId }, pageKind: "learning_run", entityRefs: [{ kind: "learning_run", runId: input.activeRunId }] };
  }
  if (input.hudPage === "companion") return { ...base, routeRef: { kind: "conversation" }, pageKind: "conversation", entityRefs: [] };
  if (input.hudPage === "notes") {
    return { ...base, routeRef: { kind: "note_library" }, pageKind: "note", entityRefs: [] };
  }
  if (input.hudPage === "goals") {
    return { ...base, routeRef: { kind: "objective_library" }, pageKind: "objective", entityRefs: [] };
  }
  if (input.hudPage === "search") {
    return { ...base, routeRef: { kind: "search" }, pageKind: "other", entityRefs: [] };
  }
  if (input.hudPage === "settings") {
    // 分区 id 直接沿用设置页那一套（词表在共享合同里）：以前这里把六个分区压成
    // "privacy"/"accessibility" 两个界面上不存在的名字，她据此说不出你在哪一节。
    const section = SETTINGS_SECTION_IDS_V2.find((id) => id === input.settingsSection);
    return { ...base, routeRef: { kind: "settings", ...(section ? { section } : {}) }, pageKind: "settings", entityRefs: [] };
  }
  return { ...base, routeRef: { kind: "home" }, pageKind: "other", entityRefs: [] };
}
