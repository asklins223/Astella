/**
 * 伴星会话的**派生逻辑**（2026-09-30 从 `companion-chat-session.tsx` 抽出）。
 *
 * ## 为什么抽
 *
 * 那个文件里原本混着两件毫不相干的事：**Provider**（取数 + 状态机 + 发消息）
 * 与**纯函数**（路由怎么落、文案怎么拼、nav chip 该不该留在消息外面、
 * 两个错误怎么映射成人话）。后者**一个 hook 都没有**，却占了两百多行——
 * 读 Provider 的人要一路滑过去，才知道它其实不碰状态。
 *
 * 判据就是 AGENTS.md 那句「页面组件只做四件事：取数、派生、摆位、接事件」：
 * **派生该有自己的地方。**
 *
 * ## 拆的是位置，不是行为
 *
 * 函数体**一个字没改**。原来靠同文件顶层可见的依赖这里显式 import；
 * 原来在本文件声明的类型从 `companion-chat-session` 取——**单向依赖**，不成环。
 *
 * ## 搬运必须按 AST 区间，不能按行号算术
 *
 * 两次栽在同一个地方：手算「从 JSDoc 起、到下一个顶层声明止」的区间，
 * 一次把 `/**` 留在原文件（新文件从 `* …` 开始 → `Expression expected`），
 * 一次把区间短成只有那段 JSDoc（函数体全留下 → `Cannot redeclare`），
 * **而报错行号离真因几百行**。`node.getStart()` / `node.getEnd()` 不会。
 */

import type { CompanionNavChip } from "./companion-chat-session";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  CharacterCuePayloadV1,
  CompanionContentBlockV1,
  CompanionMessageV1,
  CompanionPageContextV1,
} from "@ailearn/shared/companion-conversation-contracts";
import type {
  CompanionAgentRouteEventV1,
  CompanionChatConversationV1,
  CompanionChatProposalGetResultV1,
} from "@ailearn/shared/companion-chat-desktop-contracts";
import type { DesktopRouteV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type { MainPageContextInputV2, PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import { companionPageRouteV2, SETTINGS_SECTION_IDS_V2 } from "@ailearn/shared/companion-bridge-contracts";
import { useRoomStore } from "./room-store";
import type { HudPageId } from "../components/hud/hud-pages";
import { createRequestMeta, gatewayErrorMessage, requireWorkspaceEpoch, unwrapGatewayResult, RendererGatewayError } from "./desktop-client";
import {
  COMPANION_CONSENT_REQUIRED_LINE,
  SETTINGS_ATTENTION_AI_CONSENT,
  companionConsentGate,
  isCompanionConsentFailure,
} from "./companion-consent-gate";
import { subscribeCompanionFeed, truncateFeedText } from "../components/companion/companion-feed";
import type { CompanionFeedNoteAnchor, CompanionNoteIntent } from "../components/companion/companion-feed";
import {
  appendCompanionAgentNode,
  buildCompanionRunTraces,
  type CompanionAgentNodes,
  type CompanionRunTrace,
} from "./companion-agent-nodes";
export function desktopRouteFromAgentRoute(route: CompanionAgentRouteEventV1["route"]): DesktopRouteV1 | null {
  switch (route.kind) {
    case "settings":
      return route.section
        ? { kind: "settings.section", section: route.section }
        : companionPageRouteV2("settings");
    case "source":
      return route.sourceId
        ? { kind: "source.detail", sourceId: route.sourceId }
        : companionPageRouteV2("source");
    case "note":
      return { kind: "note.detail", noteId: route.noteId };
    case "card":
      return { kind: "objective.detail", objectiveId: route.objectiveId };
    case "learning_run":
      return { kind: "learningRun.detail", runId: route.runId };
    case "home":
    case "today":
    case "note_library":
    case "objective_library":
    case "review":
    case "search":
    case "star_map":
    case "conversation":
      return companionPageRouteV2(route.kind);
    default:
      return null;
  }
}

export function companionMessageText(message: CompanionMessageV1): string {
  return message.blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "code") return block.code;
      if (block.type === "citation") return `[${block.label}]`;
      return "";
    })
    .filter((value) => value.length > 0)
    .join("\n");
}

export async function applyRouteToRoom(route: DesktopRouteV1): Promise<boolean> {
  const room = useRoomStore.getState();
  switch (route.kind) {
    case "room.home":
      room.invoke("home");
      return true;
    case "room.today":
      // 目录栏上「今日学习」那颗用的就是 continue（room-machine 把它解析成 study 页）。
      room.invoke("continue");
      return true;
    case "review.queue":
      room.invoke("review");
      return true;
    case "understanding.graph":
      room.invoke("graph");
      return true;
    case "search.global":
      room.invoke("search");
      return true;
    case "note.library":
      room.invoke("open-notes");
      return true;
    case "objective.library":
      room.invoke("open-objectives");
      return true;
    case "settings.section":
      room.setSettingsSection(route.section);
      room.invoke("open-settings");
      return true;
    case "source.library":
      room.invoke("open-sources");
      return true;
    case "source.detail":
      room.setActiveSourceId(route.sourceId);
      room.invoke("open-source");
      return true;
    case "note.detail":
      // 阅读页只按 noteId 读当前版本（NoteTargetRef 的契约），版本号如实留空。
      room.setActiveNoteRef({ noteId: route.noteId, noteVersionId: null, mode: "preview" });
      room.setNoteReturnTo("library");
      room.invoke("open-notebook");
      return true;
    case "learningRun.detail":
      // 与 ReviewSurface / WorkspaceLibrarySurface 同一条入口：设 activeRunId **并且**
      // 真正切页。只设 id 不会换页（Player 挂在任务视图那一页里，页面由 `invoke` 决定），
      // 于是「前往」成了一次空转：两条 IPC 都成功、无报错、页面纹丝不动。
      room.setActiveRunId(route.runId);
      room.invoke("validate");
      return true;
    case "objective.detail":
      room.setActiveObjectiveId(route.objectiveId);
      room.invoke("open-objective");
      return true;
    case "companion.center":
      room.setCompanionCenterTarget({
        tab: route.tab ?? "memory",
        ...(route.focusMemoryId ? { focusMemoryId: route.focusMemoryId } : {}),
        ...(route.focusMessageId ? { focusMessageId: route.focusMessageId } : {}),
      });
      room.invoke("open-companion-center");
      return true;
    default:
      return false;
  }
}

export function navChipSharesTarget(a: CompanionNavChip, b: CompanionNavChip): boolean {
  return a.summary === b.summary && JSON.stringify(a.route) === JSON.stringify(b.route);
}

export function navChipsStillOutsideMessages(
  chips: readonly CompanionNavChip[],
  messages: readonly CompanionMessageV1[],
): CompanionNavChip[] {
  const landed = new Set<string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === "nav") {
        // 比映射**之后**的桌面路由：chip 存的就是这个形状，映射不到的两边都是 null。
        landed.add(JSON.stringify(desktopRouteFromAgentRoute(block.route)));
      }
    }
  }
  if (landed.size === 0) return [...chips];
  return chips.filter((chip) => !landed.has(JSON.stringify(chip.route)));
}

export async function readCompleteCompanionHistory(
  baseline: number | null,
  loadPage: (beforeSeq: number) => Promise<{
    readonly items: readonly CompanionMessageV1[];
    readonly hasMore: boolean;
    readonly oldestSeq: number | null;
  } | null>,
): Promise<CompanionMessageV1[] | null> {
  const older: CompanionMessageV1[] = [];
  let beforeSeq = baseline;
  try {
    while (beforeSeq != null) {
      const page = await loadPage(beforeSeq);
      if (!page) return null;
      older.push(...page.items);
      if (!page.hasMore) break;
      if (page.oldestSeq == null || page.oldestSeq >= beforeSeq) return null;
      beforeSeq = page.oldestSeq;
    }
  } catch {
    return null;
  }
  return older.sort((a, b) => a.seq - b.seq);
}

export function isCompanionRunConflict(error: unknown): boolean {
  return error instanceof RendererGatewayError && error.code === "conflict";
}

export function companionTurnErrorMessage(error: unknown): string {
  if (isCompanionRunConflict(error)) {
    return "上一条她还没说完，这条没能发出去。等她说完，或者先点停止。";
  }
  return gatewayErrorMessage(error);
}

export function companionReplyFailureMessage(code: unknown, recoverable: unknown): string {
  if (code === "CONTEXT_STALE") return "这一轮引用的记忆已变更或撤回。重新发送，我会按现在的内容继续。";
  if (code === "RATE_LIMITED") return "模型服务暂时繁忙，稍后再试就好。已经做好的内容还在。";
  if (code === "PROVIDER_UNAVAILABLE") return "模型服务暂时不可用，已经做好的内容还在。";
  return recoverable === false ? "这一轮没能完成。重新说一遍就好。" : "这一轮没能完成，可以再试一次。";
}
